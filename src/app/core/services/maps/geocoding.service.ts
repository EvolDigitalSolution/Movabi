import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { MapProviderService } from './map-provider.service';
import { AppConfigService } from '../config/app-config.service';
import { AutocompleteResult } from '../../models/maps/route-result.model';
import { catchError, forkJoin, map, Observable, of } from 'rxjs';

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

    autocomplete(query: string): Observable<AutocompleteResult[]> {
        const rawQuery = String(query || '').trim();
        const isPostcodeIntent = this.isLikelyUkPostcode(rawQuery);
        const normalizedQuery = isPostcodeIntent ? this.normalizeUkPostcode(rawQuery) : this.normalizeQuery(query);
        if (!normalizedQuery || normalizedQuery.length < 3) return of([]);

        const countryCode = this.config.currentCountry().code;
        const cacheKey = `autocomplete:${countryCode}:${normalizedQuery}:${isPostcodeIntent ? 'pc' : 'txt'}`;

        if (this.cache.has(cacheKey)) return of(this.cache.get(cacheKey)!);

        const requests = isPostcodeIntent
            ? [
                this.openRouteSearch(normalizedQuery, 8, { skipFocusBias: true, includePostcodeLayer: true }),
                this.mapTilerSearch(normalizedQuery, 8, { skipProximity: true })
            ]
            : [
                this.openRouteAutocomplete(normalizedQuery, 8),
                this.openRouteSearch(normalizedQuery, 8),
                this.mapTilerSearch(normalizedQuery, 8)
            ];

        return forkJoin(requests).pipe(
            map((groups) => this.rankResults(
                groups.flat(),
                normalizedQuery,
                isPostcodeIntent
            ).slice(0, 8)),
            map(results => {
                this.cache.set(cacheKey, results);
                return results;
            }),
            catchError(error => {
                console.warn('[GeocodingService] Autocomplete failed:', error);
                return of([]);
            })
        );
    }

    geocodeAddress(query: string): Observable<AutocompleteResult[]> {
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
                this.openRouteSearch(normalizedQuery, 5),
                this.mapTilerSearch(normalizedQuery, 5)
            ];

        return forkJoin(requests).pipe(
            map(groups => this.rankResults(groups.flat(), normalizedQuery, isPostcodeIntent).slice(0, 5)),
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

    private openRouteAutocomplete(query: string, size: number): Observable<AutocompleteResult[]> {
        const apiKey = this.provider.getOpenRouteServiceApiKey();

        if (!apiKey) return of([]);

        const params: Record<string, string | number> = {
            api_key: apiKey,
            text: query,
            size,
            layers: 'address,venue,street,locality,neighbourhood'
        };

        this.addOpenRouteBounds(params);

        return this.http.get<{ features: ORSFeature[] }>(`${this.baseUrl}/autocomplete`, {
            params
        }).pipe(
            map(res => this.mapOpenRouteFeaturesToResults(res.features)),
            catchError(error => {
                console.warn('[GeocodingService] ORS autocomplete failed:', error);
                return of([]);
            })
        );
    }

    private openRouteSearch(query: string, size: number, options: { skipFocusBias?: boolean; includePostcodeLayer?: boolean } = {}): Observable<AutocompleteResult[]> {
        const apiKey = this.provider.getOpenRouteServiceApiKey();
        if (!apiKey) return of([]);

        const params: Record<string, string | number> = {
            api_key: apiKey,
            text: query,
            size,
            layers: options.includePostcodeLayer
                ? 'address,venue,street,locality,neighbourhood,postalcode'
                : 'address,venue,street,locality,neighbourhood'
        };

        this.addOpenRouteBounds(params, options.skipFocusBias);

        return this.http.get<{ features: ORSFeature[] }>(`${this.baseUrl}/search`, {
            params
        }).pipe(
            map(res => this.mapOpenRouteFeaturesToResults(res.features)),
            catchError(error => {
                console.warn('[GeocodingService] ORS search failed:', error);
                return of([]);
            })
        );
    }

    private mapTilerSearch(query: string, limit: number, options: { skipProximity?: boolean } = {}): Observable<AutocompleteResult[]> {
        const apiKey = this.provider.getMapTilerApiKey();

        if (!apiKey) return of([]);

        const country = this.config.currentCountry();
        const encodedQuery = encodeURIComponent(query);

        const params: Record<string, string | number> = {
            key: apiKey,
            limit,
            language: 'en',
            country: country.code.toLowerCase(),
            types: 'poi,address,place'
        };

        if (!options.skipProximity) {
            params['proximity'] = `${country.defaultCenter.lng},${country.defaultCenter.lat}`;
        }

        return this.http.get<{ features: MapTilerFeature[] }>(`${this.mapTilerGeocodeUrl}/${encodedQuery}.json`, {
            params
        }).pipe(
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

    private addOpenRouteBounds(params: Record<string, string | number>, skipFocusBias = false): void {
        const country = this.config.currentCountry();

        if (country.code) {
            params['boundary.country'] = country.code;
        }

        if (skipFocusBias) return;

        params['focus.point.lat'] = country.defaultCenter.lat;
        params['focus.point.lon'] = country.defaultCenter.lng;
    }

    private normalizeQuery(query: string): string {
        const country = this.config.currentCountry();
        const trimmed = this.normalizePlaceIntent(String(query || ''))
            .replace(/\s+/g, ' ')
            .replace(/\s*,\s*/g, ', ')
            .trim();

        if (!trimmed) return '';

        const lower = trimmed.toLowerCase();
        const hasCountry = lower.includes(country.name.toLowerCase()) || lower.includes(country.code.toLowerCase());

        return hasCountry ? trimmed : `${trimmed}, ${country.name}`;
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
                const label = f.properties?.label || f.properties?.name || 'Selected Location';
                return {
                    label,
                    lat: Number(f.geometry.coordinates[1]),
                    lng: Number(f.geometry.coordinates[0]),
                    ...this.splitLabelForDisplay(label),
                    postalCode: this.extractPostcodeFromLabel(label) || undefined
                };
            })
            .filter(result =>
                Number.isFinite(result.lat) &&
                Number.isFinite(result.lng)
            );
    }

    private mapMapTilerFeaturesToResults(features: MapTilerFeature[]): AutocompleteResult[] {
        if (!features) return [];

        return features
            .map(feature => {
                const coordinates = feature.center || feature.geometry?.coordinates;
                const label = feature.place_name || feature.text || 'Selected Location';

                return {
                    label,
                    lat: Number(coordinates?.[1]),
                    lng: Number(coordinates?.[0]),
                    ...this.splitLabelForDisplay(label),
                    postalCode: this.extractPostcodeFromLabel(label) || undefined
                };
            })
            .filter(result =>
                !!result.label &&
                Number.isFinite(result.lat) &&
                Number.isFinite(result.lng)
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

    private rankResults(results: AutocompleteResult[], query: string, isPostcodeIntent = false): AutocompleteResult[] {
        const labelledResults = results.map(result => this.preserveTypedHouseNumber(result, query));
        const seen = new Set<string>();
        const deduped = labelledResults.filter(result => {
            const key = `${this.normaliseForScore(result.label)}:${result.lat.toFixed(5)}:${result.lng.toFixed(5)}`;

            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });

        return deduped.sort((a, b) => this.scoreResult(b, query, isPostcodeIntent) - this.scoreResult(a, query, isPostcodeIntent));
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
