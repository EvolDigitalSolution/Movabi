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

  /** Full authoritative payable (fare + errand item budget) for a job. */
  static async resolve(job: any): Promise<AuthoritativePayable> {
    const serviceFareMajor = this.authoritativeServiceFare(job);

    let itemBudgetMajor = 0;
    if (this.isErrand(job)) {
      const [{ data: funding }, { data: details }] = await Promise.all([
        supabaseAdmin.from('errand_funding').select('amount_reserved').eq('job_id', job.id).maybeSingle(),
        supabaseAdmin.from('errand_details').select('estimated_budget').eq('job_id', job.id).maybeSingle()
      ]);
      itemBudgetMajor = money(funding?.amount_reserved) || money(details?.estimated_budget) || 0;
    }

    return {
      serviceFareMajor,
      itemBudgetMajor,
      totalAuthorisationMajor: Number((serviceFareMajor + itemBudgetMajor).toFixed(2)),
      currency: this.currency(job.currency_code)
    };
  }
}
