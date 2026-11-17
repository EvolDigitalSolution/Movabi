// Simulated Kora payout adapter for the connected journey. Redirected in place
// of server/services/payments/kora-driver-payout.ts so the REAL
// DriverWithdrawalService / DriverPaymentAccountService / sandbox provider
// gates run unmodified while the provider HTTP boundary is simulated.
// The sim records submitted disbursements by merchant reference; lookup reports
// them completed (or 'failed'/'pending' when the sim outcome says so), with the
// merchant reference echoed back exactly as the real Kora API does.
const sim = (globalThis.__koraSim ||= { transfers: {}, outcome: 'completed', seq: 0 });

class KoraDriverPayout {
  constructor(secret, fingerprintKey) {
    if (!/^sk_test_/.test(String(secret || ''))) throw new Error('Test-mode Kora secret required.');
    if (!fingerprintKey) throw new Error('Fingerprint key required.');
  }
  async lookup(t) {
    const s = sim.transfers[t.reference];
    if (!s) return null;
    return { state: s.state, id: s.id, fee: s.fee };
  }
  async submit(t) {
    if (sim.outcome === 'uncertain') {
      // Provider accepted but the response was lost: the disbursement exists
      // even though submit threw. The next lookup must find it — no duplicate.
      sim.transfers[t.reference] = { id: t.reference, fee: '0', state: 'completed' };
      throw new Error('timeout');
    }
    sim.transfers[t.reference] = { id: t.reference, fee: '0',
      state: sim.outcome === 'failed' ? 'failed' : 'completed' };
  }
  async banks() { return [{ code: '044', name: 'Access Bank' }]; }
  async resolve() { return 'TEST ACCOUNT'; }
  async createBeneficiary(bank, account) {
    return { id: account, bank_code: bank, last4: String(account).slice(-4), fingerprint: 'f'.repeat(64) };
  }
  async verifyBeneficiary() {}
}
module.exports = { KoraDriverPayout };
