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
        const normalizedQuery = this.normalizeQuery(query);
        if (!normalizedQuery || normalizedQuery.length < 3) return of([]);

        const countryCode = this.config.currentCountry().code;
        const cacheKey = `autocomplete:${countryCode}:${normalizedQuery}`;

        if (this.cache.has(cacheKey)) return of(this.cache.get(cacheKey)!);

        const requests = [
            this.openRouteAutocomplete(normalizedQuery, 8),
            this.openRouteSearch(normalizedQuery, 8),
            this.mapTilerSearch(normalizedQuery, 8)
        ];

        return forkJoin(requests).pipe(
            map((groups) => this.rankResults(
                groups.flat(),
                normalizedQuery
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
        const normalizedQuery = this.normalizeQuery(query);
        if (!normalizedQuery) return of([]);

        return forkJoin([
            this.openRouteSearch(normalizedQuery, 5),
            this.mapTilerSearch(normalizedQuery, 5)
        ]).pipe(
            map(groups => this.rankResults(groups.flat(), normalizedQuery).slice(0, 5)),
            catchError(error => {
                console.warn('[GeocodingService] Geocode failed:', error);
                return of([]);
            })
        );
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

    private openRouteSearch(query: string, size: number): Observable<AutocompleteResult[]> {
        const apiKey = this.provider.getOpenRouteServiceApiKey();
        if (!apiKey) return of([]);

        const params: Record<string, string | number> = {
            api_key: apiKey,
            text: query,
            size,
            layers: 'address,venue,street,locality,neighbourhood'
        };

        this.addOpenRouteBounds(params);

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

    private mapTilerSearch(query: string, limit: number): Observable<AutocompleteResult[]> {
        const apiKey = this.provider.getMapTilerApiKey();

        if (!apiKey) return of([]);

        const country = this.config.currentCountry();
        const encodedQuery = encodeURIComponent(query);

        return this.http.get<{ features: MapTilerFeature[] }>(`${this.mapTilerGeocodeUrl}/${encodedQuery}.json`, {
            params: {
                key: apiKey,
                limit,
                language: 'en',
                country: country.code.toLowerCase(),
                types: 'address,poi,place,locality',
                proximity: `${country.defaultCenter.lng},${country.defaultCenter.lat}`
            }
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

    private addOpenRouteBounds(params: Record<string, string | number>): void {
        const country = this.config.currentCountry();

        if (country.code) {
            params['boundary.country'] = country.code;
        }

        params['focus.point.lat'] = country.defaultCenter.lat;
        params['focus.point.lon'] = country.defaultCenter.lng;
    }

    private normalizeQuery(query: string): string {
        const country = this.config.currentCountry();
        const trimmed = String(query || '')
            .replace(/\s+/g, ' ')
            .replace(/\s*,\s*/g, ', ')
            .trim();

        if (!trimmed) return '';

        const lower = trimmed.toLowerCase();
        const hasCountry = lower.includes(country.name.toLowerCase()) || lower.includes(country.code.toLowerCase());

        return hasCountry ? trimmed : `${trimmed}, ${country.name}`;
    }

    private mapOpenRouteFeaturesToResults(features: ORSFeature[]): AutocompleteResult[] {
        if (!features) return [];

        return features
            .filter(f => !!f?.geometry?.coordinates && f.geometry.coordinates.length >= 2)
            .map(f => ({
                label: f.properties?.label || f.properties?.name || 'Selected Location',
                lat: Number(f.geometry.coordinates[1]),
                lng: Number(f.geometry.coordinates[0])
            }))
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

                return {
                    label: feature.place_name || feature.text || 'Selected Location',
                    lat: Number(coordinates?.[1]),
                    lng: Number(coordinates?.[0])
                };
            })
            .filter(result =>
                !!result.label &&
                Number.isFinite(result.lat) &&
                Number.isFinite(result.lng)
            );
    }

    private rankResults(results: AutocompleteResult[], query: string): AutocompleteResult[] {
        const labelledResults = results.map(result => this.preserveTypedHouseNumber(result, query));
        const seen = new Set<string>();
        const deduped = labelledResults.filter(result => {
            const key = `${this.normaliseForScore(result.label)}:${result.lat.toFixed(5)}:${result.lng.toFixed(5)}`;

            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });

        return deduped.sort((a, b) => this.scoreResult(b, query) - this.scoreResult(a, query));
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

    private scoreResult(result: AutocompleteResult, query: string): number {
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
