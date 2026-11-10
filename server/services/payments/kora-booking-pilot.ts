import { createHash } from 'node:crypto';
import { KoraSandbox, KoraDbAttempts, koraNgnMinor, type KoraExpectedPayment, type KoraCheckoutInput } from './kora-sandbox';
import { SandboxSessionError, sandboxConfig, type SandboxConfig } from './kora-sandbox-session';
import { PaymentAuthorityService } from '../payment-authority.service';

export const PILOT_BOOKING_FIELDS = Object.freeze(['id','customer_id','status','country_code','currency_code',
  'service_type_id','payment_method','payment_status','payment_intent_id','driver_id','agreed_fare',
  'price','estimated_price','total_price','quote_id','fare_breakdown']);
export function pilotBookingSnapshot(job: any): Record<string, unknown> {
  return Object.fromEntries(PILOT_BOOKING_FIELDS.map(key => [key, job[key] ?? null]));
}
function canonical(value: any): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k)+':'+canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
export interface KoraBookingRow {
  job_id: string; user_id: string; reference: string; merchant_account_ref: string;
  currency: 'NGN'; amount_minor: number; booking_snapshot: Record<string, unknown>;
  state: 'started'|'submitted'|'unknown'|'verified'|'requires_refund'|'refunded'; checkout_url: string|null;
  refund_reference: string|null; refund_state: 'none'|'started'|'processing'|'unknown'|'success'|'failed';
}
export interface KoraBookingStore {
  job(jobId: string): Promise<any>;
  find(jobId: string): Promise<KoraBookingRow|null>;
  findReference(reference: string, refund: boolean): Promise<KoraBookingRow|null>;
  reserve(row: KoraBookingRow): Promise<{created: boolean; payment: KoraBookingRow}>;
  submitted(jobId: string, userId: string, account: string, state: 'submitted'|'unknown', url?: string): Promise<void>;
  confirm(jobId: string, userId: string, account: string): Promise<KoraBookingRow>;
  claimRefund(jobId: string, userId: string, account: string, reference: string): Promise<{claimed: boolean; payment: KoraBookingRow}>;
  refundState(jobId: string, userId: string, account: string, state: 'processing'|'unknown'|'success'|'failed'): Promise<KoraBookingRow>;
}
export interface KoraBookingClient {
  createCheckout(input: KoraCheckoutInput): Promise<{checkoutUrl: string}>;
  verify(input: KoraExpectedPayment): Promise<unknown>;
  initiateRefund(input: KoraExpectedPayment & {refundReference: string; completionStatus: 'success'|'failed'; webhookUrl?: string}): Promise<unknown>;
  verifyRefund(input: KoraExpectedPayment & {refundReference: string}): Promise<{state: 'processing'|'success'|'failed'}>;
  authenticWebhook(data: unknown, signature: unknown): boolean;
}
export interface KoraBookingConfig extends SandboxConfig {bookingEnabled: boolean;}
function checkoutUrl(value: string): string {
  const u = new URL(value);
  if (u.protocol !== 'https:' || u.username || u.password || u.port ||
      !['checkout.korapay.com','test-checkout.korapay.com'].includes(u.hostname))
    throw new SandboxSessionError(409, 'BOOKING_PAYMENT_RECONCILIATION_REQUIRED');
  return u.href;
}
/** Explicitly enrolled, completed sandbox rides only. Never writes jobs, payouts or wallets. */
export class KoraBookingPilot {
  constructor(private readonly config: KoraBookingConfig, private readonly store: KoraBookingStore,
    private readonly client: KoraBookingClient,
    private readonly payable: (job: any) => Promise<{totalAuthorisationMajor: number; itemBudgetMajor: number; currency: string}>) {}
  private guard(userId?: string): void {
    if (!this.config.bookingEnabled || !this.config.enabled || this.config.production || !this.config.account ||
        !/^sk_test_[A-Za-z0-9_-]+$/.test(this.config.key)) throw new SandboxSessionError(404, 'BOOKING_PILOT_UNAVAILABLE');
    if (userId !== undefined && !this.config.userIds.includes(userId)) throw new SandboxSessionError(403, 'SANDBOX_USER_NOT_ALLOWED');
  }
  private async owned(userId: string, jobId: string): Promise<KoraBookingRow> {
    this.guard(userId);
    const row = await this.store.find(jobId);
    if (!row || row.user_id !== userId) throw new SandboxSessionError(404, 'BOOKING_PAYMENT_NOT_FOUND');
    if (row.merchant_account_ref !== this.config.account || row.currency !== 'NGN')
      throw new SandboxSessionError(409, 'BOOKING_PAYMENT_ACCOUNT_MISMATCH');
    return row;
  }
  private expected(row: KoraBookingRow): KoraExpectedPayment {
    return {reference: row.reference, merchantAccountRef: row.merchant_account_ref,
      currency: row.currency, amountMinor: row.amount_minor};
  }
  private present(row: KoraBookingRow) {
    return {bookingId: row.job_id, provider: 'kora', reference: row.reference, currency: row.currency,
      amountMinor: row.amount_minor, paymentState: row.state, refundState: row.refund_state,
      sandbox: true, operationalBookingUpdated: false, driverPayoutEnabled: false};
  }
  async create(userId: string, email: string, jobId: string) {
    this.guard(userId);
    const job = await this.store.job(jobId);
    if (!job || job.customer_id !== userId) throw new SandboxSessionError(404, 'BOOKING_NOT_FOUND');
    const service = Array.isArray(job.service_type) ? job.service_type[0] : job.service_type;
    if (job.status !== 'completed' || job.country_code !== 'NG' || job.currency_code !== 'NGN' ||
        service?.slug !== 'ride' || job.payment_intent_id || job.payment_method === 'wallet' ||
        !['pending','unpaid'].includes(String(job.payment_status || '')) ||
        job.fare_breakdown?.policyVersion !== 'fare-split-v1')
      throw new SandboxSessionError(409, 'COMPLETED_UNPAID_ENROLLED_SANDBOX_RIDE_REQUIRED');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new SandboxSessionError(400, 'CUSTOMER_EMAIL_REQUIRED');
    const payable = await this.payable(job);
    if (payable.currency.toUpperCase() !== 'NGN' || payable.itemBudgetMajor !== 0)
      throw new SandboxSessionError(409, 'BOOKING_PAYMENT_TERMS_MISMATCH');
    const amount = koraNgnMinor(payable.totalAuthorisationMajor);
    if (amount < 10000 || koraNgnMinor(job.fare_breakdown.customerCharge) !== amount)
      throw new SandboxSessionError(409, 'REFUNDABLE_NGN_FARE_REQUIRED');
    const reference = 'vaydu-book-' + createHash('sha256').update(JSON.stringify([userId,jobId])).digest('hex').slice(0,32);
    const row: KoraBookingRow = {job_id: jobId, user_id: userId, reference, merchant_account_ref: this.config.account,
      currency: 'NGN', amount_minor: amount, booking_snapshot: pilotBookingSnapshot(job), state: 'started',
      checkout_url: null, refund_reference: null, refund_state: 'none'};
    const reserved = await this.store.reserve(row);
    const existing = reserved.payment;
    if (existing.user_id !== userId || existing.merchant_account_ref !== this.config.account ||
        existing.reference !== reference || existing.amount_minor !== amount ||
        canonical(existing.booking_snapshot) !== canonical(row.booking_snapshot))
      throw new SandboxSessionError(409, 'BOOKING_PAYMENT_BINDING_MISMATCH');
    if (!reserved.created) {
      if (existing.state === 'submitted' && existing.checkout_url)
        return {...this.present(existing), checkoutUrl: checkoutUrl(existing.checkout_url)};
      if (['verified','requires_refund','refunded'].includes(existing.state)) return this.present(existing);
      throw new SandboxSessionError(409, 'BOOKING_PAYMENT_RECONCILIATION_REQUIRED');
    }
    try {
      const result = await this.client.createCheckout({...this.expected(row), email, methods: ['card'],
        redirectUrl: this.config.returnUrl, notificationUrl: this.config.notificationUrl || undefined});
      const url = checkoutUrl(result.checkoutUrl);
      await this.store.submitted(jobId,userId,this.config.account,'submitted',url);
      return {...this.present({...row,state:'submitted'}),checkoutUrl:url};
    } catch {
      await this.store.submitted(jobId,userId,this.config.account,'unknown');
      throw new SandboxSessionError(409, 'BOOKING_PAYMENT_RECONCILIATION_REQUIRED');
    }
  }
  async verify(userId: string, jobId: string) {
    const row = await this.owned(userId,jobId);
    if (row.refund_state !== 'none') return this.present(row);
    await this.client.verify(this.expected(row));
    const confirmed = await this.store.confirm(jobId,userId,this.config.account);
    // Database rechecks the locked booking after the provider round-trip. Never activate stale terms.
    if (confirmed.state === 'requires_refund') return this.refund(userId,jobId,'success');
    return this.present(confirmed);
  }
  async refund(userId: string, jobId: string, completionStatus: 'success'|'failed') {
    const row = await this.owned(userId,jobId);
    if (!['verified','requires_refund','refunded'].includes(row.state))
      throw new SandboxSessionError(409, 'VERIFIED_BOOKING_PAYMENT_REQUIRED');
    const ref = 'vaydu-refund-' + createHash('sha256').update(JSON.stringify([row.reference,'full-refund'])).digest('hex').slice(0,32);
    const claim = await this.store.claimRefund(jobId,userId,this.config.account,ref);
    if (!claim.claimed) return this.present(claim.payment);
    try {
      await this.client.initiateRefund({...this.expected(row),refundReference:ref,completionStatus,webhookUrl:this.config.notificationUrl||undefined});
      return this.present(await this.store.refundState(jobId,userId,this.config.account,'processing'));
    } catch {
      await this.store.refundState(jobId,userId,this.config.account,'unknown');
      throw new SandboxSessionError(409, 'BOOKING_REFUND_RECONCILIATION_REQUIRED');
    }
  }
  async webhook(data: unknown, signature: unknown) {
    this.guard();
    if (!this.client.authenticWebhook(data,signature)) throw new SandboxSessionError(401,'INVALID_SANDBOX_SIGNATURE');
    const reference = (data as {reference?: unknown})?.reference;
    if (typeof reference !== 'string' || !/^vaydu-(book|refund)-[a-f0-9]{32}$/.test(reference))
      throw new SandboxSessionError(400,'INVALID_BOOKING_PILOT_REFERENCE');
    const refund = reference.startsWith('vaydu-refund-');
    const row = await this.store.findReference(reference,refund);
    if (!row) throw new SandboxSessionError(404,'BOOKING_PAYMENT_NOT_FOUND');
    // Only stored references choose the operation; unsigned event names are ignored.
    return refund ? this.verifyRefund(row.user_id,row.job_id) : this.verify(row.user_id,row.job_id);
  }
  async verifyRefund(userId: string, jobId: string) {
    const row = await this.owned(userId,jobId);
    if (!row.refund_reference || row.refund_state === 'none')
      throw new SandboxSessionError(409, 'BOOKING_REFUND_NOT_STARTED');
    const result = await this.client.verifyRefund({...this.expected(row),refundReference:row.refund_reference});
    return this.present(await this.store.refundState(jobId,userId,this.config.account,result.state));
  }
}
export class KoraBookingDbStore implements KoraBookingStore {
  constructor(private readonly db: any) {}
  private async rpc(name: string, args: Record<string,unknown>): Promise<any> {
    const result = await this.db.rpc(name,args);
    if (result.error || !result.data) throw new SandboxSessionError(409,'BOOKING_PILOT_DATABASE_REJECTED');
    return result.data;
  }
  async job(id: string) {
    const r = await this.db.from('jobs').select('*,service_type:service_types(*)').eq('id',id).maybeSingle();
    if (r.error) throw new SandboxSessionError(503,'BOOKING_LOOKUP_UNAVAILABLE');return r.data;
  }
  async find(id: string): Promise<KoraBookingRow|null> {
    const r = await this.db.from('kora_sandbox_booking_payments').select('*').eq('job_id',id).maybeSingle();
    if (r.error) throw new SandboxSessionError(503,'BOOKING_PAYMENT_LOOKUP_UNAVAILABLE');return r.data;
  }
  async findReference(reference: string, refund: boolean): Promise<KoraBookingRow|null> {
    const r = await this.db.from('kora_sandbox_booking_payments').select('*')
      .eq(refund?'refund_reference':'reference',reference).maybeSingle();
    if (r.error) throw new SandboxSessionError(503,'BOOKING_PAYMENT_LOOKUP_UNAVAILABLE');return r.data;
  }
  reserve(row: KoraBookingRow) {return this.rpc('reserve_kora_sandbox_booking',{p_row:row});}
  async submitted(id: string,user: string,account: string,state: 'submitted'|'unknown',url?: string) {
    await this.rpc('finish_kora_sandbox_booking_checkout',{p_job:id,p_user:user,p_account:account,p_state:state,p_url:url||null});
  }
  confirm(id: string,user: string,account: string): Promise<KoraBookingRow> {
    return this.rpc('confirm_kora_sandbox_booking',{p_job:id,p_user:user,p_account:account});
  }
  claimRefund(id: string,user: string,account: string,reference: string) {
    return this.rpc('claim_kora_sandbox_booking_refund',{p_job:id,p_user:user,p_account:account,p_reference:reference});
  }
  refundState(id: string,user: string,account: string,state: 'processing'|'unknown'|'success'|'failed'): Promise<KoraBookingRow> {
    return this.rpc('finish_kora_sandbox_booking_refund',{p_job:id,p_user:user,p_account:account,p_state:state});
  }
}
export function createKoraBookingPilot(db: any, env: NodeJS.ProcessEnv): KoraBookingPilot {
  const config = {...sandboxConfig(env), bookingEnabled:env.VAYDU_KORA_BOOKING_PILOT==='true'};
  return new KoraBookingPilot(config,new KoraBookingDbStore(db),
    new KoraSandbox(config.key,config.account,new KoraDbAttempts(db)),job=>PaymentAuthorityService.resolve(job));
}
