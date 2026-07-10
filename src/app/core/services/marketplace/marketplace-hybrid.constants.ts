export const HYBRID_MARKETPLACE_ENABLED = false;

// Rollout configuration until the DB-backed settings are available.
export const HYBRID_ELIGIBLE_SERVICES: string[] = ['shop', 'errand', 'shopping', 'van', 'van_moving', 'delivery'];
export const HYBRID_MAX_ROUNDS = 5;
export const HYBRID_NEGOTIATION_TIMEOUT_SECONDS = 120;
export const HYBRID_MAX_DRIVER_ATTEMPTS = 10;
export const HYBRID_LONG_DISTANCE_RIDE_KM = 25;

// TODO: Replace HYBRID_MARKETPLACE_ENABLED and the rollout constants with the DB-backed
// marketplace_hybrid_negotiation_enabled flag and per-service thresholds once the migration folder
// is accessible. They should be read from system_configs or marketplace_settings and default to false.
