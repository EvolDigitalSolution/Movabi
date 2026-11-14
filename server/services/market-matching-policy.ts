/**
 * Per-market driver ranking policy (area 1b / P7, 2026-11-14). Pure: no I/O.
 *
 * Before this, ranking was one platform-wide switch (VAYDU_DRIVER_RANKING_V23) with reliability
 * weights stored per TENANT (`marketplace_settings.smart_matching`), so enabling it for one market
 * would also re-rank every other market of that tenant.
 *
 * Now a market can carry its own entry:
 *   smart_matching = { ..., "markets": { "GB": { "rankingEnabled": true, "acceptanceRateWeight": 0.5,
 *                                             "cancellationRateWeight": 1.0, "newDriverExposureKm": 0.15 } } }
 * - A market WITH an entry uses only that entry: its own switch and its own weights.
 * - A market WITHOUT an entry behaves exactly as before: the platform switch and the tenant weights.
 * Invalid or negative numbers count as 0 (neutral). Road-ETA ordering is a separate flag
 * (VAYDU_TOMTOM_MATRIX_V23) and is not changed here.
 */
export interface RankingWeightsPolicy {
    acceptanceRateWeight: number;
    cancellationRateWeight: number;
    newDriverExposureKm: number;
}
export interface MarketRankingPolicy extends RankingWeightsPolicy {
    rankingEnabled: boolean;
    source: 'market' | 'tenant';
}

const weight = (v: unknown): number => {
    const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
    return Number.isFinite(n) && n > 0 ? n : 0;
};

export function marketRankingPolicy(rawSmartMatching: unknown, tenantWeights: Partial<RankingWeightsPolicy> | null | undefined,
    countryCode: string | null | undefined, platformRankingFlag: boolean): MarketRankingPolicy {
    const country = String(countryCode || '').trim().toUpperCase();
    const raw = rawSmartMatching && typeof rawSmartMatching === 'object' ? rawSmartMatching as Record<string, any> : null;
    const markets = raw && raw.markets && typeof raw.markets === 'object' && !Array.isArray(raw.markets) ? raw.markets as Record<string, any> : null;
    const entry = markets && /^[A-Z]{2}$/.test(country) && Object.prototype.hasOwnProperty.call(markets, country) ? markets[country] : undefined;
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
        return {
            rankingEnabled: entry.rankingEnabled === true,
            acceptanceRateWeight: weight(entry.acceptanceRateWeight),
            cancellationRateWeight: weight(entry.cancellationRateWeight),
            newDriverExposureKm: weight(entry.newDriverExposureKm),
            source: 'market',
        };
    }
    return {
        rankingEnabled: platformRankingFlag,
        acceptanceRateWeight: weight(tenantWeights?.acceptanceRateWeight),
        cancellationRateWeight: weight(tenantWeights?.cancellationRateWeight),
        newDriverExposureKm: weight(tenantWeights?.newDriverExposureKm),
        source: 'tenant',
    };
}
