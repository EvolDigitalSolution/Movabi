// Simulated payout provider for the JobPayoutService rehearsal.
// Shared state lives on globalThis.__stripeSim so the harness controls and
// inspects it across calls:
//   transfers: recorded transfers (id, amount, currency, destination, transfer_group)
//   calls:     every transfers.create invocation {params, opts}
//   failures:  queue of errors to throw on the next transfers.create
//   balanceMinor: available balance reported to the worker
const S = (globalThis.__stripeSim = globalThis.__stripeSim || {
  transfers: [], calls: [], failures: [], balanceMinor: 1000000, seq: 0
});

module.exports.stripe = {
  transfers: {
    async list({ transfer_group }) {
      return {
        data: S.transfers.filter(t => t.transfer_group === transfer_group && !t.reversed),
        has_more: false
      };
    },
    async create(params, opts) {
      S.calls.push({ params, opts });
      const fail = S.failures.shift();
      if (fail === 'uncertain') {
        // Provider outcome unknown: the transfer may or may not exist. Record it
        // as landed so a later reconciliation finds it — the classic
        // create-succeeded-but-response-lost case.
        S.seq += 1;
        const t = { id: `tr_uncertain_${S.seq}`, ...params, reversed: false };
        S.transfers.push(t);
        const e = new Error('network error: response lost');
        e.code = 'transfer_outcome_unknown';
        throw e;
      }
      if (fail === 'balance_insufficient') {
        const e = new Error('insufficient balance');
        e.statusCode = 400;
        e.code = 'balance_insufficient';
        throw e;
      }
      if (fail) throw fail;
      S.seq += 1;
      const t = { id: `tr_sim_${S.seq}`, ...params, reversed: false };
      S.transfers.push(t);
      return t;
    }
  },
  balance: {
    async retrieve() {
      return { available: [{ currency: 'gbp', amount: S.balanceMinor }] };
    }
  },
  paymentIntents: { async retrieve() { throw new Error('not in rehearsal'); } },
  charges: { async retrieve() { throw new Error('not in rehearsal'); } }
};
// Named exports other modules may statically import from stripe.service.
module.exports.verifyWebhookSignature = () => { throw new Error('not in rehearsal'); };
module.exports.createStripeCheckoutSession = async () => { throw new Error('not in rehearsal'); };
module.exports.createStripePortalSession = async () => { throw new Error('not in rehearsal'); };
module.exports.cancelStripeSubscription = async () => { throw new Error('not in rehearsal'); };
