import { localPlacePlan, LocalSearchOptions, PlaceSearchPlan, placeCategory, categoryMatch, searchBoundingBox, searchDistanceKm } from '../../../shared/utils/local-place-search';
import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { MapProviderService } from './map-provider.service';
import { AppConfigService } from '../config/app-config.service';
import { AutocompleteResult } from '../../models/maps/route-result.model';
import { catchError, forkJoin, map, Observable, of, timeout, throwError, defer, switchMap, finalize, shareReplay } from 'rxjs';

interface ORSFeature {
    properties: {
        label: string;
        name: string;
        layer?:string;
        postalcode?:string;
        category?:string[];
        addendum?:any;
    };
    geometry: {
        coordinates: [number, number];
    };
}

interface MapTilerFeature {
    place_name?: string;
    text?: string;
    center?: [number, number];
    geometry?: {
        coordinates?: [number, number];
    };
    relevance?: number;
    place_type?:string[];
    context?:{id?:string;text?:string}[];
    properties?:{kind?:string;categories?:string[];feature_tags?:Record<string,string>};
}

@Injectable({
    providedIn: 'root'
})
export class GeocodingService {
    private http = inject(HttpClient);
    private provider = inject(MapProviderService);
    private config = inject(AppConfigService);
    private baseUrl = 'https://api.heigit.org/pelias/v1';
    private mapTilerGeocodeUrl = 'https://api.maptiler.com/geocoding';
    private cache = new Map<string, AutocompleteResult[]>();

    private mapTilerBlockedUntil = 0;
    private mapTilerPending = new Map<string, Observable<AutocompleteResult[]>>();
    private mapTilerRecent = new Map<string, {until:number;results:AutocompleteResult[]}>();

    autocomplete(query:string,origin?:{lat:number;lng:number},options:LocalSearchOptions={}):Observable<AutocompleteResult[]>{
        return this.searchPlaces(query,origin,options,true);
    }
    geocodeAddress(query:string,origin?:{lat:number;lng:number},options:LocalSearchOptions={}):Observable<AutocompleteResult[]>{
        return this.searchPlaces(query,origin,options,false);
    }
    searchPlan(query:string,origin?:{lat:number;lng:number},options:LocalSearchOptions={}):PlaceSearchPlan{
        return localPlacePlan(query,origin,options.scope,this.isPostalSearch(query));
    }
    private searchPlaces(query:string,origin:{lat:number;lng:number}|undefined,options:LocalSearchOptions,autocomplete:boolean):Observable<AutocompleteResult[]>{
        return defer(()=>{
            const plan=this.searchPlan(query,origin,options);
            if(plan.needsLocation)return options.strict?throwError(()=>Object.assign(new Error('Set your current location or choose an address before searching nearby.'),{code:'location_required'})):of([]);
            const rawQuery=plan.query,postcode=this.isPostalSearch(rawQuery);
            const normalized=postcode?this.normalizeUkPostcode(rawQuery):this.normalizeQuery(rawQuery);
            if(!normalized || (autocomplete && normalized.length<3))return of([]);
            if(options.additionalListings)return this.additionalPlaceSearch(normalized,plan,postcode,options);
            if(this.provider.getMapTilerApiKey())return this.preferredMapTilerSearch(normalized,plan,postcode,options,autocomplete);
            const key=JSON.stringify([this.config.currentCountry().code,normalized,plan.origin,plan.radiusKm,autocomplete]);
            if(autocomplete && this.cache.has(key))return of(this.cache.get(key)!);
            const ors=!!this.provider.getOpenRouteServiceApiKey(),tiler=!!this.provider.getMapTilerApiKey();
            const expected=(ors?(autocomplete&&!postcode?2:1):0)+(tiler?1:0);
            let failures=0;const onFailure=()=>{failures++;};
            const providerOptions={origin:plan.origin,plan,onFailure,skipFocusBias:postcode,includePostcodeLayer:postcode,skipProximity:postcode};
            const requests:Observable<AutocompleteResult[]>[]=[];
            if(ors){if(autocomplete&&!postcode)requests.push(this.openRouteAutocomplete(normalized,10,plan.origin,providerOptions));requests.push(this.openRouteSearch(normalized,10,providerOptions));}
            if(tiler)requests.push(this.mapTilerSearch(normalized,10,providerOptions));
            if(!expected)return options.strict?throwError(()=>Object.assign(new Error('Place search is temporarily unavailable. Please retry.'),{code:'provider_unavailable'})):of([]);
            return forkJoin(requests).pipe(map(groups=>{
                if(options.strict && failures===expected)throw Object.assign(new Error('Place search is temporarily unavailable. Please retry.'),{code:'provider_unavailable'});
                const bounded=groups.flat().filter(result=>!plan.radiusKm||!plan.origin||searchDistanceKm(plan.origin,result)<=plan.radiusKm);
                const results=this.rankResults(bounded,normalized,postcode,!rawQuery.includes(',')?plan.origin:undefined).slice(0,autocomplete?8:5).map(result=>({...result,...(plan.origin?{distanceKm:searchDistanceKm(plan.origin,result)}:{})}));
                if(autocomplete&&results.length){if(this.cache.size>=100)this.cache.delete(this.cache.keys().next().value!);this.cache.set(key,results);}
                return results;
            }));
        });
    }

