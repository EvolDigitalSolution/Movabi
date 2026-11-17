// Simulated Flutterwave payout adapter for the worker rehearsal. Redirected in
// place of server/services/payments/flutterwave-driver-payout.ts so the REAL
// DriverWithdrawalService / DriverPaymentAccountService / sandbox provider
// gates run unmodified while the provider HTTP boundary is simulated.
// The sim records submitted transfers by reference; lookup reports them
// completed (or 'failed'/'pending' when the sim outcome says so).
const sim = (globalThis.__flwSim ||= { transfers: {}, outcome: 'completed', seq: 0 });

function payoutMarketReady(m) {
  return !!m && m.country_code === 'NG' && m.currency_code === 'NGN' && ['flutterwave','paystack','kora'].includes(m.provider)
    && m.enabled === true && m.merchant_approved === true && m.adapter_ready === true && !!m.merchant_account_ref
    && !!m.capability_verified_at && m.merchant_mode === 'test' && !!m.capability_evidence_ref;
}
function payoutTransfersEnabled() { return process.env.VAYDU_DRIVER_PAYOUT_TRANSFERS === 'true'; }

class FlutterwaveDriverPayout {
  constructor(secret, fingerprintKey) {
    if (!String(secret || '').startsWith('FLWSECK_TEST-')) throw new Error('Test-mode Flutterwave secret required.');
    if (!fingerprintKey) throw new Error('Fingerprint key required.');
  }
  async lookup(t) {
    const s = sim.transfers[t.reference];
    if (!s) return null;
    return { state: s.state, id: s.id, fee: s.fee };
  }
  async submit(t) {
    if (sim.outcome === 'uncertain') {
      // The provider accepted the POST but the response was lost: the transfer
      // exists even though submit threw. The next lookup must find it.
      sim.transfers[t.reference] = { id: '99900' + (++sim.seq), fee: '0', state: 'completed' };
      throw new Error('timeout');
    }
    sim.transfers[t.reference] = { id: '99900' + (++sim.seq), fee: '0',
      state: sim.outcome === 'failed' ? 'failed' : 'completed' };
  }
  async banks() { return [{ code: '044', name: 'Access Bank' }]; }
  async resolve() { return 'TEST ACCOUNT'; }
  async createBeneficiary(bank, account) {
    return { id: '123456', bank_code: bank, last4: String(account).slice(-4), fingerprint: 'f'.repeat(64) };
  }
  async verifyBeneficiary() {}
}
module.exports = { FlutterwaveDriverPayout, payoutMarketReady, payoutTransfersEnabled };
