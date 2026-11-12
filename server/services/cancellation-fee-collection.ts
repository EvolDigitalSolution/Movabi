import { ledgerMinorFromStripeApi } from './payments/stripe-currency-amounts';

/** Cancellation fee quote from cancellation_fee_quote (20261268000000), frozen with the cancellation. */
export interface CancellationFeeQuote {
    due: boolean; reasonCode: string; feeMinor: number; currency: string; exponent: number | null;
    policyVersion: number | null; graceSeconds: number | null; graceUntil: string | null; driverAssigned: boolean;
}

/** Normalises a quote; anything malformed means "no fee" (fail closed — a customer is never charged on doubt). */
export function normaliseCancellationFeeQuote(raw: any): CancellationFeeQuote {
    const fee = Number(raw?.feeMinor);
    const exp = raw?.exponent === null || raw?.exponent === undefined ? null : Number(raw.exponent);
    const valid = raw && typeof raw === 'object' && Number.isSafeInteger(fee) && fee >= 0
        && (exp === null || (Number.isInteger(exp) && exp >= 0 && exp <= 4)) && typeof raw.currency === 'string';
    const due = !!(valid && raw.due === true && fee > 0 && exp !== null);
    return {
        due, reasonCode: valid ? String(raw.reasonCode || 'unknown') : 'quote_unavailable', feeMinor: due ? fee : 0,
        currency: valid ? String(raw.currency).toUpperCase() : '', exponent: valid ? exp : null,
        policyVersion: valid && raw.policyVersion != null ? Number(raw.policyVersion) : null,
        graceSeconds: valid && raw.graceSeconds != null ? Number(raw.graceSeconds) : null,
        graceUntil: valid && raw.graceUntil ? String(raw.graceUntil) : null,
        driverAssigned: !!(valid && raw.driverAssigned),
    };
}

/** Merchant/environment identity shared with the webhook so both settle the SAME collection event. */
export const PLATFORM_MERCHANT = 'stripe-platform';

export type CollectionOutcome =
    | { status: 'settled' | 'already_settled' | 'review_required'; receivableId: string; collectedMinor: number }
    | { status: 'not_applicable'; reason: string };

interface Db { from(table: string): any; rpc(fn: string, args: Record<string, unknown>): any; }

/**
 * A cancellation fee taken from the booking's own card authorisation is a provider-confirmed
 * COLLECTION of the customer's cancellation-fee receivable. This books it exactly once:
 *   receivable (idempotent per job + reason; frozen policy version and amount actually collected)
 *   -> settle_cancellation_compensation (driver 80% / platform 20% of the collected amount under the
 *      frozen policy; deduped on provider + merchant + environment + PaymentIntent id).
 * Called by /cancel right after capture and by the Stripe webhook for the same PaymentIntent, so a crash
 * between capture and settlement still converges. Never charges anything itself.
 */
export async function settleCapturedCancellationFee(db: Db, jobId: string, paymentIntent: any, merchantAccountRef = PLATFORM_MERCHANT): Promise<CollectionOutcome> {
    const { data: job, error } = await db.from('jobs')
        .select('id,tenant_id,customer_id,status,payment_intent_id,metadata').eq('id', jobId).maybeSingle();
    if (error) throw new Error('cancellation fee collection: job read failed');
    if (!job) return { status: 'not_applicable', reason: 'job_not_found' };
    if (!['cancelled', 'canceled'].includes(String(job.status))) return { status: 'not_applicable', reason: 'job_not_cancelled' };
    const quote = normaliseCancellationFeeQuote(job.metadata?.cancellation_fee_quote);
    if (!quote.due || quote.exponent === null) return { status: 'not_applicable', reason: 'no_fee_due' };
    if (!paymentIntent || String(paymentIntent.id || '') !== String(job.payment_intent_id || '')) return { status: 'not_applicable', reason: 'other_payment_intent' };
    if (paymentIntent.status !== 'succeeded') return { status: 'not_applicable', reason: 'not_captured' };
    // Facts that make this NOT a fee collection are answered, never thrown (a webhook would otherwise
    // retry forever); only storage failures throw so the caller retries.
    if (String(paymentIntent.currency || '').toUpperCase() !== quote.currency) return { status: 'not_applicable', reason: 'currency_mismatch' };
    let collectedMinor: number;
    try { collectedMinor = ledgerMinorFromStripeApi(Number(paymentIntent.amount_received || 0), quote.currency, quote.exponent); }
    catch { return { status: 'not_applicable', reason: 'amount_precision_review' }; }
    if (collectedMinor <= 0) return { status: 'not_applicable', reason: 'nothing_collected' };
    // More than the frozen fee means the booking was charged before it was cancelled: a refund case.
    if (collectedMinor > quote.feeMinor) return { status: 'not_applicable', reason: 'exceeds_fee' };

    const { data: receivable, error: recError } = await db.rpc('record_customer_receivable', {
        p_tenant: job.tenant_id, p_customer: job.customer_id, p_job: job.id, p_currency: quote.currency,
        p_amount: collectedMinor, p_reason: 'cancellation_fee', p_policy_version: quote.policyVersion });
    if (recError || !receivable?.id) throw new Error('cancellation fee collection: receivable not recorded');

    const { data: settlement, error: settleError } = await db.rpc('settle_cancellation_compensation', {
        p_receivable: receivable.id, p_collected_minor: collectedMinor, p_payment_reference: String(paymentIntent.id),
        p_provider: 'stripe', p_merchant_account_ref: merchantAccountRef, p_environment: paymentIntent.livemode ? 'live' : 'test' });
    if (settleError) throw new Error('cancellation fee collection: settlement failed: ' + settleError.message);
    const status = String(settlement?.status || '');
    if (status !== 'settled' && status !== 'already_settled' && status !== 'review_required') throw new Error('cancellation fee collection: unexpected settlement ' + status);
    return { status, receivableId: String(receivable.id), collectedMinor };
}
