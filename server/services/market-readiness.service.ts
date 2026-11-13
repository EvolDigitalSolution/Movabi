import { supabaseAdmin } from './supabase.service';
import { SUPPORTED_PAYOUT_COUNTRIES } from './payout-eligibility.service';

/**
 * Market-readiness validation: report only, enables nothing (area 8).
 *
 * Collection (customer card payment), payout (driver payouts) and cash rides are separate
 * capabilities with separate states, read from the same gates the runtime uses:
 *  - collection: with database/global payment routing on, the market's card route in
 *    `market_payment_routes`; with it off, the legacy checkout, which is GB/GBP Stripe only
 *    (`stripeCheckoutMarket`).
 *  - payout: Stripe Connect for the countries in `SUPPORTED_PAYOUT_COUNTRIES`; any other market
 *    only through an enabled `driver_payout_markets` row with the sandbox payout runtime on.
 *  - cash ride: `VAYDU_CASH_RIDE_BOOKING` AND `driver_cash_credit_market_enabled_v1e(market,
 *    currency)`; rides only (courier cash is off everywhere, D10).
 * Enabling one never implies another. A read that fails makes that capability `unknown` (never
 * `ready`). Driver counts are scoped to the tenant.
 */
export type CapabilityState = 'ready' | 'blocked' | 'unknown';
export interface CapabilityReadiness { state: CapabilityState; provider: string | null; reasons: string[] }

export interface MarketReadinessReport {
    tenant_id: string;
    market_code: string;
    currency_code: string | null;
    service: string;
    market_rows: number;
    checks: {
        market_row: boolean;
        currency: boolean;
        pricing: boolean;
        eligible_drivers: boolean;
        payment_route: boolean;
        booking_enabled: boolean;
        payment_enabled: boolean;
    };
    drivers: { total: number; eligible: number };
    payment: { route_configured: boolean; provider: string | null };
    collection: CapabilityReadiness;
    payout: CapabilityReadiness;
    cash_ride: CapabilityReadiness;
    ready: { quote: boolean; booking: boolean; payment: boolean; collection: boolean; payout: boolean; cash_ride: boolean };
    blocked_reasons: string[];
}

type Row = Record<string, any>;
/** `FAILED` marks a read that errored, so "no row" and "could not read" never look alike. */
export const FAILED = Symbol('read_failed');
type Read<T> = T | typeof FAILED;

export interface MarketReadinessInput {
    tenantId: string;
    market: string;
    service: string;
    marketRows: Read<Row[]>;            // enabled market_availability rows
    pricingCount: Read<number>;
    drivers: Read<{ total: number; eligible: number }>;
    cardRoute: Read<Row | null>;
    payoutRow: Read<Row | null>;
    cashMarketEnabled: Read<boolean>;
}
type Env = Record<string, string | undefined>;

const unknown = (reason: string): CapabilityReadiness => ({ state: 'unknown', provider: null, reasons: [reason] });
const result = (reasons: string[], provider: string | null): CapabilityReadiness =>
    ({ state: reasons.length ? 'blocked' : 'ready', provider, reasons });

/** The country-level row (no city, no zone) when there is one; otherwise the first. */
function primaryRow(rows: Row[]): Row | null {
    return rows.find((r) => !r.market_city && !r.zone_id) || rows[0] || null;
}