    /** MapTiler is the configured search provider. ORS remains available for routing
     * and installations without a MapTiler key; it is not called on every keystroke. */
    private preferredMapTilerSearch(query:string,plan:PlaceSearchPlan,postcode:boolean,options:LocalSearchOptions,autocomplete:boolean):Observable<AutocompleteResult[]>{
        const key=JSON.stringify([this.config.currentCountry().code,query,plan.origin,plan.radiusKm,autocomplete,!!options.strict]);
        const cached=this.mapTilerRecent.get(key);
        if(cached && cached.until>Date.now())return of(cached.results);
        this.mapTilerRecent.delete(key);
        if(this.mapTilerBlockedUntil>Date.now())return options.strict?throwError(()=>Object.assign(new Error('Place search is temporarily unavailable. Please retry shortly or select a point on the map.'),{code:'provider_unavailable'})):of([]);
        const pending=this.mapTilerPending.get(key);
        if(pending)return pending;
        // Category words can swamp a name search in MapTiler. Keep the original
        // query for validation/ranking and use the distinctive terms on one retry.
        const category=placeCategory(query);
        const first=category?.qualifier && plan.radiusKm?category.qualifier:query;
        const distinctive=!postcode && this.isPlaceQuery(query) && !category && plan.radiusKm
            ?this.placeTokens(query).join(' '):'';
        let failed=false;
        const request=(text:string)=>this.mapTilerSearch(text,10,{
            origin:plan.origin,plan,skipProximity:postcode,onFailure:()=>{failed=true;}
        });
        const filter=(results:AutocompleteResult[])=>this.rankResults(
            results.filter(result=>!plan.radiusKm || !plan.origin || searchDistanceKm(plan.origin,result)<=plan.radiusKm),
            query,postcode,!query.includes(',')?plan.origin:undefined
        );
        const work=request(first).pipe(
            map(filter),
            switchMap(results=>!failed && !results.length && distinctive && distinctive.toLowerCase()!==first.toLowerCase()
                ?request(distinctive).pipe(map(filter)):of(results)),
            map(results=>{
                if(failed && !results.length && options.strict)throw Object.assign(new Error('Place search is temporarily unavailable. Please retry.'),{code:'provider_unavailable'});
                const selected=results.slice(0,autocomplete?8:5).map(result=>({...result,...(plan.origin?{distanceKm:searchDistanceKm(plan.origin,result)}:{})}));
                if(selected.length){
                    if(this.mapTilerRecent.size>=100)this.mapTilerRecent.delete(this.mapTilerRecent.keys().next().value!);
                    this.mapTilerRecent.set(key,{until:Date.now()+60_000,results:selected});
                }
                return selected;
            }),
            finalize(()=>this.mapTilerPending.delete(key)),
            shareReplay({bufferSize:1,refCount:true})
        );
        this.mapTilerPending.set(key,work);
        return work;
    }

