"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FlutterwaveDriverPayout = void 0;
exports.payoutMarketReady = payoutMarketReady;
exports.payoutTransfersEnabled = payoutTransfersEnabled;
const node_crypto_1 = require("node:crypto");
const flutterwave_wallet_collection_1 = require("./flutterwave-wallet-collection");
function payoutMarketReady(m) {
    return !!m && m.country_code === 'NG' && m.currency_code === 'NGN' && m.provider === 'flutterwave'
        && m.enabled === true && m.merchant_approved === true && m.adapter_ready === true && !!m.merchant_account_ref && !!m.capability_verified_at
        && m.merchant_mode === 'test' && !!m.capability_evidence_ref;
}
const unavailable = () => new Error('Payment account provider unavailable. Please retry or contact support.');
/** Transfers are a separate, explicit capability from account setup. */
function payoutTransfersEnabled(env = process.env) { return env.VAYDU_DRIVER_PAYOUT_TRANSFERS === 'true'; }
/** v3 test-mode bank beneficiaries; no hosted Connect, virtual account or live API support.
 * Setup (banks/resolve/beneficiary/verification) is independent of transfer
 * submission: `allowTransfers` is false unless a separate explicit flag is set. */
class FlutterwaveDriverPayout {
    constructor(key, fingerprintKey, request = fetch, callbackUrl, allowTransfers = false) {
        this.key = key;
        this.fingerprintKey = fingerprintKey;
        this.request = request;
        this.callbackUrl = callbackUrl;
        this.allowTransfers = allowTransfers;
        if (!/^FLWSECK_TEST-/.test(key) || fingerprintKey.length < 32)
            throw unavailable();
    }
    async api(path, body) {
        try {
            const response = await this.request('https://api.flutterwave.com/v3' + path, {
                method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(15000),
                headers: { Authorization: 'Bearer ' + this.key, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body).replace(/"amount":"(\d+(?:\.\d{1,2})?)"/, '"amount":$1') : undefined
            });
            // Preserve decimal number tokens before JSON parsing. Provider payloads never leave this adapter.
            const raw = await response.text();
            const json = JSON.parse(raw.replace(/("(?:[^"\\]|\\.)*")|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g, (m, s) => s || JSON.stringify(m)));
            if (!response.ok || json.status !== 'success')
                throw unavailable();
            return json.data;
        }
        catch {
            throw unavailable();
        }
    }
    fingerprint(bank, account) { return (0, node_crypto_1.createHmac)('sha256', this.fingerprintKey).update(bank + ':' + account).digest('hex'); }
    async bankRecords() {
        const data = await this.api('/banks/NG');
        if (!Array.isArray(data))
            throw unavailable();
        return data.filter(b => /^\d{3,6}$/.test(b.code) && typeof b.name === 'string' && ![true, 1, '1', 'true'].includes(b.has_branches));
    }
    async banks() {
        // Branch-bearing banks require a separate, reviewed flow. Do not queue doomed transfers.
        return (await this.bankRecords()).map(b => ({ code: b.code, name: b.name }));
    }
    async resolve(bank, account) {
        if (!/^\d{3,6}$/.test(bank) || !/^\d{10}$/.test(account))
            throw new Error('Check the bank and ten-digit account number.');
        const selected = (await this.bankRecords()).find(b => b.code === bank);
        if (!selected)
            throw new Error('This bank is not available for setup.');
        if (![false, 0, '0', 'false'].includes(selected.has_branches)) {
            if (!/^\d+$/.test(String(selected.id)))
                throw unavailable();
            const branches = await this.api('/banks/' + selected.id + '/branches');
            if (!Array.isArray(branches) || branches.length)
                throw new Error('This bank requires additional branch details and is not available for setup yet.');
        }
        const data = await this.api('/accounts/resolve', { account_bank: bank, account_number: account });
        if (data.account_number !== account || typeof data.account_name !== 'string' || !data.account_name.trim())
            throw unavailable();
        return data.account_name;
    }
    async createBeneficiary(bank, account, confirmedName, beforeSubmit, afterCreated) {
        const name = await this.resolve(bank, account);
        if (confirmedName !== undefined && confirmedName !== name)
            throw new Error('Account name changed. Check the account again.');
        // The durable submission fence belongs immediately before the creation POST,
        // after all read/resolve validation. A failed fence must prevent contact.
        if (beforeSubmit)
            await beforeSubmit();
        const data = await this.api('/beneficiaries', { account_bank: bank, account_number: account, beneficiary_name: name, currency: 'NGN' });
        if (!/^\d+$/.test(String(data.id)) || !Number.isSafeInteger(Number(data.id)) || Number(data.id) <= 0)
            throw unavailable();
        const beneficiary = { id: String(data.id), bank_code: bank, last4: account.slice(-4), fingerprint: this.fingerprint(bank, account) };
        if (afterCreated)
            await afterCreated(beneficiary);
        await this.destination(beneficiary);
        return beneficiary;
    }
    async verifyBeneficiary(expected) { await this.destination(expected); }
    async destination(expected) {
        if (!/^\d+$/.test(expected.id))
            throw unavailable();
        const data = await this.api('/beneficiaries/' + expected.id);
        if (String(data.id) !== expected.id || data.bank_code !== expected.bank_code || !/^\d{10}$/.test(data.account_number) || this.fingerprint(data.bank_code, data.account_number) !== expected.fingerprint)
            throw unavailable();
        return data;
    }
    result(data, t) {
        const amount = String(data?.amount || '');
        const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(amount);
        const minor = m ? BigInt(m[1]) * 100n + BigInt((m[2] || '').padEnd(2, '0')) : 0n;
        if (!data || data.reference !== t.reference || data.currency !== t.currency || minor !== BigInt(t.amountMinor)
            || data.bank_code !== t.beneficiary.bank_code || this.fingerprint(String(data.bank_code), String(data.account_number)) !== t.beneficiary.fingerprint
            || !/^\d+$/.test(String(data.id)))
            return { state: 'unknown' };
        const state = String(data.status).toUpperCase();
        return { state: state === 'SUCCESSFUL' ? 'completed' : state === 'FAILED' ? 'failed' : ['NEW', 'PENDING'].includes(state) ? 'pending' : 'unknown',
            id: String(data.id), ...(/^(\d+)(\.\d+)?$/.test(String(data.fee)) ? { fee: String(data.fee) } : {}) };
    }
    async lookup(t) {
        if (t.currency !== 'NGN' || !Number.isSafeInteger(t.amountMinor) || t.amountMinor <= 0)
            throw unavailable();
        const data = await this.api('/transfers?reference=' + encodeURIComponent(t.reference));
        if (!Array.isArray(data))
            throw unavailable();
        if (!data.length)
            return null;
        if (data.length !== 1)
            return { state: 'unknown' };
        return this.result(data[0], t);
    }
    async submit(t) {
        if (!this.allowTransfers)
            throw new Error('Driver payout transfers are disabled; account setup is verification-only.');
        if (t.currency !== 'NGN' || !Number.isSafeInteger(t.amountMinor) || t.amountMinor <= 0 || !/^vaydu-[a-f0-9-]+_PMCK$/.test(t.reference))
            throw unavailable();
        const dest = await this.destination(t.beneficiary);
        // v3 uses merchant reference (not the unrelated v4 idempotency header).
        // Submission responses are deliberately never treated as final settlement.
        await this.api('/transfers', { account_bank: dest.bank_code, account_number: dest.account_number,
            beneficiary: Number(t.beneficiary.id), currency: 'NGN', debit_currency: 'NGN',
            amount: (0, flutterwave_wallet_collection_1.flutterwaveMajor)(t.amountMinor, 2), reference: t.reference, narration: 'Driver earnings', ...(this.callbackUrl ? { callback_url: this.callbackUrl } : {}) });
    }
}
exports.FlutterwaveDriverPayout = FlutterwaveDriverPayout;
