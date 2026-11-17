import {DriverPaymentAccountService,sandboxDestinationProvider,beneficiaryOf} from './driver-payment-account.service';
import {payoutTransfersEnabled,type FrozenTransfer} from './payments/flutterwave-driver-payout';
import {supabaseAdmin} from './supabase.service';

type PayoutAdapter={lookup(t:FrozenTransfer):Promise<{state:string;id?:string;fee?:string}|null>;submit(t:FrozenTransfer):Promise<unknown>};

/**
 * Driver earnings-wallet withdrawal worker (NG/NGN sandbox scope).
 *
 * A withdrawal row already holds reserved funds (earnings_payable_held) — the
 * worker only ever moves held money to the provider. The durable submission
 * marker commits BEFORE the transfer POST; an uncertain result is lookup-only.
 * Completed → settle held→paid_out; definitive failed → controlled reversal
 * back to spendable; anything else stays 'reconcile' with funds still held.
 */
export class DriverWithdrawalService {
  private static running = false;
  static start() {
    const timer = setInterval(() => { void this.tick(); }, 60000);
    timer.unref();
    void this.tick();
  }
  static async tick() {
    if (this.running) return;
    this.running = true;
    try {
      // Sandbox-only rail: skip entirely when the payout provider is not configured.
      try { sandboxDestinationProvider('flutterwave',''); } catch { return; }
      const { data, error } = await supabaseAdmin.from('driver_withdrawals').select('id')
        .in('status', ['processing','reconcile']).lte('retry_at', new Date().toISOString()).order('retry_at').limit(20);
      if (error) throw error;
      for (const row of data || []) {
        try { await this.process(row.id); } catch (e) { console.error('[DriverWithdrawal] retry failed', row.id, e); }
      }
    } catch (error) { console.error('[DriverWithdrawal] worker unavailable', error); }
    finally { this.running = false; }
  }
  static async process(id: string) {
    const claim = await supabaseAdmin.rpc('claim_driver_withdrawal', { p_id: id });
    if (claim.error) throw claim.error;
    const w = claim.data?.[0];
    if (!w) return;
    const update = async (status: string, code: string) => {
      const result = await supabaseAdmin.rpc('mark_driver_withdrawal_retry',
        { p_id: w.id, p_lease: w.lease_token, p_status: status, p_code: code });
      if (result.error || result.data !== true) throw new Error('Withdrawal retry marker was not persisted');
    };
    // Account setup never authorizes money movement. Dispatch requires the
    // separate explicit transfer flag; otherwise the withdrawal stays blocked.
    if (!payoutTransfersEnabled()) { await update('blocked','transfer_dispatch_disabled'); return; }
    let provider: PayoutAdapter; let scope: any;
    try {
      scope = await new DriverPaymentAccountService(supabaseAdmin, sandboxDestinationProvider).ready(w.driver_id);
      // The market's configured provider selects the adapter. Providers whose
      // adapter cannot pay (e.g. paystack setup-only) never reach dispatch:
      // request_driver_withdrawal gates on payout_withdrawal_provider_supported.
      provider = sandboxDestinationProvider(scope.market.provider, scope.market.merchant_account_ref) as unknown as PayoutAdapter;
    } catch { await update('reconcile','sandbox_payout_unavailable'); return; }
    if (w.merchant_account_ref !== scope.market.merchant_account_ref || w.payout_account_id !== scope.account.id
      || w.provider !== scope.market.provider || String(w.currency_code).toUpperCase() !== scope.currency) { await update('blocked','withdrawal_scope_mismatch'); return; }
    const t: FrozenTransfer = { reference: w.reference, amountMinor: Number(w.amount_minor), currency: scope.currency,
      beneficiary: beneficiaryOf(scope.account) };
    let found;
    try { found = await provider.lookup(t); } catch { await update('reconcile','transfer_lookup_unavailable'); return; }
    if (found) {
      if (found.state === 'completed') {
        const result = await supabaseAdmin.rpc('finish_driver_withdrawal', { p_id: w.id, p_lease: w.lease_token, p_transfer: found.id, p_fee: found.fee || null });
        if (result.error || result.data !== true) throw new Error('Withdrawal completion requires reconciliation.');
      } else if (found.state === 'failed') {
        // Definitive provider failure: the reserved funds reverse back to the
        // spendable earnings balance; the withdrawal itself stays failed.
        const result = await supabaseAdmin.rpc('reverse_driver_withdrawal', { p_id: w.id, p_lease: w.lease_token, p_code: 'provider_transfer_failed' });
        if (result.error || result.data !== true) throw new Error('Withdrawal reversal requires reconciliation.');
      } else {
        await update('reconcile','provider_transfer_pending');
      }
      return;
    }
    const submitted = await supabaseAdmin.rpc('claim_withdrawal_submission', { p_id: w.id, p_lease: w.lease_token, p_reference: t.reference });
    if (submitted.error) throw new Error('Withdrawal submission marker unavailable.');
    if (submitted.data !== true) { await update('reconcile','transfer_outcome_unknown'); return; }
    try { await provider.submit(t); } catch { await update('reconcile','transfer_outcome_unknown'); return; }
    await update('reconcile','transfer_accepted_verification_required');
  }
}