    /** Explicit customer request: never spend the second provider's allowance
     * on each keystroke, and never widen the selected local search area. */
    private additionalPlaceSearch(query:string,plan:PlaceSearchPlan,postcode:boolean,options:LocalSearchOptions):Observable<AutocompleteResult[]>{
        if(postcode || !plan.localPlace || !plan.radiusKm || !plan.origin || !this.provider.getOpenRouteServiceApiKey())return of([]);
        const key=JSON.stringify(['additional',this.config.currentCountry().code,query,plan.origin,plan.radiusKm,!!options.strict]);
        const cached=this.mapTilerRecent.get(key);
        if(cached && cached.until>Date.now())return of(cached.results);
        this.mapTilerRecent.delete(key);
        const pending=this.mapTilerPending.get(key);if(pending)return pending;
        let failed=false;
        const work=this.openRouteSearch(query,40,{origin:plan.origin,plan,onFailure:()=>{failed=true;}}).pipe(
            map(results=>{
                if(failed && options.strict)throw Object.assign(new Error('Additional listings are temporarily unavailable. Try a full address.'),{code:'provider_unavailable'});
                const selected=this.rankResults(results.filter(result=>searchDistanceKm(plan.origin!,result)<=plan.radiusKm!),query,false,plan.origin).slice(0,8).map(result=>({...result,distanceKm:searchDistanceKm(plan.origin!,result)}));
                if(selected.length){if(this.mapTilerRecent.size>=100)this.mapTilerRecent.delete(this.mapTilerRecent.keys().next().value!);this.mapTilerRecent.set(key,{until:Date.now()+60_000,results:selected});}
                return selected;
            }),finalize(()=>this.mapTilerPending.delete(key)),shareReplay({bufferSize:1,refCount:true})
        );
        this.mapTilerPending.set(key,work);return work;
    }

    private isPostalSearch(query:string):boolean {
        if(this.isLikelyUkPostcode(query))return true;
        const code=this.config.currentCountry().code.toUpperCase();
        const value=String(query || '').trim().split(',').at(-1)!.trim();
        if(/^\d{4,10}(?:[- ]\d{3,4})?$/.test(value))return true;
        if(code==='CA' && /^[A-Z]\d[A-Z]\s?\d[A-Z]\d$/i.test(value))return true;
        if(code==='NL' && /^\d{4}\s?[A-Z]{2}$/i.test(value))return true;
        if(code==='IE' && /^[A-Z][A-Z0-9]{2}\s?[A-Z0-9]{4}$/i.test(value))return true;
        return code==='GB' && this.isLikelyUkPostcode(value);
    }

    /** Returns true when the raw input looks like a full or partial UK postcode (e.g. "OL1 4AW", "OL1", "OL14AW"). */
    isLikelyUkPostcode(value: string): boolean {
        if (this.config.currentCountry().code !== 'GB') return false;
        return this.isFullUkPostcode(value) || this.isUkPostcodeDistrict(value);
    }

    /** Normalises a raw UK postcode-like string into canonical "OUTWARD INWARD" form, or a cleaned district for partial input. */
    normalizeUkPostcode(value: string): string {
        const match = this.matchUkPostcode(value);
        if (match) return `${match.outward} ${match.inward}`;

        const compact = this.compactUkPostcode(value);
        if (this.isUkPostcodeDistrict(compact)) return compact;

        return String(value || '').trim();
    }

    private compactUkPostcode(value: string): string {
        return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').trim();
    }

    private matchUkPostcode(value: string): { outward: string; inward: string } | null {
        const compact = this.compactUkPostcode(value);
        const match = compact.match(/^([A-Z]{1,2}\d[A-Z\d]?)(\d[A-Z]{2})$/);
        if (!match) return null;
        return { outward: match[1], inward: match[2] };
    }

    private isFullUkPostcode(value: string): boolean {
        return !!this.matchUkPostcode(value);
    }

