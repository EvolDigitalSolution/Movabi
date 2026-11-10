import { supabaseAdmin } from './supabase.service';

/**
 * Market-readiness validation — report only; enables nothing.
 * Each check answers a launch requirement: pricing configured, currency
 * supported, eligible drivers present, payment routing independently
 * configured. Enabling one capability (Ride) never implies another
 * (payouts, cash, or another provider) — they are reported separately.
 */
export interface MarketReadinessReport {
    market_code: string;
    currency_code: string | null;
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
    ready: { quote: boolean; booking: boolean; payment: boolean };
    blocked_reasons: string[];
}

export async function reportMarketReadiness(tenantId: string, marketCode: string, serviceSlug = 'ride'): Promise<MarketReadinessReport> {
    const market = marketCode.toUpperCase();

    const { data: rows } = await supabaseAdmin
        .from('market_availability')
        .select('*')
        .eq('country_code', market)
        .eq('enabled', true);
    const marketRow = (rows || [])[0] || null;
    const currency = String(marketRow?.supported_currency || '').toUpperCase() || null;

    // Pricing: an enabled pricing strategy row for the market.
    const { data: pricing } = await supabaseAdmin
        .from('market_pricing_strategies')
        .select('id')
        .eq('country_code', market)
        .limit(1);
    const pricingReady = (pricing || []).length > 0;

    // Eligible drivers: activated drivers registered in this market.
    const { data: drivers, count: totalDrivers } = await supabaseAdmin
        .from('profiles')
        .select('id', { count: 'exact' })
        .eq('role', 'driver')
        .eq('registration_country_code', market)
        .not('registration_activated_at', 'is', null);
    const eligibleDrivers = (drivers || []).length;

    // Payment routing: an independent configured route for card in this market+currency.
    const { data: route } = await supabaseAdmin
        .from('market_payment_routes')
        .select('provider, enabled')
        .eq('country_code', market)
        .eq('currency_code', currency || '')
        .eq('method', 'card')
        .maybeSingle();
    const routeConfigured = !!route && route.enabled !== false;

    const blocked: string[] = [];
    if (!marketRow) blocked.push('no_market_row');
    if (!currency) blocked.push('no_currency');
    if (!pricingReady) blocked.push('no_pricing_strategy');
    if (eligibleDrivers === 0) blocked.push('no_eligible_drivers');
    if (!routeConfigured) blocked.push('no_payment_route');

    return {
        market_code: market,
        currency_code: currency,
        checks: {
            market_row: !!marketRow,
            currency: !!currency,
            pricing: pricingReady,
            eligible_drivers: eligibleDrivers > 0,
            payment_route: routeConfigured,
            booking_enabled: !!marketRow?.booking_enabled,
            payment_enabled: !!marketRow?.payment_enabled,
        },
        drivers: { total: Number(totalDrivers || 0), eligible: eligibleDrivers },
        payment: { route_configured: routeConfigured, provider: (route as any)?.provider || null },
        ready: {
            quote: !!marketRow && !!currency && pricingReady,
            booking: !!marketRow && eligibleDrivers > 0 && !!marketRow.driver_online_enabled !== false,
            payment: routeConfigured && !!marketRow?.payment_enabled !== false,
        },
        blocked_reasons: blocked,
    };
}
