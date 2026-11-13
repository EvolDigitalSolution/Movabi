import { describe, expect, it } from 'vitest';
import { bookingPinMetadata, effectivePinPolicy, marketPinPolicy } from '../../server/services/completion-pin-policy';

/** Area 3 (2026-11-13): market-isolated default, driver override precedence, fail closed. */
describe('completion PIN market policy', () => {
  it('no setting: required everywhere (current platform default)', () => {
    expect(marketPinPolicy(null, 'GB')).toBe('required');
    expect(marketPinPolicy(undefined, 'NG')).toBe('required');
  });
  it('legacy {enabled:false} disables every market of that tenant', () => {
    expect(marketPinPolicy({ enabled: false }, 'GB')).toBe('disabled');
    expect(marketPinPolicy({ enabled: true }, 'GB')).toBe('required');
  });
  it('a market entry applies only to that market; others use the default', () => {
    const s = { default: 'required', markets: { GB: 'optional', NG: 'disabled' } };
    expect(marketPinPolicy(s, 'GB')).toBe('optional');
    expect(marketPinPolicy(s, 'gb')).toBe('optional');
    expect(marketPinPolicy(s, 'NG')).toBe('disabled');
    expect(marketPinPolicy(s, 'KE')).toBe('required');
    expect(marketPinPolicy({ markets: { NG: 'disabled' } }, 'GB')).toBe('required');
  });
  it('unreadable values fail closed to required', () => {
    expect(marketPinPolicy({ markets: { GB: 'sometimes' } }, 'GB')).toBe('required');
    expect(marketPinPolicy({ default: 42 }, 'GB')).toBe('required');
    expect(marketPinPolicy('off', 'GB')).toBe('required');
  });
  it('booking metadata records the market policy and the flag both apps read', () => {
    expect(bookingPinMetadata('optional')).toEqual({ completion_pin_market_policy: 'optional', completion_pin_required: true, completion_pin_policy_version: 'backend-v2' });
    expect(bookingPinMetadata('disabled').completion_pin_required).toBe(false);
  });
});

describe('effective completion PIN policy', () => {
  const job = (metadata: any, driver = 'd1') => ({ driver_id: driver, metadata });
  it('the value frozen for the current driver wins', () => {
    expect(effectivePinPolicy(job({ completion_pin_effective: 'disabled', completion_pin_driver_id: 'd1' }), 'required')).toBe('disabled');
  });
  it('a value frozen for a previous driver is ignored', () => {
    expect(effectivePinPolicy(job({ completion_pin_effective: 'disabled', completion_pin_driver_id: 'd0', completion_pin_market_policy: 'required' }), null)).toBe('required');
  });
  it('override, then market policy, then the legacy flag', () => {
    expect(effectivePinPolicy(job({ completion_pin_market_policy: 'disabled' }), 'optional')).toBe('optional');
    expect(effectivePinPolicy(job({ completion_pin_market_policy: 'optional' }), null)).toBe('optional');
    expect(effectivePinPolicy(job({ completion_pin_required: false }), null)).toBe('disabled');
    expect(effectivePinPolicy(job({}), null)).toBe('required');
  });
  it('an override that could not be read never relaxes the check', () => {
    expect(effectivePinPolicy(job({ completion_pin_market_policy: 'disabled' }), null, true)).toBe('required');
  });
});