    private isUkPostcodeDistrict(value: string): boolean {
        const compact = this.compactUkPostcode(value);
        if (!compact || compact.length > 5) return false;
        return /^[A-Z]{1,2}\d[A-Z\d]?\d?$/.test(compact);
    }

    private ukPostcodeOutward(value: string): string {
        const compact = this.compactUkPostcode(value);
        return compact.match(/^[A-Z]{1,2}\d[A-Z\d]?/)?.[0] || '';
    }

    private extractPostcodeFromLabel(label: string): string | null {
        const match = String(label || '').match(/\b([A-Za-z]{1,2}\d[A-Za-z\d]?)\s*(\d[A-Za-z]{2})\b/);
        if (!match) return null;
        return `${match[1].toUpperCase()} ${match[2].toUpperCase()}`;
    }

    private openRouteAutocomplete(query: string, size: number, origin?:{lat:number;lng:number}, options:{plan?:PlaceSearchPlan;onFailure?:()=>void}={}): Observable<AutocompleteResult[]> {
        const apiKey = this.provider.getOpenRouteServiceApiKey();

        if (!apiKey) return of([]);

        const params: Record<string, string | number> = {
            api_key: apiKey,
            text: query,
            size,
            layers: 'address,venue,street,locality,neighbourhood'
        };

        this.addOpenRouteBounds(params, false, origin,options.plan);

        return this.http.get<{ features: ORSFeature[] }>(`${this.baseUrl}/autocomplete`, {
            params
        }).pipe(
            timeout(6000),
            map(res => this.mapOpenRouteFeaturesToResults(res.features)),
            catchError(error => {
                options.onFailure?.();
                console.warn('[GeocodingService] ORS autocomplete unavailable');
                return of([]);
            })
        );
    }

    private openRouteSearch(query: string, size: number, options: { skipFocusBias?: boolean; includePostcodeLayer?: boolean; origin?:{lat:number;lng:number};plan?:PlaceSearchPlan;onFailure?:()=>void } = {}): Observable<AutocompleteResult[]> {
        const apiKey = this.provider.getOpenRouteServiceApiKey();
        if (!apiKey) return of([]);

        const params: Record<string, string | number> = {
            api_key: apiKey,
            text: query,
            size,
            layers: options.includePostcodeLayer
                ? 'address,venue,street,locality,neighbourhood,postalcode'
                : this.isPlaceQuery(query)?'venue':'address,venue,street,locality,neighbourhood'
        };

        this.addOpenRouteBounds(params, options.skipFocusBias, options.origin,options.plan);

        return this.http.get<{ features: ORSFeature[] }>(`${this.baseUrl}/search`, {
            params
        }).pipe(
            timeout(6000),
            map(res => this.mapOpenRouteFeaturesToResults(res.features)),
            catchError(error => {
                options.onFailure?.();
                console.warn('[GeocodingService] ORS search unavailable');
                return of([]);
            })
        );
    }

    private mapTilerSearch(query: string, limit: number, options: { skipProximity?: boolean; origin?:{lat:number;lng:number};plan?:PlaceSearchPlan;onFailure?:()=>void } = {}): Observable<AutocompleteResult[]> {
        const apiKey = this.provider.getMapTilerApiKey();

        if (!apiKey) return of([]);

        const country = this.config.currentCountry();
        const encodedQuery = encodeURIComponent(query);

        const params: Record<string, string | number> = {
            key: apiKey,
            limit,
            language: 'en',
            country: country.code.toLowerCase(),
            types: options.skipProximity?'postal_code,address,place':this.isPlaceQuery(query)?'poi':'poi,address,place',
            autocomplete: 'true',
            fuzzyMatch: 'true'
        };

        if (!options.skipProximity) {
            params['proximity'] = `${options.origin?.lng ?? country.defaultCenter.lng},${options.origin?.lat ?? country.defaultCenter.lat}`;
        }

        if(options.plan?.radiusKm && options.plan.origin){const bbox=searchBoundingBox(options.plan.origin,options.plan.radiusKm);if(bbox)params['bbox']=bbox.join(',');}
        return this.http.get<{ features: MapTilerFeature[] }>(`${this.mapTilerGeocodeUrl}/${encodedQuery}.json`, {
            params
        }).pipe(
            timeout(6000),
            map(res => this.mapMapTilerFeaturesToResults(res.features)),
            catchError(error => {
                if(error?.status===403 || error?.status===429)this.mapTilerBlockedUntil=Date.now()+60_000;
                options.onFailure?.();
                return of([]);
            })
        );
    }

