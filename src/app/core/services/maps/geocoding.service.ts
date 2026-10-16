import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { MapProviderService } from './map-provider.service';
import { AppConfigService } from '../config/app-config.service';
import { AutocompleteResult } from '../../models/maps/route-result.model';
import { catchError, forkJoin, map, Observable, of, timeout } from 'rxjs';

interface ORSFeature {
    properties: {
        label: string;
        name: string;
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
}

@Injectable({
    providedIn: 'root'
})
export class GeocodingService {
    private http = inject(HttpClient);
    private provider = inject(MapProviderService);
    private config = inject(AppConfigService);
    private baseUrl = 'https://api.openrouteservice.org/geocode';
    private mapTilerGeocodeUrl = 'https://api.maptiler.com/geocoding';
    private cache = new Map<string, AutocompleteResult[]>();

    autocomplete(query: string, origin?: {lat:number;lng:number}): Observable<AutocompleteResult[]> {
        origin=this.validOrigin(origin);
        const rawQuery = String(query || '').trim();
        const isPostcodeIntent = this.isLikelyUkPostcode(rawQuery);
        const normalizedQuery = isPostcodeIntent ? this.normalizeUkPostcode(rawQuery) : this.normalizeQuery(query);
        if (!normalizedQuery || normalizedQuery.length < 3) return of([]);

        const countryCode = this.config.currentCountry().code;
        const cacheKey = `autocomplete:${countryCode}:${normalizedQuery}:${isPostcodeIntent ? 'pc' : 'txt'}:${origin ? origin.lat.toFixed(4)+','+origin.lng.toFixed(4) : 'default'}`;

        if (this.cache.has(cacheKey)) return of(this.cache.get(cacheKey)!);

        const requests = isPostcodeIntent
            ? [
                this.openRouteSearch(normalizedQuery, 8, { skipFocusBias: true, includePostcodeLayer: true }),
                this.mapTilerSearch(normalizedQuery, 8, { skipProximity: true })
            ]
            : [
                this.openRouteAutocomplete(normalizedQuery, 8, origin),
                this.openRouteSearch(normalizedQuery, 8, {origin}),
                this.mapTilerSearch(normalizedQuery, 8, {origin})
            ];

        return forkJoin(requests).pipe(
            map((groups) => this.rankResults(
                groups.flat(),
                normalizedQuery,
                isPostcodeIntent, !rawQuery.includes(',')?origin:undefined
            ).slice(0, 8)),
            map(results => {
                if(results.length){if(this.cache.size>=100)this.cache.delete(this.cache.keys().next().value!);this.cache.set(cacheKey,results);}
                return results;
            }),
            catchError(error => {
                console.warn('[GeocodingService] Autocomplete failed:', error);
                return of([]);
            })
        );
    }

