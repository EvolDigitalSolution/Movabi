// Default fallback values for the hybrid marketplace.
// These are overridden by DB-backed marketplace_settings.hybrid_negotiation values.
export const DEFAULT_HYBRID_ENABLED = false;
export const DEFAULT_HYBRID_ENABLED_SERVICES: string[] = ['shop', 'errand'];
export const DEFAULT_HYBRID_MAX_ROUNDS = 5;
export const DEFAULT_HYBRID_TIMEOUT_SECONDS = 120;
export const DEFAULT_HYBRID_CLAIM_TIMEOUT_SECONDS = 120;
export const DEFAULT_HYBRID_MAX_DRIVER_ATTEMPTS = 10;
export const DEFAULT_HYBRID_RIDE_MINIMUM_KM = 25;
export const DEFAULT_HYBRID_MAKE_OFFER_ENABLED = true;
export const DEFAULT_HYBRID_ACCEPT_FARE_ENABLED = true;

// Allowlist fallback. While global hybrid is disabled, users in this list can still
// access the hybrid flow. Keep it empty for normal operation; use the Admin Test
// Allowlist as the primary source. Populate here only if DB settings fail to load.
export const DEFAULT_HYBRID_ALLOWLIST: string[] = [];

// TODO: Remove this file once all callers use MarketplaceConfigService.settingsSignal().hybridNegotiation.
