import { supabaseAdmin } from './supabase.service';

/** Payment-account state consumed by DriverRequirementService.resolve (payout.payment_account). */
export interface DriverPaymentAccountStatus {
  provider: string | null;
  state: 'completed' | 'not_started' | 'in_progress' | 'action_required' | 'reconciliation_required' | 'unavailable';
  available: boolean;
  reason: string | null;
}

/**
 * Verified payment-account state for one driver (moved unchanged from driver-onboarding.routes so every
 * requirement evaluation uses the same authority — onboarding, going online, admin approval).
 * Never trusts a client flag. GB is evaluated by the existing Stripe authority; every other market by the
 * configured payout provider (`setup`). A missing provider, table or configuration fails closed as
 * `unavailable`. Note: the GB path asks Stripe for the connected account, so it is for one driver at a
 * time — not for bulk candidate filtering (dispatch defers payout readiness to acquisition instead).
 */
export async function verifiedPaymentAccount(driverId: string, setup?: { status: (id: string) => Promise<any> }): Promise<DriverPaymentAccountStatus> {
  try {
    if (setup) { const verified = await setup.status(driverId); if (verified.provider !== 'stripe') return { ...verified, reason: null }; }
    const profile = await supabaseAdmin.from('profiles').select('role,registration_country_code,country_code').eq('id', driverId).single();
    if (profile.error || profile.data?.role !== 'driver' || String(profile.data.registration_country_code || profile.data.country_code).toUpperCase() !== 'GB')
      return { provider: null, state: 'unavailable', available: false, reason: null };
    // Reuse the deployed Stripe authority, not a new Connect implementation or the Flutterwave sandbox
    // runtime. It verifies actual charges/payouts flags.
    const { PayoutEligibilityService } = await import('./payout-eligibility.service');
    const eligibility = await PayoutEligibilityService.evaluateDriver(driverId);
    return { provider: 'stripe', state: eligibility.eligible ? 'completed' : eligibility.code === 'NO_STRIPE_ACCOUNT' ? 'not_started' : 'action_required', available: true, reason: null };
  } catch {
    return { provider: null, state: 'unavailable', available: false, reason: null };
  }
}