    geocodeAddress(query: string, origin?: {lat:number;lng:number}): Observable<AutocompleteResult[]> {
        origin=this.validOrigin(origin);
        const rawQuery = String(query || '').trim();
        const isPostcodeIntent = this.isLikelyUkPostcode(rawQuery);
        const normalizedQuery = isPostcodeIntent ? this.normalizeUkPostcode(rawQuery) : this.normalizeQuery(query);
        if (!normalizedQuery) return of([]);

        const requests = isPostcodeIntent
            ? [
                this.openRouteSearch(normalizedQuery, 5, { skipFocusBias: true, includePostcodeLayer: true }),
                this.mapTilerSearch(normalizedQuery, 5, { skipProximity: true })
            ]
            : [
                this.openRouteSearch(normalizedQuery, 5, {origin}),
                this.mapTilerSearch(normalizedQuery, 5, {origin})
            ];

        return forkJoin(requests).pipe(
            map(groups => this.rankResults(groups.flat(), normalizedQuery, isPostcodeIntent, !rawQuery.includes(',')?origin:undefined).slice(0, 5)),
            catchError(error => {
                console.warn('[GeocodingService] Geocode failed:', error);
                return of([]);
            })
        );
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

    private openRouteAutocomplete(query: string, size: number, origin?:{lat:number;lng:number}): Observable<AutocompleteResult[]> {
        const apiKey = this.provider.getOpenRouteServiceApiKey();

        if (!apiKey) return of([]);

        const params: Record<string, string | number> = {
            api_key: apiKey,
            text: query,
            size,
            layers: 'address,venue,street,locality,neighbourhood'
        };

        this.addOpenRouteBounds(params, false, origin);

        return this.http.get<{ features: ORSFeature[] }>(`${this.baseUrl}/autocomplete`, {
            params
        }).pipe(
            timeout(6000),
            map(res => this.mapOpenRouteFeaturesToResults(res.features)),
            catchError(error => {
                console.warn('[GeocodingService] ORS autocomplete failed:', error);
                return of([]);
            })
        );
    }

    private openRouteSearch(query: string, size: number, options: { skipFocusBias?: boolean; includePostcodeLayer?: boolean; origin?:{lat:number;lng:number} } = {}): Observable<AutocompleteResult[]> {
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

        this.addOpenRouteBounds(params, options.skipFocusBias, options.origin);

        return this.http.get<{ features: ORSFeature[] }>(`${this.baseUrl}/search`, {
            params
        }).pipe(
            timeout(6000),
            map(res => this.mapOpenRouteFeaturesToResults(res.features)),
            catchError(error => {
                console.warn('[GeocodingService] ORS search failed:', error);
                return of([]);
            })
        );
    }

    private mapTilerSearch(query: string, limit: number, options: { skipProximity?: boolean; origin?:{lat:number;lng:number} } = {}): Observable<AutocompleteResult[]> {
        const apiKey = this.provider.getMapTilerApiKey();

        if (!apiKey) return of([]);

        const country = this.config.currentCountry();
        const encodedQuery = encodeURIComponent(query);

        const params: Record<string, string | number> = {
            key: apiKey,
            limit,
            language: 'en',
            country: country.code.toLowerCase(),
            types: !options.skipProximity && this.isPlaceQuery(query)?'poi':'poi,address,place',
            fuzzyMatch: 'true'
        };

        if (!options.skipProximity) {
            params['proximity'] = `${options.origin?.lng ?? country.defaultCenter.lng},${options.origin?.lat ?? country.defaultCenter.lat}`;
        }

        return this.http.get<{ features: MapTilerFeature[] }>(`${this.mapTilerGeocodeUrl}/${encodedQuery}.json`, {
            params
        }).pipe(
            timeout(6000),
            map(res => this.mapMapTilerFeaturesToResults(res.features)),
            catchError(() => {
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

    private addOpenRouteBounds(params: Record<string, string | number>, skipFocusBias = false, origin?:{lat:number;lng:number}): void {
        const country = this.config.currentCountry();

        if (country.code) {
            params['boundary.country'] = country.code;
        }

        if (skipFocusBias) return;

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
                    postalCode: this.extractPostcodeFromLabel(label) || undefined
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
                    postalCode: this.extractPostcodeFromLabel(label) || undefined
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
        const labelledResults = results.map(result => this.preserveTypedHouseNumber(result, query));
        const seen = new Set<string>();
        const deduped = labelledResults.filter(result => {
            const key = `${this.normaliseForScore(result.label)}:${result.lat.toFixed(5)}:${result.lng.toFixed(5)}`;

            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });

        const placeQuery=!isPostcodeIntent && this.isPlaceQuery(query);
        const wanted=this.placeTokens(query);
        const matches=(result:AutocompleteResult)=>{
            const words=this.normaliseForScore(result.primaryText || result.label.split(',')[0]).split(' ');
            const labelWords=this.normaliseForScore(result.label).split(' ');
            return 2*wanted.filter(token=>words.some(word=>this.placeWordMatches(token,word))).length+wanted.filter(token=>labelWords.some(word=>this.placeWordMatches(token,word))).length;
        };
        const relevant=placeQuery && wanted.length?deduped.filter(result=>matches(result)>0):deduped;
        return relevant.sort((a,b)=>{
            if(placeQuery && wanted.length){const relevance=matches(b)-matches(a);if(relevance)return relevance;}
            if(!placeQuery){const score=this.scoreResult(b,query,isPostcodeIntent)-this.scoreResult(a,query,isPostcodeIntent);if(score)return score;}
            if(origin && !isPostcodeIntent){const proximity=this.distanceKm(origin,a)-this.distanceKm(origin,b);if(Math.abs(proximity)>.05)return proximity;}
            return this.scoreResult(b,query,isPostcodeIntent)-this.scoreResult(a,query,isPostcodeIntent);
        });
    }

    private validOrigin(origin?:{lat:number;lng:number}):{lat:number;lng:number}|undefined {
        return origin && Number.isFinite(origin.lat) && Number.isFinite(origin.lng) && Math.abs(origin.lat)<=90 && Math.abs(origin.lng)<=180?origin:undefined;
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

    private preserveTypedHouseNumber(result: AutocompleteResult, query: string): AutocompleteResult {
        const typedLine = this.firstAddressLine(query);
        const houseNumber = typedLine.match(/^(\d+[a-z]?)\s+/i)?.[1];

        if (!houseNumber) return result;

        const typedStreet = typedLine.replace(/^(\d+[a-z]?)\s+/i, '').trim();

        if (!typedStreet) return result;

        const normalizedLabel = this.normaliseForScore(result.label);
        const normalizedStreet = this.normaliseForScore(typedStreet);
        const normalizedNumber = this.normaliseForScore(houseNumber);

        if (!normalizedLabel.includes(normalizedStreet) || normalizedLabel.includes(normalizedNumber)) {
            return result;
        }

        const labelParts = result.label.split(',').map(part => part.trim()).filter(Boolean);
        const remainingParts = this.normaliseForScore(labelParts[0] || '') === normalizedStreet
            ? labelParts.slice(1)
            : labelParts;
        const formattedLine = this.toTitleCase(typedLine);

        return {
            ...result,
            label: [formattedLine, ...remainingParts].join(', ')
        };
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