    reverseGeocode(lat: number, lng: number): Observable<string> {
        const apiKey = this.provider.getOpenRouteServiceApiKey();
        if (!apiKey) return of('');

        return this.http.get<{ features: ORSFeature[] }>(`${this.baseUrl}/reverse`, {
            params: {
                api_key: apiKey,
                'point.lat': lat,
                'point.lon': lng,
                size: 1,
                layers: 'address,venue,street,locality'
            }
        }).pipe(
            map(res => res.features?.[0]?.properties?.label || ''),
            catchError(error => {
                console.warn('[GeocodingService] Reverse geocode failed:', error);
                return of('');
            })
        );
    }

    private addOpenRouteBounds(params: Record<string, string | number>, skipFocusBias = false, origin?:{lat:number;lng:number},plan?:PlaceSearchPlan): void {
        const country = this.config.currentCountry();

        if (country.code) {
            params['boundary.country'] = country.code;
        }

        if (skipFocusBias) return;
        if(plan?.radiusKm && plan.origin){params['boundary.circle.lat']=plan.origin.lat;params['boundary.circle.lon']=plan.origin.lng;params['boundary.circle.radius']=plan.radiusKm;}

        params['focus.point.lat'] = origin?.lat ?? country.defaultCenter.lat;
        params['focus.point.lon'] = origin?.lng ?? country.defaultCenter.lng;
    }

    private normalizeQuery(query: string): string {
        const trimmed = this.normalizePlaceIntent(String(query || ''))
            .replace(/\s+/g, ' ')
            .replace(/\s*,\s*/g, ', ')
            .trim();

        if (!trimmed) return '';

        return trimmed;
    }

    private normalizePlaceIntent(query: string): string {
        let value = String(query || '').trim();

        value = value
            .replace(/\b(near|nearby|close to|around)\s+me\b/gi, '')
            .replace(/\bnear\s+here\b/gi, '')
            .replace(/\bnearby\b/gi, '')
            .replace(/\s+/g, ' ')
            .trim();

        value = value.replace(/\bnear\s+([^,]+)$/i, (_match, place: string) => {
            const cleanPlace = String(place || '').trim();
            return cleanPlace ? `, ${cleanPlace}` : '';
        });

        return value
            .replace(/\s*,\s*/g, ', ')
            .replace(/^,\s*/, '')
            .replace(/,\s*$/, '')
            .trim();
    }

    private mapOpenRouteFeaturesToResults(features: ORSFeature[]): AutocompleteResult[] {
        if (!features) return [];

        return features
            .filter(f => !!f?.geometry?.coordinates && f.geometry.coordinates.length >= 2)
            .map(f => {
                const name=f.properties?.name || '';
                const supplied=f.properties?.label || name || 'Selected Location';
                const label=name && !this.normaliseForScore(supplied).includes(this.normaliseForScore(name))?`${name}, ${supplied}`:supplied;
                return {
                    label,
                    lat: Number(f.geometry.coordinates[1]),
                    lng: Number(f.geometry.coordinates[0]),
                    ...this.splitLabelForDisplay(label),
                    ...(name?{primaryText:name}:{}),
                    placeType:f.properties?.layer,
                    categories:Array.isArray(f.properties?.category)?f.properties.category:[],
                    placeTags:f.properties?.addendum?.osm || {},
                    postalCode:f.properties?.postalcode || this.extractPostcodeFromLabel(label) || undefined
                };
            })
            .filter(result =>
                Number.isFinite(result.lat) &&
                Number.isFinite(result.lng) && Math.abs(result.lat)<=90 && Math.abs(result.lng)<=180
            );
    }

