import type { MarketAvailabilityForm } from '../../services/admin-market-availability.service';

/**
 * Market-rollout scope semantics (see server/services/market-availability.service.ts):
 *  - country scope: market_city = null AND zone_id = null
 *  - city scope:    market_city = <city> AND zone_id = null
 *  - zone scope:    zone_id = <uuid> (requires a selectable zone entity)
 *
 * There is no selectable zone entity for market rollout (market_availability.zone_id
 * is a bare nullable uuid with no foreign key), so the admin UI only creates
 * country- and city-level scopes and always submits zone_id = null.
 */

/** Empty/blank/invalid dates become null so the API never receives an invalid date string. */
export function normalizeMarketDate(value: unknown): string | null {
    const raw = String(value ?? '').trim();
    if (!raw) return null;
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** Stored ISO timestamp -> value accepted by <input type="datetime-local">. */
export function toDateTimeLocalValue(value: unknown): string | null {
    const raw = String(value ?? '').trim();
    if (!raw) return null;
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) return null;
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}T${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`;
}

/** Scope label shown to the administrator (never a free-text zone). */
export function marketScopeLabel(marketCity: unknown): string {
    return String(marketCity ?? '').trim()
        ? 'City-wide — all zones in city'
        : 'Country-wide — all zones';
}

/**
 * Build the exact payload sent to POST/PUT /api/markets/admin.
 * `id` is preserved when present so the service picks the update path.
 */
export function buildMarketScopePayload(form: MarketAvailabilityForm): MarketAvailabilityForm {
    return {
        ...form,
        country_code: String(form.country_code ?? '').trim().toUpperCase(),
        market_city: String(form.market_city ?? '').trim() || null,
        zone_id: null,
        supported_currency: String(form.supported_currency ?? '').trim().toUpperCase() || null,
        timezone: String(form.timezone ?? '').trim() || null,
        unavailable_title: String(form.unavailable_title ?? '').trim() || null,
        unavailable_message: String(form.unavailable_message ?? '').trim() || null,
        valid_from: normalizeMarketDate(form.valid_from),
        valid_until: normalizeMarketDate(form.valid_until),
        enabled: !!form.enabled,
        launch_status: form.launch_status
    };
}
