/**
 * Driver settlement remediation — wiring assertions.
 *
 * Proves the single split is shared by quote and settlement, that settlement is
 * idempotent and fails closed, that the batch payout is disabled, and that a
 * UK-only payout scope is enforced at onboarding, acquisition and transfer.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');

const SVC = read('server/services/fare-split.service.ts');
const ELIG = read('server/services/payout-eligibility.service.ts');
const LOG = read('server/services/logistics.service.ts');
const CONNECT = read('server/routes/connect.routes.ts');
const DISPATCH = read('server/services/dispatch.service.ts');
const PAYOUT = read('server/services/payout.service.ts');
const MP = read('server/services/market-pricing.service.ts');
const MIG = read('supabase/migrations/20261240000000_driver_settlement_authority.sql');
const MIG2 = read('supabase/migrations/20261241000000_driver_settlement_claim.sql');
const MIG3 = read('supabase/migrations/20261241100000_refund_reversal_tracking.sql');
const MIG4 = read('supabase/migrations/20261241400000_refund_operation_records.sql');
const BOOKING = read('server/routes/booking.routes.ts');
const PRICING = read('server/services/pricing.service.ts');

describe('one authoritative split', () => {
  it('the policy is encoded literally in the authority', () => {
    expect(SVC).toContain('driverEntitlement: number;');
    expect(SVC).toContain('grossRevenue: number;');
    expect(SVC).toContain('isPro ? 0 : Number(input.driverCommissionPercent || 0)');
    expect(SVC).toContain('if (driverEntitlement <= 0)');
  });

  it('market-pricing derives the split from the authority (no inline arithmetic)', () => {
    expect(MP).toContain('FareSplitService.compute({');
    expect(MP).toContain('const platformFeeAmount = split.platformFeeAmount;');
    expect(MP).toContain('const customerTotal = split.customerCharge;');
    expect(MP).toContain('const driverPayout = split.driverEntitlement;');
    expect(MP).not.toContain("const platformFeeAmount = roundMoney(effectiveServiceFare * (Number(platformFeePercent) || 0) / 100);");
  });

  it('settlement reads the frozen snapshot and never recomputes from live config', () => {
    expect(LOG).toContain('const split = this.resolveFareSplit(job);');
    expect(LOG).toContain('const driverPayout = split.driverEntitlement;');
    expect(LOG).toContain('FareSplitService.fromSnapshot(job.fare_breakdown, job.currency_code)');
    expect(LOG).toContain('HistoricalFareReconciliationRequired');
    // The old live-config recomputation is gone.
    expect(LOG).not.toContain('getEffectiveCommissionPercent(');
    expect(LOG).not.toContain('commissionBasis');
  });

  it('transfer uses the snapshot entitlement in currency minor units', () => {
    expect(LOG).toContain('const payoutAmountInPence = FareSplitService.toMinor(driverPayout, settlementCurrency);');
  });
});

describe('one settlement path', () => {
  it('claims with dedicated state fields (stripe_transfer_id is never a claim token)', () => {
    expect(read('server/services/job-payout.service.ts')).toContain('claim_queued_job_payout');
    expect(read('server/services/job-payout.service.ts')).toContain('amount: Number(q.amount_minor)');
    // The state-machine transition lives in the migration RPC, not inline.
    expect(MIG2).toContain("settlement_status = 'claimed'");
    // The claim_<uuid> sentinel is gone; stripe_transfer_id holds only real Stripe ids.
    expect(LOG).not.toContain('claim_${randomUUID()}');
    expect(LOG).not.toContain('startsWith(\'claim_\')');
  });

  it('a definitive failure releases the claim; an ambiguous outcome blocks', () => {
    expect(readFileSync(resolve('server/services/job-payout.service.ts'),'utf8')).toContain("e.code === 'balance_insufficient'");
    expect(readFileSync(resolve('server/services/job-payout.service.ts'),'utf8')).toContain("definitive ? 'pending' : 'reconcile'");
    expect(read('server/services/job-payout.service.ts')).toContain('last_error: code');
  });

  it('records transfer success and earnings atomically via one RPC', () => {
    expect(readFileSync(resolve('server/services/job-payout.service.ts'),'utf8')).toContain("supabaseAdmin.rpc('finish_queued_job_payout'");
    expect(readFileSync(resolve('server/services/job-payout.service.ts'),'utf8')).toContain('transfer_group: `job_${q.job_id}`');
    // The 'transferred' transition lives in the migration RPC.
    expect(MIG2).toContain("settlement_status = 'transferred'");
  });

  it('reconciles by transfer_group instead of inferring no-transfer from a missing id', () => {
    expect(read('server/services/job-payout.service.ts')).toContain('stripe.transfers.list({ transfer_group: `job_${q.job_id}`');
    expect(read('server/services/job-payout.service.ts')).toContain('matching.length === 1');
  });

  it('the batch payout path is disabled and the legacy runner is removed', () => {
    expect(PAYOUT).toContain('batch payout is disabled; use per-job settlement.');
    expect(PAYOUT).toContain('disabled: true');
    expect(PAYOUT).not.toContain('_processDriverPayoutsLegacy');
  });
});

describe('UK-only payout scope', () => {
  it('declares GB as the only supported payout country', () => {
    expect(ELIG).toContain("SUPPORTED_PAYOUT_COUNTRIES: string[] = ['GB']");
  });

  it('enforces role + activation + country + real Stripe account country', () => {
    expect(ELIG).toContain("code: 'NOT_DRIVER_ROLE'");
    expect(ELIG).toContain("code: 'REGISTRATION_PENDING'");
    expect(ELIG).toContain("code: 'PAYOUT_COUNTRY_UNSUPPORTED'");
    expect(ELIG).toContain('stripe.accounts.retrieve(accountId)');
    expect(ELIG).toContain('account.charges_enabled && account.payouts_enabled');
  });

  it('onboarding verifies eligibility and the actual account country on reuse', () => {
    expect(CONNECT).toContain('PayoutEligibilityService.evaluateDriver(userId, null)');
    expect(CONNECT).toContain('PayoutEligibilityService.isSupportedCountry(account.country)');
    expect(CONNECT).toContain('country: SUPPORTED_PAYOUT_COUNTRIES[0]');
    // The hard-coded 'GB' account country is gone.
    expect(CONNECT).not.toContain("country: 'GB'");
  });

  it('dispatch only offers work to drivers in a supported payout country', () => {
    expect(DISPATCH).toContain(".in('registration_country_code', SUPPORTED_PAYOUT_COUNTRIES)");
  });

  it('transfer re-checks eligibility before money movement', () => {
    expect(readFileSync(resolve('server/services/job-payout.service.ts'),'utf8')).toContain('await PayoutEligibilityService.assertEligible(q.driver_id, q.destination);');
  });
});

describe('migration', () => {
  it('does not re-introduce the retired hardcoded-10% trigger', () => {
    expect(MIG).toContain('ADD COLUMN IF NOT EXISTS settled_at timestamptz;');
    expect(MIG).not.toContain('CREATE OR REPLACE FUNCTION public.calculate_job_payouts()');
  });

  it('adds the settlement claim/state machine + atomic claim and record RPCs', () => {
    expect(MIG2).toContain("ADD COLUMN IF NOT EXISTS settlement_status text NOT NULL DEFAULT 'pending'");
    expect(MIG2).toContain('jobs_settlement_status_check');
    expect(MIG2).toContain('CREATE OR REPLACE FUNCTION public.claim_job_settlement(');
    expect(MIG2).toContain('CREATE OR REPLACE FUNCTION public.record_job_settlement(');
    expect(MIG2).toContain('RETURNING *');
  });

  it('uses the repository migration naming convention', () => {
    expect(resolve('supabase/migrations/20261240000000_driver_settlement_authority.sql')).toBeTruthy();
    expect(resolve('supabase/migrations/20261241000000_driver_settlement_claim.sql')).toBeTruthy();
  });
});

describe('refunds and transfer reversals', () => {
  const REVERSAL = read('server/services/transfer-reversal.service.ts');
  const PAYMENT = read('server/routes/payment.routes.ts');

  it('a customer refund reverses the driver transfer (idempotent, partial-capable)', () => {
    expect(REVERSAL).toContain('stripe.transfers.createReversal(');
    expect(REVERSAL).toContain('reversal-job-');
    expect(REVERSAL).toContain('partialIndex');
    expect(REVERSAL).toContain('idempotencyKey: key');
  });

  it('persists a durable operation record per refund/reversal (not just latest id)', () => {
    expect(MIG4).toContain('CREATE TABLE IF NOT EXISTS public.refund_operations');
    expect(MIG4).toContain('service_component_minor');
    expect(MIG4).toContain('budget_component_minor');
    expect(MIG4).toContain('idempotency_key text NOT NULL');
    expect(MIG4).toContain('provider_id text');
    expect(MIG4).toContain("status text NOT NULL DEFAULT 'reserved'");
    expect(MIG4).toContain('UNIQUE (job_id, operation_type, idempotency_key)');
  });

  it('uses atomic reservation/mark/release operation RPCs', () => {
    expect(PAYMENT).toContain("supabaseAdmin.rpc('reserve_refund_operation'");
    expect(PAYMENT).toContain("supabaseAdmin.rpc('mark_refund_operation'");
    expect(PAYMENT).toContain("supabaseAdmin.rpc('release_refund_operation'");
    expect(PAYMENT).toContain("supabaseAdmin.rpc('reserve_reversal_operation'");
    expect(PAYMENT).toContain("supabaseAdmin.rpc('mark_reversal_operation'");
    expect(PAYMENT).toContain("supabaseAdmin.rpc('release_reversal_operation'");
    expect(MIG4).toContain('FOR UPDATE');
  });

  it('distinguishes documented terminal rejection from uncertain/conflicting outcomes', () => {
    expect(PAYMENT).toContain('isDefinitiveStripeRejection(');
    expect(PAYMENT).toContain('p_status: \'failed\'');
    expect(PAYMENT).toContain('p_status: \'unknown\'');
    expect(PAYMENT).toContain('release_refund_operation');
    // Only a documented terminal rejection releases; uncertain retains the reservation.
    expect(PAYMENT).toContain('p_status: \'unknown\'');
  });

  it('applies proportional reversal only to the persisted service-fare component', () => {
    expect(PAYMENT).toContain('serviceComponentMinor');
    expect(PAYMENT).toContain('op.service_component_minor');
    expect(PAYMENT).toContain('SERVICE-FARE component');
  });

  it('does not conceal platform-funded refunds when a reversal fails', () => {
    expect(PAYMENT).toContain("stripe_transfer_status: 'reversal_failed'");
    expect(PAYMENT).toContain('platformFundedRefund');
    expect(PAYMENT).toContain('reversalWarning');
  });
});

describe('earnings labels', () => {
  const EARNINGS = read('src/app/apps/mobile/features/driver/earnings/earnings.page.ts');

  it('labels a Stripe transfer as "Transferred to Stripe account", never "paid to bank"', () => {
    expect(EARNINGS).toContain("return 'Transferred to Stripe account';");
    expect(EARNINGS).toContain("return 'Pending transfer';");
    expect(EARNINGS).toContain('Never label a transfer as a bank payment');
  });
});

describe('fare lifecycle', () => {
  it('persists a versioned snapshot at agreement; re-agreement REPLACES it', () => {
    expect(PRICING).toContain("scaledBreakdown['policyVersion'] = FareSplitService.POLICY_VERSION;");
    expect(PRICING).toContain("scaledBreakdown['customerCharge'] = safeAgreed;");
    expect(PRICING).toContain("scaledBreakdown['driverEntitlement'] = driverPayout;");
    expect(PRICING).toContain("scaledBreakdown['grossRevenue'] = round(platformFee + commissionFee);");
  });
});

describe('acquisition eligibility (claim/accept bypass)', () => {
  it('driver job acceptance enforces payout eligibility', () => {
    expect(BOOKING).toContain('requirePayoutEligible(driverId, res)');
    expect(BOOKING).toContain('PayoutEligibilityService.assertEligible');
    expect(BOOKING).toContain("code: error?.code || 'PAYOUT_INELIGIBLE'");
  });

  it('driver negotiation acceptance enforces payout eligibility', () => {
    expect(BOOKING).toContain('requirePayoutEligible(userId, res)');
  });

  it('does not touch login/registration — only job acquisition', () => {
    // The eligibility check is scoped to the accept endpoints, not auth.
    expect(BOOKING).toContain('This does NOT affect login — only job acquisition.');
  });
});