    private mapMapTilerFeaturesToResults(features: MapTilerFeature[]): AutocompleteResult[] {
        if (!features) return [];

        return features
            .map(feature => {
                const coordinates = feature.center || feature.geometry?.coordinates;
                const name=feature.text || '';
                const supplied=feature.place_name || name || 'Selected Location';
                const label=name && !this.normaliseForScore(supplied).includes(this.normaliseForScore(name))?`${name}, ${supplied}`:supplied;

                return {
                    label,
                    lat: Number(coordinates?.[1]),
                    lng: Number(coordinates?.[0]),
                    ...this.splitLabelForDisplay(label),
                    ...(name?{primaryText:name}:{}),
                    placeType:feature.place_type?.[0] || feature.properties?.kind,
                    categories:feature.properties?.categories || [],
                    placeTags:feature.properties?.feature_tags || {},
                    postalCode:feature.context?.find(context=>context.id?.startsWith('postal_code.'))?.text || this.extractPostcodeFromLabel(label) || undefined
                };
            })
            .filter(result =>
                !!result.label &&
                Number.isFinite(result.lat) &&
                Number.isFinite(result.lng) && Math.abs(result.lat)<=90 && Math.abs(result.lng)<=180
            );
    }

    /** Splits a "Street, City, Region, Country" style label into a primary (first line) and secondary (remainder) display line. */
    private splitLabelForDisplay(label: string): { primaryText: string; secondaryText: string } {
        const parts = String(label || '').split(',').map(part => part.trim()).filter(Boolean);

        if (parts.length === 0) return { primaryText: label || '', secondaryText: '' };
        if (parts.length === 1) return { primaryText: parts[0], secondaryText: '' };

        return {
            primaryText: parts[0],
            secondaryText: parts.slice(1).join(', ')
        };
    }

    private rankResults(results: AutocompleteResult[], query: string, isPostcodeIntent = false, origin?:{lat:number;lng:number}): AutocompleteResult[] {
        const requestedNumber=this.firstAddressLine(query).match(/^(\d+[a-z]?)\s+/i)?.[1]?.toLowerCase();
        const labelledResults=results.filter(result=>{
            if(!requestedNumber)return true;
            const number=result.label.split(',')[0].trim().match(/^(\d+[a-z]?)\s+/i)?.[1]?.toLowerCase();
            return !number || number===requestedNumber;
        });
        const seen=new Map<string,AutocompleteResult>();
        for(const result of labelledResults){
            const key=`${this.normaliseForScore(result.primaryText || result.label.split(',')[0])}:${result.lat.toFixed(5)}:${result.lng.toFixed(5)}`;
            const previous=seen.get(key);
            if(previous){
                previous.categories=[...new Set([...(previous.categories || []),...(result.categories || [])])];
                previous.placeTags={...(previous.placeTags || {}),...(result.placeTags || {})};
                if(result.label.length>previous.label.length){previous.label=result.label;previous.secondaryText=result.secondaryText;}
            }else seen.set(key,{...result});
        }
        const deduped=[...seen.values()];

        const placeQuery=!isPostcodeIntent && this.isPlaceQuery(query);
        const wanted=this.placeTokens(query);
        const category=placeCategory(query);
        const matches=(result:AutocompleteResult)=>{
            const words=this.normaliseForScore(result.primaryText || result.label.split(',')[0]).split(' ');
            const labelWords=this.normaliseForScore(result.label).split(' ');
            return 2*wanted.filter(token=>words.some(word=>this.placeWordMatches(token,word))).length+wanted.filter(token=>labelWords.some(word=>this.placeWordMatches(token,word))).length;
        };
        const relevant=category?deduped.filter(result=>categoryMatch(category,result)):placeQuery && wanted.length?deduped.filter(result=>matches(result)>0):deduped;
        return relevant.sort((a,b)=>{
            if(placeQuery && wanted.length && !category){const relevance=matches(b)-matches(a);if(relevance)return relevance;}
            if(!placeQuery){const score=this.scoreResult(b,query,isPostcodeIntent)-this.scoreResult(a,query,isPostcodeIntent);if(score)return score;}
            if(origin && !isPostcodeIntent){const proximity=this.distanceKm(origin,a)-this.distanceKm(origin,b);if(Math.abs(proximity)>.05)return proximity;}
            return this.scoreResult(b,query,isPostcodeIntent)-this.scoreResult(a,query,isPostcodeIntent);
        });
    }

