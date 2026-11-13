/**
 * Completion PIN policy (area 3, 2026-11-13). Pure: no I/O.
 *
 * Precedence, frozen onto the job when a driver is assigned (DB trigger
 * `stamp_completion_pin_policy`, migration 20261270100000):
 *   1. the assigned driver's override in `driver_pin_policies` for the job's tenant;
 *   2. the market policy recorded on the booking (`metadata.completion_pin_market_policy`),
 *      resolved at booking time from the tenant's `completion_pin_policy` setting for the
 *      booking's country only (markets never borrow each other's policy);
 *   3. the platform default: required.
 *
 * Setting shape (`marketplace_settings.completion_pin_policy`, per tenant):
 *   { "enabled": false }                                       legacy: disabled in every market
 *   { "default": "required", "markets": { "GB": "optional" } } per-market policy
 */
export type PinPolicy = 'required' | 'optional' | 'disabled';
const POLICIES: readonly PinPolicy[] = ['required', 'optional', 'disabled'];
export const isPinPolicy = (v: unknown): v is PinPolicy => typeof v === 'string' && (POLICIES as readonly string[]).includes(v);

/** The booking market's policy. Anything unreadable falls back to `required` (fail closed). */
export function marketPinPolicy(setting: unknown, countryCode: string | null | undefined): PinPolicy {
    if (!setting || typeof setting !== 'object') return 'required';
    const s = setting as Record<string, any>;
    const country = String(countryCode || '').trim().toUpperCase();
    const markets = s.markets && typeof s.markets === 'object' ? s.markets : null;
    if (markets && /^[A-Z]{2}$/.test(country) && country in markets) {
        return isPinPolicy(markets[country]) ? markets[country] : 'required';
    }
    if ('default' in s) return isPinPolicy(s.default) ? s.default : 'required';
    if (s.enabled === false) return 'disabled';
    return 'required';
}

/** Metadata written on the booking at creation (before any driver is assigned). */
export function bookingPinMetadata(policy: PinPolicy) {
    return {
        completion_pin_market_policy: policy,
        completion_pin_required: policy !== 'disabled',
        completion_pin_policy_version: 'backend-v2',
    };
}

/**
 * The policy that applies at completion. The value frozen at assignment wins when it was
 * stamped for the driver now on the job. Older jobs (no stamp) use the driver override read
 * now (`override`), then the booking's market policy. `overrideReadFailed` with a stored PIN
 * fails closed to `required`.
 */
export function effectivePinPolicy(job: { driver_id?: string | null; metadata?: Record<string, any> | null },
    override: unknown, overrideReadFailed = false): PinPolicy {
    const m = job.metadata || {};
    if (isPinPolicy(m.completion_pin_effective) && m.completion_pin_driver_id && m.completion_pin_driver_id === job.driver_id) {
        return m.completion_pin_effective;
    }
    if (isPinPolicy(override)) return override;
    if (overrideReadFailed) return 'required';
    if (isPinPolicy(m.completion_pin_market_policy)) return m.completion_pin_market_policy;
    return m.completion_pin_required === false ? 'disabled' : 'required';
}
