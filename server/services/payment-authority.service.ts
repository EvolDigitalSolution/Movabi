import { FareSplitService } from './fare-split.service';
import { supabaseAdmin } from './supabase.service';

/**
 * C2 — single authoritative payable-amount resolver.
 *
 * ONE source of truth for the money basis shared by create-intent, /payment/confirm,
 * the Stripe authorization/capture webhooks, and the wallet payment path. Do not
 * duplicate subtly different expressions.
 *
 * PROVENANCE RULE
 *   jobs.agreed_fare is trusted ONLY when a server negotiation RPC established it.
 *   That state is exactly `status='fare_agreed'` AND `driver_id IS NOT NULL`: every
 *   hardened agreement RPC (accept_driver_offer, accept_fare_negotiation,
 *   lock_marketplace_fare) sets both atomically, whereas the (former) client
 *   lockAgreedFare set `fare_agreed` WITHOUT a driver. So a forged agreed_fare is
 *   ignored and the server-verified quote fare (total_price/estimated_price/price)
 *   is used. No schema change and no trust of a bare column value.
 */

function money(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Number(n.toFixed(2)) : 0;
}

function canonicalServiceSlug(value: unknown): string {
  const raw = String(value || '').trim().toLowerCase();
  if (['shop', 'shopping', 'errands', 'errand'].includes(raw)) return 'errand';
  if (['courier', 'parcel', 'package', 'package-delivery', 'deliver', 'delivery'].includes(raw)) return 'delivery';
  if (['van', 'moving', 'move', 'van-moving', 'van moving', 'van_moving'].includes(raw)) return 'van-moving';
  if (['ride', 'rides'].includes(raw)) return 'ride';
  return raw;
}

export interface AuthoritativePayable {
  serviceFareMajor: number;
  itemBudgetMajor: number;
  totalAuthorisationMajor: number;
  currency: string;
}

export class PaymentAuthorityService {
  /** Authoritative service fare, applying the fare_agreed + driver_id provenance rule. */
  static authoritativeServiceFare(job: any): number {
    const status = String(job?.status || '').toLowerCase();
    const negotiated = status === 'fare_agreed' && !!job?.driver_id;
    if (negotiated) {
      const agreed = money(job.agreed_fare);
      if (agreed > 0) return agreed;
    }
    return money(job.total_price) || money(job.estimated_price) || money(job.price);
  }

  static isErrand(job: any): boolean {
    const serviceType = Array.isArray(job?.service_type) ? job.service_type[0] : job?.service_type;
    const metadata = (job?.metadata && typeof job.metadata === 'object') ? (job.metadata as Record<string, unknown>) : {};
    return canonicalServiceSlug(
      serviceType?.slug || job?.service_slug || metadata.serviceSlug || metadata.service_slug
    ) === 'errand';
  }

  static currency(value: unknown): string {
    const c = String(value || 'GBP').trim().toLowerCase();
    return c.length >= 3 ? c : 'gbp';
  }

  static minorUnits(major: number): number {
    return Math.round(major * 100);
  }

  /** Payment and completion must use the same persisted money, across all services. */
  static assertFrozenServiceFare(job: any, serviceFare: number): void {
    if (job?.fare_breakdown?.policyVersion !== 'fare-split-v1') return;
    const split = FareSplitService.fromSnapshot(job.fare_breakdown, job.currency_code);
    const minor = (value: number) => FareSplitService.toMinor(value, split.currency);
    if (split.currency !== String(job.currency_code || split.currency).toUpperCase()
      || ![split.customerCharge, split.driverEntitlement, split.platformFeeAmount, split.driverCommissionAmount].every(value => Number.isFinite(value) && value >= 0)
      || split.customerCharge <= 0 || split.driverEntitlement <= 0
      || minor(split.customerCharge) !== minor(serviceFare)
      || Math.abs(minor(split.customerCharge) - minor(split.driverEntitlement)
        - minor(split.platformFeeAmount) - minor(split.driverCommissionAmount)) > 0) {
      throw Object.assign(new Error('Agreed fare snapshot requires reconciliation before payment'), { code: 'PAYMENT_TERMS_RECONCILIATION_REQUIRED' });
    }
  }

  /** Full authoritative payable (fare + errand item budget) for a job. */
  static async resolve(job: any): Promise<AuthoritativePayable> {
    let serviceFareMajor = this.authoritativeServiceFare(job);
    const progressed = ['assigned','accepted','heading_to_pickup','arrived','arrived_at_store',
      'shopping_in_progress','collected','en_route_to_customer','in_progress','delivered','completed','settled'];
    const agreed = money(job.agreed_fare);
    if (agreed > 0 && job.driver_id && progressed.includes(String(job.status || '').toLowerCase())) {
      // A lifecycle transition must not revert a server-agreed fare to the quote.
      // Verify persisted negotiation provenance rather than trusting a bare column.
      const { data: session, error: sessionError } = await supabaseAdmin
        .from('marketplace_negotiation_sessions')
        .select('status,active_driver_id,agreed_fare').eq('job_id',job.id).maybeSingle();
      if (sessionError) throw new Error('Agreed payment terms could not be verified');
      const hybridVerified = session?.status === 'fare_agreed'
        && session.active_driver_id === job.driver_id && money(session.agreed_fare) === agreed;
      if (!hybridVerified) {
        const { data: offers, error: offerError } = await supabaseAdmin.from('fare_negotiations')
          .select('proposed_by,proposed_by_role,amount,status').eq('job_id',job.id).eq('status','accepted');
        if (offerError || !(offers || []).some(offer => ((offer.proposed_by_role === 'driver' && offer.proposed_by === job.driver_id)
          || (offer.proposed_by_role === 'customer' && offer.proposed_by === job.customer_id)) && money(offer.amount) === agreed))
          throw new Error('Agreed payment terms require reconciliation');
      }
      serviceFareMajor = agreed;
    }

    let itemBudgetMajor = 0;
    if (this.isErrand(job)) {
      const [{ data: funding, error: fundingError }, { data: details, error: detailsError }] = await Promise.all([
        supabaseAdmin.from('errand_funding').select('item_budget,amount_reserved,status,metadata').eq('job_id', job.id).maybeSingle(),
        supabaseAdmin.from('errand_details').select('estimated_budget').eq('job_id', job.id).maybeSingle()
      ]);
      if (fundingError || detailsError) throw new Error('Unable to verify the shopping budget');
      // amount_reserved is fare + budget once funded. Never add that total
      // to the fare again; pending legacy rows may still hold just the budget.
      itemBudgetMajor = money(funding?.item_budget) || money(funding?.metadata?.item_budget)
        || money(details?.estimated_budget)
        || (funding?.status === 'pending' ? money(funding?.amount_reserved) : 0);
    }

    this.assertFrozenServiceFare(job, serviceFareMajor);

    return {
      serviceFareMajor,
      itemBudgetMajor,
      totalAuthorisationMajor: Number((serviceFareMajor + itemBudgetMajor).toFixed(2)),
      currency: this.currency(job.currency_code)
    };
  }
}
