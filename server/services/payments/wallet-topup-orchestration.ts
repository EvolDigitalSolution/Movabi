/** Disabled integration boundary. Concrete repository/SDK clients are deliberately
 * not installed by this batch. All provider evidence must be fetched server-side. */
import type { WalletCollectionAttempt, WalletCollectionAdapter, WalletCollectionInitiation, WalletCollectionVerification } from './wallet-collection';

export interface WalletTopupRepository {
  initiate(attempt: WalletCollectionAttempt): Promise<string>;
  getAttempt(attemptId: string): Promise<WalletCollectionAttempt>;
  getLifecycle(attemptId: string): Promise<{ status: string; providerReference: string | null }>;
  /** Atomic, committed SQL claim. Never use an in-process mutex for this. */
  claimSubmission(attemptId: string): Promise<boolean>;
  getProviderReference(attemptId: string): Promise<string>;
  /** Trusted lookup scoped to the frozen provider/merchant/idempotency identity.
   * Implementations without a documented lookup must return null, never create. */
  lookupProviderReference(attemptId: string): Promise<string | null>;
  recordProviderReference(attemptId: string, reference: string): Promise<void>;
  recordVerification(attemptId: string, evidenceKey: string, value: WalletCollectionVerification): Promise<void>;
  reconcile(attemptId: string, evidenceKey: string): Promise<string>;
  confirm(attemptId: string, value: WalletCollectionVerification): Promise<string>;
  markUncertain(attemptId: string, reason: string): Promise<void>;
  markFailed(attemptId: string, reason: string): Promise<void>;
  markRefunded(attemptId: string, evidenceReference: string, reference: string, merchant: string, currency: string, amount: bigint, status: string, reason: string): Promise<string>;
}
export interface WalletTopupOrchestratorDeps {
  gateEnabled(): Promise<boolean>;
  /** Must validate owner + tenant + market + usable destination, not a label alone. */
  destinationReady(purpose: string, attempt: WalletCollectionAttempt): Promise<boolean>;
  adapterFor(attempt: WalletCollectionAttempt): Promise<WalletCollectionAdapter>;
}
export type BeginCollectionResult =
  | { kind: 'initiated'; attemptId: string; initiation: WalletCollectionInitiation }
  | { kind: 'pending'; attemptId: string }
  | { kind: 'terminal'; attemptId: string; status: 'credited' | 'refunded' | 'failed' };

export class WalletTopupOrchestrator {
  constructor(private readonly repo: WalletTopupRepository, private readonly deps: WalletTopupOrchestratorDeps) {}

  private async adapter(attempt: WalletCollectionAttempt): Promise<WalletCollectionAdapter> {
    const a = await this.deps.adapterFor(attempt);
    if (a.provider !== attempt.provider || a.merchantAccountRef !== attempt.merchantAccountRef) throw new Error('ADAPTER_MISMATCH');
    if (!a.capabilities.includes('collect')) throw new Error('PAYMENT_CAPABILITY_UNAVAILABLE');
    return a;
  }
  private validate(attempt: WalletCollectionAttempt, reference: string, v: WalletCollectionVerification) {
    if (!reference.trim() || v.providerReference !== reference || v.merchantAccountRef !== attempt.merchantAccountRef
        || v.currency !== attempt.currency || v.amountMinor !== attempt.amountMinor) throw new Error('VERIFICATION_TERMS_MISMATCH');
    if (!['succeeded','completed','pending','unknown','failed'].includes(v.finalStatus)) throw new Error('INVALID_PROVIDER_STATUS');
  }

  async beginCollection(input: WalletCollectionAttempt): Promise<BeginCollectionResult> {
    if (!(await this.deps.gateEnabled())) throw new Error('COLLECTION_DISABLED');
    if (!(await this.deps.destinationReady(input.destinationAccountPurpose, input))) throw new Error('DESTINATION_NOT_READY');
    const attemptId = await this.repo.initiate(input);
    // Use persisted terms, not caller-supplied terms, after SQL replay validation.
    const attempt = await this.repo.getAttempt(attemptId);
    const life = await this.repo.getLifecycle(attemptId);
    if (life.status === 'credited' || life.status === 'refunded' || life.status === 'failed') return {kind:'terminal',attemptId,status:life.status};
    if (life.status !== 'initiated' || life.providerReference) return {kind:'pending',attemptId};
    const adapter = await this.adapter(attempt); // resolution failure leaves initiated
    if (!(await this.repo.claimSubmission(attemptId))) return {kind:'pending',attemptId};
    try {
      const initiation = await adapter.initiate(attempt);
      if (!initiation.providerReference?.trim()) throw new Error('NO_PROVIDER_REFERENCE');
      await this.repo.recordProviderReference(attemptId, initiation.providerReference);
      return {kind:'initiated',attemptId,initiation};
    } catch (error) {
      // If this write fails, the committed submitting claim still prevents re-create.
      await this.repo.markUncertain(attemptId, `submission or binding ambiguous: ${String(error)}`);
      throw error;
    }
  }

  /** Safe after process death in submitting. No gate is checked here: disabling
   * new collection must not prevent reconciling money already collected. */
  async handleProviderVerification(attemptId: string, evidenceKey: string): Promise<string> {
    const attempt = await this.repo.getAttempt(attemptId);
    const adapter = await this.adapter(attempt);
    const life = await this.repo.getLifecycle(attemptId);
    if (life.status === 'credited' || life.status === 'refunded') return ''; // late notifications do not downgrade
    let reference = await this.repo.getProviderReference(attemptId);
    let needsBinding = !reference;
    try {
      if (!reference) reference = (await this.repo.lookupProviderReference(attemptId)) ?? '';
      if (!reference.trim()) throw new Error('PROVIDER_LOOKUP_UNAVAILABLE');
      const value = await adapter.verify(attempt, {providerReference:reference});
      this.validate(attempt, reference, value);
      // Evidence is durable before binding; duplicate delivery must compare terms.
      await this.repo.recordVerification(attemptId, evidenceKey, value);
      if (needsBinding) await this.repo.recordProviderReference(attemptId, reference);
      if (value.finalStatus === 'succeeded' || value.finalStatus === 'completed') return await this.repo.reconcile(attemptId,evidenceKey);
      if (value.finalStatus === 'failed') { await this.repo.markFailed(attemptId,'verified provider failure'); return ''; }
      await this.repo.markUncertain(attemptId,`verified provider status ${value.finalStatus}`);
      return '';
    } catch (error) {
      // Avoid overwriting a concurrent successful confirmation or refund.
      const current = await this.repo.getLifecycle(attemptId);
      if (!['credited','refunded','failed'].includes(current.status)) await this.repo.markUncertain(attemptId,`verification unresolved: ${String(error)}`);
      throw error;
    }
  }
  /** Recovery always performs a fresh provider lookup/verification; supplied
   * event keys or redirect fields never constitute successful evidence. */
  async recover(attemptId: string, evidenceKey: string): Promise<string> {
    return this.handleProviderVerification(attemptId,evidenceKey);
  }
}
