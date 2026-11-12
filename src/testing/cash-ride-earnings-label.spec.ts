import { describe, expect, it } from 'vitest';
import { recordedPayoutLabel } from '../app/shared/utils/earnings-currency';

describe('driver earnings label for cash rides', () => {
  it('a cash ride shows cash collected, never a payout or transfer', () => {
    expect(recordedPayoutLabel({ status: 'paid', settlement_purpose: 'cash_ride', stripe_transfer_id: null })).toBe('Cash collected · no payout');
  });
  it('card/wallet rows keep their existing labels', () => {
    expect(recordedPayoutLabel({ status: 'paid', settlement_purpose: 'job_earnings', stripe_transfer_id: 'tr_1' })).toBe('Transferred to Stripe account');
    expect(recordedPayoutLabel({ status: 'pending', settlement_purpose: 'job_earnings' })).toBe('Pending payout');
    expect(recordedPayoutLabel({ status: 'paid' })).toBe('Paid (recorded)');
  });
});