export function evaluateMarketReadiness(input: MarketReadinessInput, env: Env = process.env): MarketReadinessReport {
    const market = input.market.toUpperCase();
    const service = (input.service || 'ride').toLowerCase();
    const rows = input.marketRows === FAILED ? null : input.marketRows;
    const row = rows ? primaryRow(rows) : null;
    const currency = String(row?.supported_currency || '').toUpperCase() || null;
    const pricingCount = input.pricingCount === FAILED ? null : input.pricingCount;
    const drivers = input.drivers === FAILED ? null : input.drivers;

    const blocked: string[] = [];
    if (!rows) blocked.push('market_read_failed');
    else if (!row) blocked.push('no_market_row');
    if (row && !currency) blocked.push('no_currency');
    if (pricingCount === null) blocked.push('pricing_read_failed');
    else if (pricingCount === 0) blocked.push('no_pricing_strategy');
    if (drivers === null) blocked.push('drivers_read_failed');
    else if (drivers.eligible === 0) blocked.push('no_eligible_drivers');

    const noMarket = !rows ? unknown('market_read_failed') : result(['no_market_row'], null);

    // Collection.
    const routing = env.VAYDU_DATABASE_PAYMENT_ROUTING_V23 === 'true' || env.VAYDU_GLOBAL_PAYMENT_ROUTING_V23 === 'true';
    let collection: CapabilityReadiness;
    if (!row || !currency) collection = noMarket;
    else if (routing) {
        if (input.cardRoute === FAILED) collection = unknown('payment_route_read_failed');
        else {
            const r = input.cardRoute, caps: string[] = r?.capabilities || [], reasons: string[] = [];
            if (!r) reasons.push('no_card_route');
            else {
                if (!r.enabled) reasons.push('card_route_disabled');
                if (!r.merchant_approved) reasons.push('merchant_not_approved');
                if (!r.adapter_ready) reasons.push('adapter_not_ready');
                if (!(caps.includes('collect') || (caps.includes('authorise') && caps.includes('capture')))) reasons.push('route_cannot_collect');
            }
            if (!row.payment_enabled) reasons.push('market_payment_disabled');
            collection = result(reasons, r?.provider || null);
        }
    } else {
        const legacy = market === 'GB' && currency === 'GBP';
        const reasons: string[] = [];
        if (!legacy) reasons.push('legacy_checkout_gb_gbp_only');
        if (!row.payment_enabled) reasons.push('market_payment_disabled');
        collection = result(reasons, legacy ? 'stripe' : null);
    }

    // Payout.
    let payout: CapabilityReadiness;
    if (!row || !currency) payout = noMarket;
    else if (SUPPORTED_PAYOUT_COUNTRIES.includes(market)) payout = result([], 'stripe');
    else if (input.payoutRow === FAILED) payout = unknown('payout_market_read_failed');
    else {
        const p = input.payoutRow, reasons: string[] = [];
        if (!p) reasons.push('no_payout_market');
        else {
            if (!p.enabled) reasons.push('payout_market_disabled');
            if (env.VAYDU_DRIVER_PAYOUT_SANDBOX !== 'true') reasons.push('payout_runtime_disabled');
        }
        payout = result(reasons, p?.provider || null);
    }

    // Cash ride.
    let cash: CapabilityReadiness;
    if (service !== 'ride') cash = result(['cash_rides_only'], null);
    else if (!row || !currency) cash = noMarket;
    else if (input.cashMarketEnabled === FAILED) cash = unknown('cash_market_read_failed');
    else {
        const reasons: string[] = [];
        if (env.VAYDU_CASH_RIDE_BOOKING !== 'true') reasons.push('cash_ride_flag_off');
        if (!input.cashMarketEnabled) reasons.push('cash_market_not_enabled');
        cash = result(reasons, null);
    }

    for (const [name, c] of [['collection', collection], ['payout', payout], ['cash_ride', cash]] as const)
        if (c.state !== 'ready') blocked.push(...c.reasons.map((r) => `${name}:${r}`));

    const counts = drivers || { total: 0, eligible: 0 };
    const cardRoute = input.cardRoute === FAILED ? null : input.cardRoute;
    const routeConfigured = !!cardRoute && cardRoute.enabled === true;
    return {
        tenant_id: input.tenantId,
        market_code: market,
        currency_code: currency,
        service,
        market_rows: rows?.length ?? 0,
        checks: {
            market_row: !!row,
            currency: !!currency,
            pricing: (pricingCount ?? 0) > 0,
            eligible_drivers: counts.eligible > 0,
            payment_route: routeConfigured,
            booking_enabled: !!row?.booking_enabled,
            payment_enabled: !!row?.payment_enabled,
        },
        drivers: counts,
        payment: { route_configured: routeConfigured, provider: collection.provider },
        collection, payout, cash_ride: cash,
        ready: {
            quote: !!row && !!currency && (pricingCount ?? 0) > 0,
            booking: !!row && !!row.booking_enabled && !!row.driver_online_enabled && counts.eligible > 0,
            payment: collection.state === 'ready',
            collection: collection.state === 'ready',
            payout: payout.state === 'ready',
            cash_ride: cash.state === 'ready',
        },
        blocked_reasons: blocked,
    };
}

async function read<T>(q: PromiseLike<{ data: any; error: any; count?: number | null }>, pick: (r: { data: any; count?: number | null }) => T): Promise<Read<T>> {
    try { const r = await q; return r.error ? FAILED : pick(r); } catch { return FAILED; }
}

export async function reportMarketReadiness(tenantId: string, marketCode: string, serviceSlug = 'ride', db: any = supabaseAdmin, env: Env = process.env): Promise<MarketReadinessReport> {
    const market = marketCode.toUpperCase();
    const marketRows = await read(db.from('market_availability').select('*').eq('country_code', market).eq('enabled', true), (r) => (r.data || []) as Row[]);
    const row = marketRows === FAILED ? null : primaryRow(marketRows);
    const currency = String(row?.supported_currency || '').toUpperCase();
    const pricingCount = await read(db.from('market_pricing_strategies').select('id', { count: 'exact', head: true }).eq('country_code', market), (r) => Number(r.count || 0));
    const driverQuery = () => db.from('profiles').select('id', { count: 'exact', head: true })
        .eq('role', 'driver').eq('tenant_id', tenantId).eq('registration_country_code', market);
    const total = await read(driverQuery(), (r) => Number(r.count || 0));
    const eligible = await read(driverQuery().not('registration_activated_at', 'is', null), (r) => Number(r.count || 0));
    const first = (r: { data: any }) => ((r.data || [])[0] || null) as Row | null;
    const cardRoute: Read<Row | null> = currency
        ? await read(db.from('market_payment_routes').select('provider,enabled,merchant_approved,adapter_ready,capabilities,preferred')
            .eq('country_code', market).eq('currency_code', currency).eq('method', 'card').order('preferred', { ascending: false }).limit(1), first)
        : null;
    const payoutRow: Read<Row | null> = currency
        ? await read(db.from('driver_payout_markets').select('provider,enabled').eq('country_code', market).eq('currency_code', currency).limit(1), first)
        : null;
    const cashMarketEnabled: Read<boolean> = currency
        ? await read(db.rpc('driver_cash_credit_market_enabled_v1e', { p_country: market, p_currency: currency }), (r) => r.data === true)
        : false;
    return evaluateMarketReadiness({
        tenantId, market, service: serviceSlug, marketRows, pricingCount,
        drivers: total === FAILED || eligible === FAILED ? FAILED : { total, eligible },
        cardRoute, payoutRow, cashMarketEnabled,
    }, env);
}
