// Batch 2A supplemental SOURCE check (plain Node). Not runtime proof.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

let passed = 0;
const ok = (c, l) => { assert.ok(c, l); passed += 1; };

const adapter = read('server/services/payments/flutterwave-wallet-collection.ts');
const fees = read('server/services/payments/wallet-fee-policy.ts');
const mig = read('supabase/migrations/20261254000000_flutterwave_provider_batch2a.sql');
const registry = read('server/services/payments/market-payment-registry.ts');
const contracts = read('server/services/payments/payment-contracts.ts');

ok(/FLWSECK_TEST-/.test(adapter), 'Flutterwave test-key validation');
ok(/\/payments'/.test(adapter), 'Flutterwave payments endpoint');
ok(/verify_by_reference/.test(adapter), 'verify-by-reference endpoint');
ok(/authenticWebhook/.test(adapter), 'HMAC webhook authentication');
ok(/PAYMENT_RECONCILIATION_REQUIRED/.test(adapter), 'uncertain -> reconcile, no retry/switch');
ok(/flutterwaveMajor/.test(adapter), 'exact minor-unit conversion (any exponent)');
ok(/quoteWalletTopup/.test(fees), 'fee quote');
ok(/totalChargeMinor/.test(fees), 'total charge frozen');
ok(/feePolicyVersion/.test(fees), 'fee policy version');
ok(/currencyExponent/.test(fees), 'currency exponent lookup');
ok(/JPY: 0, KWD: 3/.test(fees), 'zero/three-decimal exponents');
ok(/wallet_topup_fee_policies/.test(mig), 'fee policy table');
ok(/provider_fee_minor/.test(mig), 'frozen fee column');
ok(/total_charge_minor/.test(mig), 'frozen total column');
ok(/fee_policy_version/.test(mig), 'frozen policy version column');
ok(/flutterwave/.test(mig), 'flutterwave route row');
ok(/'collect'/.test(contracts), 'collect capability in contracts');
ok(/collection only; no booking hold\/payout/.test(registry), 'flutterwave gated to collection');

const mig2b = read('supabase/migrations/20261254100000_wallet_fee_freeze_batch2b.sql');
ok(/freeze_wallet_topup_fee/.test(mig2b), 'fee freeze function');
ok(/verify_wallet_topup_charge/.test(mig2b), 'charge verification function');
ok(/a\.amount_minor::numeric \* pol\.fee_basis_points::numeric/.test(mig2b), 'fee calculated from policy (numeric)');

const mig2c = read('supabase/migrations/20261254200000_flutterwave_provider_accept_batch2c.sql');
ok(/'stripe','kora','fincra','flutterwave'/.test(mig2c), 'ledger provider CHECK widened');
ok(/'stripe','kora','flutterwave'/.test(mig2c), 'topup provider CHECK widened');
ok(/NOT IN \('stripe','kora','fincra','flutterwave'\)/.test(mig2c), 'post_wallet_event accepts flutterwave');
ok(/NOT IN \('stripe','kora','flutterwave'\)/.test(mig2c), 'initiate accepts flutterwave');
ok(/entry_seq/.test(mig2c), 'movement entry_seq preserved');
ok(/wallet_business_events_reversal_unique/.test(mig2c), 'reversal-unique SQLSTATE preserved');
ok(/ON CONFLICT \(tenant_id, owner_id, currency_code, balance_purpose\) DO NOTHING/.test(mig2c), 'account conflict handling preserved');
ok(/webhookSecret/.test(adapter), 'separate verif-hash webhook secret');
ok(/timingSafeEqual\(received, expected\)/.test(adapter), 'direct constant-time verif-hash comparison');
ok(/result\.tx_ref !== undefined && result\.tx_ref !== null && result\.tx_ref !== expected\.reference/.test(adapter), 'data.link-only accepted; tx_ref mismatch rejected');

const mig2d = read('supabase/migrations/20261254300000_wallet_atomic_confirm_batch2d.sql');
ok(/confirm_wallet_topup_with_total/.test(mig2d), 'atomic total-check-and-credit');
ok(/use confirm_wallet_topup_with_total/.test(mig2d), 'legacy confirm restricted');
ok(/legacy_attempt/.test(mig2d), 'durable legacy-attempt classification');
ok(/NOT a\.legacy_attempt THEN/.test(mig2d), 'new attempts require total path (policy-independent)');
ok(/'wallet-topup:' \|\| a\.id/.test(mig2d), 'credit event key uses wallet-topup:<attempt_id>');
ok(/IN \('failed','refunded'\)/.test(mig2d), 'uncertain reconciliation preserved');

console.log(`WALLET_FLUTTERWAVE_BATCH2A_SOURCE_CHECKS=${passed}_PASSED (supplemental; not runtime proof)`);
