import { createHash } from 'node:crypto';
import { KoraSandbox, KoraDbAttempts, type KoraCheckoutInput, type KoraExpectedPayment } from './kora-sandbox';

export class SandboxSessionError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
export interface SandboxConfig {
  enabled: boolean; production: boolean; key: string; account: string;
  userIds: readonly string[]; returnUrl: string; notificationUrl: string;
}
export interface SandboxRow {
  reference: string; user_id: string; merchant_account_ref: string; currency: 'NGN';
  amount_minor: number; state: 'started' | 'submitted' | 'unknown' | 'verified'; checkout_url: string | null;
}
export interface SandboxSessionStore {
  reserve(row: SandboxRow): Promise<boolean>;
  find(reference: string): Promise<SandboxRow | null>;
  update(reference: string, patch: Partial<Pick<SandboxRow, 'state' | 'checkout_url'>>): Promise<void>;
}
export interface SandboxClient {
  createCheckout(input: KoraCheckoutInput): Promise<{checkoutUrl: string}>;
  verify(input: KoraExpectedPayment): Promise<unknown>;
  authenticWebhook(data: unknown, signature: unknown): boolean;
}
function checkoutUrl(value: string): string {
  const u = new URL(value);
  if (u.protocol !== 'https:' || u.port || u.username || u.password ||
      !['test-checkout.korapay.com', 'checkout.korapay.com'].includes(u.hostname))
    throw new SandboxSessionError(409, 'SANDBOX_RECONCILIATION_REQUIRED');
  return u.href;
}
/** Diagnostic payments only: fixed NGN100; never reads or writes jobs, wallets or earnings. */
export class KoraSandboxSession {
  constructor(private readonly config: SandboxConfig, private readonly store: SandboxSessionStore,
    private readonly client: SandboxClient) {}
  private guard(userId?: string): void {
    if (!this.config.enabled || this.config.production || !this.config.account || !/^sk_test_[A-Za-z0-9_-]+$/.test(this.config.key))
      throw new SandboxSessionError(404, 'SANDBOX_UNAVAILABLE');
    if (userId !== undefined && !this.config.userIds.includes(userId))
      throw new SandboxSessionError(403, 'SANDBOX_USER_NOT_ALLOWED');
  }
  private async owned(userId: string, reference: string): Promise<SandboxRow> {
    this.guard(userId);
    const row = await this.store.find(reference);
    if (!row || row.user_id !== userId) throw new SandboxSessionError(404, 'SANDBOX_PAYMENT_NOT_FOUND');
    if (row.merchant_account_ref !== this.config.account || row.currency !== 'NGN' || row.amount_minor !== 10000)
      throw new SandboxSessionError(409, 'SANDBOX_ACCOUNT_MISMATCH');
    return row;
  }
  async create(userId: string, email: string, requestId: string) {
    this.guard(userId);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId) ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new SandboxSessionError(400, 'INVALID_SANDBOX_REQUEST');
    // Include owner, not just client requestId. Same owner/requestId always maps to one reference.
    const reference = 'vaydu-test-' + createHash('sha256').update(JSON.stringify([userId, requestId.toLowerCase()])).digest('hex').slice(0, 32);
    const row: SandboxRow = {reference, user_id: userId, merchant_account_ref: this.config.account,
      currency: 'NGN', amount_minor: 10000, state: 'started', checkout_url: null};
    if (!await this.store.reserve(row)) {
      const existing = await this.owned(userId, reference);
      if (existing.state === 'submitted' && existing.checkout_url)
        return {provider: 'kora', reference, currency: 'NGN', amountMinor: 10000,
          state: 'processing', checkoutUrl: checkoutUrl(existing.checkout_url), sandbox: true};
      if (existing.state === 'verified') return {provider: 'kora', reference, state: 'verified', sandbox: true};
      throw new SandboxSessionError(409, 'SANDBOX_RECONCILIATION_REQUIRED');
    }
    try {
      const result = await this.client.createCheckout({reference, merchantAccountRef: row.merchant_account_ref,
        currency: 'NGN', amountMinor: row.amount_minor, email, methods: ['card'],
        redirectUrl: this.config.returnUrl, notificationUrl: this.config.notificationUrl});
      const url = checkoutUrl(result.checkoutUrl);
      await this.store.update(reference, {state: 'submitted', checkout_url: url});
      return {provider: 'kora', reference, currency: 'NGN', amountMinor: 10000,
        state: 'processing', checkoutUrl: url, sandbox: true};
    } catch {
      await this.store.update(reference, {state: 'unknown', checkout_url: null});
      throw new SandboxSessionError(409, 'SANDBOX_RECONCILIATION_REQUIRED');
    }
  }
  async verify(userId: string, reference: string) {
    const row = await this.owned(userId, reference);
    await this.client.verify({reference: row.reference, merchantAccountRef: row.merchant_account_ref,
      currency: row.currency, amountMinor: row.amount_minor});
    await this.store.update(reference, {state: 'verified'});
    return {provider: 'kora', reference, currency: row.currency, amountMinor: row.amount_minor,
      state: 'verified', sandbox: true, bookingUpdated: false};
  }
  async webhook(data: unknown, signature: unknown) {
    this.guard();
    if (!this.client.authenticWebhook(data, signature)) throw new SandboxSessionError(401, 'INVALID_SANDBOX_SIGNATURE');
    const reference = (data as {reference?: unknown}).reference;
    if (typeof reference !== 'string' || !/^vaydu-(test-[a-f0-9]{32}|kora-test-[a-f0-9]{64})$/.test(reference))
      throw new SandboxSessionError(400, 'INVALID_SANDBOX_REFERENCE');
    const row = await this.store.find(reference);
    if (!row) throw new SandboxSessionError(404, 'SANDBOX_PAYMENT_NOT_FOUND');
    // Event name and webhook amounts are not authority; re-query stored account/terms.
    return this.verify(row.user_id, reference);
  }
}
export class KoraSandboxDbSessions implements SandboxSessionStore {
  constructor(private readonly db: any) {}
  async reserve(row: SandboxRow): Promise<boolean> {
    const result = await this.db.from('kora_sandbox_sessions').insert(row);
    if (result.error?.code === '23505') return false;
    if (result.error) throw new SandboxSessionError(503, 'SANDBOX_STORE_UNAVAILABLE');
    return true;
  }
  async find(reference: string): Promise<SandboxRow | null> {
    const result = await this.db.from('kora_sandbox_sessions').select('*').eq('reference', reference).maybeSingle();
    if (result.error) throw new SandboxSessionError(503, 'SANDBOX_STORE_UNAVAILABLE');
    return result.data;
  }
  async update(reference: string, patch: Partial<Pick<SandboxRow, 'state' | 'checkout_url'>>): Promise<void> {
    // A delayed initialize/timeout must never downgrade a verified session.
    const result = await this.db.from('kora_sandbox_sessions').update(patch).eq('reference', reference)
      .neq('state', 'verified').select('reference');
    if (result.error) throw new SandboxSessionError(503, 'SANDBOX_STORE_UNAVAILABLE');
    if (!result.data?.length) {
      const row = await this.find(reference);
      if (row?.state !== 'verified') throw new SandboxSessionError(503, 'SANDBOX_STORE_UNAVAILABLE');
    }
  }
}
export function sandboxConfig(env: NodeJS.ProcessEnv): SandboxConfig {
  return Object.freeze({enabled: env.VAYDU_KORA_SANDBOX_API === 'true', production: env.NODE_ENV === 'production',
    key: env.KORA_TEST_SECRET_KEY || '', account: env.KORA_SANDBOX_MERCHANT_ACCOUNT_REF || '',
    userIds: Object.freeze((env.KORA_SANDBOX_ALLOWED_USER_IDS || '').split(',').map(v => v.trim()).filter(Boolean)),
    returnUrl: env.KORA_SANDBOX_RETURN_URL || '', notificationUrl: env.KORA_SANDBOX_NOTIFICATION_URL || ''});
}
export function createSandboxSession(db: any, config: SandboxConfig): KoraSandboxSession {
  return new KoraSandboxSession(config, new KoraSandboxDbSessions(db),
    new KoraSandbox(config.key, config.account, new KoraDbAttempts(db)));
}
