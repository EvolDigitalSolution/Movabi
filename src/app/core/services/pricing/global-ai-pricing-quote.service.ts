import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { ApiUrlService } from '../api-url.service';
import { MarketAvailabilityClientService } from '../market-availability.service';
import { ServiceTypeSlug } from '../../models/maps/map-marker.model';
import { buildQuoteSignature } from '../../../shared/utils/quote-signature';

export interface GlobalAiPricingQuoteRequest {
    lat: number;
    lng: number;
    dropoffLat?: number | null;
    dropoffLng?: number | null;
    serviceSlug: ServiceTypeSlug;
    distanceKm: number;
    durationMinutes: number;
    countryCode?: string;
    currencyCode?: string;
    cityName?: string | null;
    zoneId?: string | null;
    vehicleClass?: string | null;
    passengerCount?: number;
    packageSize?: string | null;
    deliveryUrgency?: string | null;
    itemCount?: number;
    errandMode?: string | null;
    taskMinutes?: number;
    scheduledTime?: string | null;
    airportOption?: string | null;
    serviceSubtype?: string | null;
    budget?: number;
    moveDetails?: {
        size: 'small' | 'medium' | 'large' | 'full-house';
        helperCount: number;
        stairsInvolved: boolean;
        packingAssistance: boolean;
        fragileItems: boolean;
    } | null;
}

export interface GlobalAiPricingFareBreakdown {
    baseFare: number;
    distanceCost: number;
    durationCost: number;
    serviceFee: number;
    taxAmount: number;
    dynamicPricingAmount: number;
    commissionAmount: number;
    platformFee: number;
    driverPayout: number;
    total: number;
    currencyCode: string;
    currencySymbol: string;
    multiplier: number;
    commissionPercent: number;
    source: string;
    extras: Record<string, number>;
    minimumFareAdjustment?: number;
    maximumFareAdjustment?: number;
    negotiationAdjustment?: number;
    serviceFareBeforePlatformFee?: number;
    serviceFare?: number;
    shoppingBudget?: number;
    totalAuthorisation?: number;
    driverGrossEarnings?: number;
    calculationVersion?: string;
    [key: string]: unknown;
}

export interface GlobalAiPricingNoShowTerms {
    policyVersion: string;
    fareMinor: number;
    feeMinor: number;
    driverShareMinor: number;
    platformShareMinor: number;
    graceSeconds: number;
    currency: string;
}

export interface GlobalAiPricingQuoteResponse {
    quoteReference: string;
    market: { countryCode: string; currency: string; city: string | null; zoneId: string | null };
    price: Record<string, number>;
    ai: Record<string, unknown>;
    guardrails: Record<string, unknown>;
    priceLockedUntil: string;
    fallback: { used: boolean; reason: string | null; source: string };
    legacy: {
        totalPrice: number;
        currencyCode: string;
        source: string;
        fareBreakdown: GlobalAiPricingFareBreakdown;
    };
    noShow?: GlobalAiPricingNoShowTerms;
}

/**
 * Thin HTTP client for the authoritative backend pricing pipeline
 * (GlobalAiPricingService -> PricingService -> MarketPricingService).
 * The frontend must never re-derive fare-affecting numbers - it only
 * sends booking inputs and displays exactly what this endpoint returns.
 */
@Injectable({
    providedIn: 'root'
})
export class GlobalAiPricingQuoteService {
    private http = inject(HttpClient);
    private apiUrlService = inject(ApiUrlService);
    private marketAvailability = inject(MarketAvailabilityClientService);
    private pending = new Map<string, Promise<GlobalAiPricingQuoteResponse>>();
    private recent = new Map<string, { value: GlobalAiPricingQuoteResponse; expiresAt: number }>();

    async getQuote(request: GlobalAiPricingQuoteRequest): Promise<GlobalAiPricingQuoteResponse> {
        const key = this.requestKey(request);
        const cached = this.recent.get(key);
        if (cached && cached.expiresAt > Date.now()) return cached.value;
        const existing = this.pending.get(key);
        if (existing) return existing;

        // Market authorisation now runs inside the deduped execution, so an equivalent quote
        // that is already in flight (or freshly cached) no longer re-triggers /markets/resolve
        // on every call. The server independently re-authorises the quote POST, so this
        // pre-flight is a UX guard and not the authority.
        await this.marketAvailability.resolve({ countryCode: request.countryCode, marketCity: request.cityName, zoneId: request.zoneId, capability: 'quote' });

        const promise = firstValueFrom(
            this.http.post<GlobalAiPricingQuoteResponse>(
                this.apiUrlService.getApiUrl('/api/pricing/global-ai/quote'),
                request
            )
        );
        this.pending.set(key, promise);
        try {
            const value = await promise;
            this.recent.set(key, { value, expiresAt: Date.now() + 1500 });
            return value;
        } finally {
            this.pending.delete(key);
        }
    }

    /** Single authoritative dedupe key: pricing-relevant inputs including both coordinates. */
    private requestKey(request: GlobalAiPricingQuoteRequest): string {
        return buildQuoteSignature(request);
    }
}