    private isPlaceQuery(query:string):boolean {
        const value=this.firstAddressLine(query);
        return !/^\d/.test(value) && !/\b(street|road|avenue|lane|drive|close|way|walk|crescent|postcode|st|rd|ave|blvd)\b/i.test(value);
    }
    private placeTokens(query:string):string[] {
        const words=this.normaliseForScore(this.firstAddressLine(query)).split(' ').filter(Boolean);
        const generic=new Set(['restaurant','cafe','shop','store','hospital','hotel','school','the','and']);
        return words.filter(word=>!generic.has(word));
    }
    private placeWordMatches(query:string,word:string):boolean {
        if(word.startsWith(query)||query===word)return true;
        if(query.length<5||Math.abs(query.length-word.length)>1)return false;
        let a=0,b=0,differences=0;
        while(a<query.length && b<word.length){if(query[a]===word[b]){a++;b++;continue;}if(++differences>1)return false;if(query.length>=word.length)a++;if(word.length>=query.length)b++;}
        return differences+(query.length-a)+(word.length-b)<=1;
    }
    private distanceKm(origin:{lat:number;lng:number},point:{lat:number;lng:number}):number {
        const rad=Math.PI/180,dLat=(point.lat-origin.lat)*rad,dLng=(point.lng-origin.lng)*rad;
        const a=Math.sin(dLat/2)**2+Math.cos(origin.lat*rad)*Math.cos(point.lat*rad)*Math.sin(dLng/2)**2;
        return 6371*2*Math.atan2(Math.sqrt(a),Math.sqrt(Math.max(0,1-a)));
    }

    private scoreResult(result: AutocompleteResult, query: string, isPostcodeIntent = false): number {
        const label = this.normaliseForScore(result.label);
        const cleanQuery = this.normaliseForScore(query.replace(new RegExp(`,?\\s*${this.config.currentCountry().name}$`, 'i'), ''));
        const queryTokens = cleanQuery.split(' ').filter(Boolean);
        const numberTokens = queryTokens.filter(token => /^\d+[a-z]?$/.test(token));
        let score = 0;

        if (label.startsWith(cleanQuery)) score += 80;
        if (label.includes(cleanQuery)) score += 45;

        for (const token of queryTokens) {
            if (label.includes(token)) score += /^\d+[a-z]?$/.test(token) ? 18 : 6;
        }

        if (numberTokens.length && numberTokens.every(token => label.includes(token))) score += 35;
        if (label.includes('united kingdom') || label.includes('united states') || label.includes('nigeria')) score += 5;

        if (isPostcodeIntent) {
            const resultPostcode = result.postalCode || this.extractPostcodeFromLabel(result.label);

            if (resultPostcode) {
                const resultCompact = this.compactUkPostcode(resultPostcode);
                const queryCompact = this.compactUkPostcode(query);

                if (resultCompact === queryCompact) {
                    score += 250;
                } else {
                    const resultOutward = this.ukPostcodeOutward(resultPostcode);
                    const queryOutward = this.ukPostcodeOutward(query);

                    if (resultOutward && resultOutward === queryOutward) score += 90;
                }
            }
        }

        return score;
    }

    private normaliseForScore(value: string): string {
        return String(value || '')
            .toLowerCase()
            .replace(/[^\p{L}\p{N}\s]/gu, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    private firstAddressLine(value: string): string {
        const country = this.config.currentCountry();

        return String(value || '')
            .replace(new RegExp(`,?\\s*${country.name}$`, 'i'), '')
            .split(',')[0]
            .replace(/\s+/g, ' ')
            .trim();
    }

    private toTitleCase(value: string): string {
        return value
            .toLowerCase()
            .replace(/\b(\p{L}|\p{N})/gu, match => match.toUpperCase());
    }
}
