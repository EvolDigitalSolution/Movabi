import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { MapProviderService } from './map-provider.service';
import { AppConfigService } from '../config/app-config.service';
import { AutocompleteResult } from '../../models/maps/route-result.model';
import { catchError, forkJoin, map, Observable, of, switchMap } from 'rxjs';

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

export interface GeocodeSearchOptions {
    proximity?: { lat: number; lng: number } | null;
}

interface SearchIntent {
    term: string;
    nearText: string | null;
    usesNearMe: boolean;
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

    autocomplete(query: string, options: GeocodeSearchOptions = {}): Observable<AutocompleteResult[]> {
        const intent = this.parseSearchIntent(query);
        const normalizedQuery = this.normalizeQuery(intent.term);
        if (!normalizedQuery || normalizedQuery.length < 3) return of([]);

        const countryCode = this.config.currentCountry().code;
        const proximityKey = options.proximity
            ? `${options.proximity.lat.toFixed(4)},${options.proximity.lng.toFixed(4)}`
            : intent.nearText || 'default';
        const cacheKey = `autocomplete:${countryCode}:${normalizedQuery}:${proximityKey}`;

        if (this.cache.has(cacheKey)) return of(this.cache.get(cacheKey)!);

        if (intent.nearText && !options.proximity) {
            return this.resolveSearchProximity(intent.nearText).pipe(
                switchMap(proximity => this.autocomplete(intent.term, { proximity }))
            );
        }

        const proximity = options.proximity || null;
        const requests = [
            this.openRouteAutocomplete(normalizedQuery, 8, proximity),
            this.openRouteSearch(normalizedQuery, 8, proximity),
            this.mapTilerSearch(normalizedQuery, 8, proximity)
        ];

        return forkJoin(requests).pipe(
            map((groups) => this.rankResults(
                groups.flat(),
                normalizedQuery,
                proximity
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

    geocodeAddress(query: string, options: GeocodeSearchOptions = {}): Observable<AutocompleteResult[]> {
        const intent = this.parseSearchIntent(query);
        const normalizedQuery = this.normalizeQuery(intent.term);
        if (!normalizedQuery) return of([]);

        if (intent.nearText && !options.proximity) {
            return this.resolveSearchProximity(intent.nearText).pipe(
                switchMap(proximity => this.geocodeAddress(intent.term, { proximity }))
            );
        }

        const proximity = options.proximity || null;
        return forkJoin([
            this.openRouteSearch(normalizedQuery, 5, proximity),
            this.mapTilerSearch(normalizedQuery, 5, proximity)
        ]).pipe(
            map(groups => this.rankResults(groups.flat(), normalizedQuery, proximity).slice(0, 5)),
            catchError(error => {
                console.warn('[GeocodingService] Geocode failed:', error);
                return of([]);
            })
        );
    }

    private openRouteAutocomplete(query: string, size: number, proximity?: { lat: number; lng: number } | null): Observable<AutocompleteResult[]> {
        const apiKey = this.provider.getOpenRouteServiceApiKey();

        if (!apiKey) return of([]);

        const params: Record<string, string | number> = {
            api_key: apiKey,
            text: query,
            size,
            layers: 'address,venue,street,locality,neighbourhood'
        };

        this.addOpenRouteBounds(params, proximity);

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

    private openRouteSearch(query: string, size: number, proximity?: { lat: number; lng: number } | null): Observable<AutocompleteResult[]> {
        const apiKey = this.provider.getOpenRouteServiceApiKey();
        if (!apiKey) return of([]);

        const params: Record<string, string | number> = {
            api_key: apiKey,
            text: query,
            size,
            layers: 'address,venue,street,locality,neighbourhood'
        };

        this.addOpenRouteBounds(params, proximity);

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

    private mapTilerSearch(query: string, limit: number, proximity?: { lat: number; lng: number } | null): Observable<AutocompleteResult[]> {
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
                types: 'poi,address,place',
                proximity: `${proximity?.lng ?? country.defaultCenter.lng},${proximity?.lat ?? country.defaultCenter.lat}`
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

    private addOpenRouteBounds(params: Record<string, string | number>, proximity?: { lat: number; lng: number } | null): void {
        const country = this.config.currentCountry();

        if (country.code) {
            params['boundary.country'] = country.code;
        }

        params['focus.point.lat'] = proximity?.lat ?? country.defaultCenter.lat;
        params['focus.point.lon'] = proximity?.lng ?? country.defaultCenter.lng;
    }

    private resolveSearchProximity(nearText: string): Observable<{ lat: number; lng: number } | null> {
        const normalizedNear = this.normalizeQuery(nearText);

        if (!normalizedNear) return of(null);

        return forkJoin([
            this.openRouteSearch(normalizedNear, 1, null),
            this.mapTilerSearch(normalizedNear, 1, null)
        ]).pipe(
            map(groups => {
                const result = this.rankResults(groups.flat(), normalizedNear)[0];
                if (!result) return null;
                return { lat: Number(result.lat), lng: Number(result.lng) };
            }),
            catchError(() => of(null))
        );
    }

    private parseSearchIntent(query: string): SearchIntent {
        const raw = String(query || '').replace(/\s+/g, ' ').trim();
        const nearMe = /\b(near|nearby|close to|around)\s+(me|here)\b/i.test(raw) || /\bnearby\b/i.test(raw);
        const nearMatch = raw.match(/\bnear\s+(.+)$/i);
        const nearText = nearMatch && !/^(me|here)$/i.test(nearMatch[1].trim())
            ? nearMatch[1].trim()
            : null;
        const term = this.normalizePlaceIntent(raw);

        return {
            term,
            nearText,
            usesNearMe: nearMe
        };
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

    private rankResults(results: AutocompleteResult[], query: string, proximity?: { lat: number; lng: number } | null): AutocompleteResult[] {
        const labelledResults = results.map(result => this.preserveTypedHouseNumber(result, query));
        const seen = new Set<string>();
        const deduped = labelledResults.filter(result => {
            const key = `${this.normaliseForScore(result.label)}:${result.lat.toFixed(5)}:${result.lng.toFixed(5)}`;

            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });

        return deduped.sort((a, b) => this.scoreResult(b, query, proximity) - this.scoreResult(a, query, proximity));
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

    private scoreResult(result: AutocompleteResult, query: string, proximity?: { lat: number; lng: number } | null): number {
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
        if (proximity) {
            const distanceKm = this.distanceKm(proximity.lat, proximity.lng, result.lat, result.lng);
            if (Number.isFinite(distanceKm)) {
                score += Math.max(0, 80 - distanceKm);
            }
        }

        return score;
    }

    private distanceKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
        const toRad = (value: number) => value * Math.PI / 180;
        const radiusKm = 6371;
        const dLat = toRad(lat2 - lat1);
        const dLng = toRad(lng2 - lng1);
        const a =
            Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;

        return radiusKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
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
