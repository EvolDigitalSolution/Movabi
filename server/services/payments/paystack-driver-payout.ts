import { createHmac } from 'node:crypto';
import type { Beneficiary } from './flutterwave-driver-payout';
import { payoutTransfersEnabled } from './flutterwave-driver-payout';

const unavailable = () => new Error('Payment account provider unavailable. Please retry or contact support.');

/** Paystack test-mode bank transfer recipients; no hosted Connect or live API support.
 * Setup (banks/resolve/recipient/verification) is independent of transfer
 * submission: `allowTransfers` is false unless a separate explicit flag is set. */
export class PaystackDriverPayout {
    constructor(private key: string, private fingerprintKey: string, private request: typeof fetch = fetch, private callbackUrl?: string, private allowTransfers = false) {
        if (!/^sk_test_/.test(key) || fingerprintKey.length < 32)
            throw unavailable();
    }
    private async api(path: string, body?: any): Promise<any> {
        try {
            const response = await this.request('https://api.paystack.co' + path, {
                method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(15000),
                headers: { Authorization: 'Bearer ' + this.key, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined
            });
            const json = await response.json();
            if (!response.ok || json?.status !== true) {
                const error = unavailable();
                (error as any).upstreamStatus = response.status;
                const retryRaw = response.headers.get('retry-after') || '';
                let retryAfter = Number(retryRaw);
                if (!Number.isFinite(retryAfter)) {
                    const at = Date.parse(retryRaw);
                    retryAfter = Number.isFinite(at) ? Math.max(0, Math.round((at - Date.now()) / 1000)) : NaN;
                }
                (error as any).retryAfter = Math.min(3600, Math.max(1, Math.floor(Number.isFinite(retryAfter) ? retryAfter : 30)));
                throw error;
            }
            return json.data;
        }
        catch (error: any) {
            const wrapped = unavailable();
            if (typeof error?.upstreamStatus === 'number')
                (wrapped as any).upstreamStatus = error.upstreamStatus;
            throw wrapped;
        }
    }
    fingerprint(bank: string, account: string) { return createHmac('sha256', this.fingerprintKey).update(bank + ':' + account).digest('hex'); }
    async bankRecords() {
        const data = await this.api('/bank?country=nigeria');
        if (!Array.isArray(data))
            throw unavailable();
        return data.filter((b: any) => /^\d{3,6}$/.test(String(b.code)) && typeof b.name === 'string' && b.active !== false && b.is_deleted !== true);
    }
    async banks() {
        return (await this.bankRecords()).map((b: any) => ({ code: String(b.code), name: b.name }));
    }
    async resolve(bank: string, account: string) {
        if (!/^\d{3,6}$/.test(bank) || !/^\d{10}$/.test(account))
            throw new Error('Check the bank and ten-digit account number.');
        const selected = (await this.bankRecords()).find((b: any) => String(b.code) === bank);
        if (!selected)
            throw new Error('This bank is not available for setup.');
        const data = await this.api('/bank/resolve?account_number=' + encodeURIComponent(account) + '&bank_code=' + encodeURIComponent(bank));
        if (String(data.account_number) !== account || typeof data.account_name !== 'string' || !data.account_name.trim())
            throw unavailable();
        return data.account_name;
    }
    async createBeneficiary(bank: string, account: string, confirmedName?: string, beforeSubmit?: () => Promise<void>, afterCreated?: (b: Beneficiary) => Promise<void>): Promise<Beneficiary> {
        const name = await this.resolve(bank, account);
        if (confirmedName !== undefined && confirmedName !== name)
            throw new Error('Account name changed. Check the account again.');
        // The durable submission fence belongs immediately before the creation POST,
        // after all read/resolve validation. A failed fence must prevent contact.
        if (beforeSubmit)
            await beforeSubmit();
        const data = await this.api('/transferrecipient', { type: 'nuban', name, account_number: account, bank_code: bank, currency: 'NGN' });
        if (typeof data.recipient_code !== 'string' || !/^RCP_[A-Za-z0-9_-]+$/.test(data.recipient_code))
            throw unavailable();
        const beneficiary = { id: data.recipient_code, bank_code: bank, last4: account.slice(-4), fingerprint: this.fingerprint(bank, account) };
        if (afterCreated)
            await afterCreated(beneficiary);
        await this.destination(beneficiary);
        return beneficiary;
    }
    async verifyBeneficiary(expected: Beneficiary): Promise<void> { await this.destination(expected); }
    private async destination(expected: Beneficiary) {
        if (!/^RCP_[A-Za-z0-9_-]+$/.test(expected.id))
            throw unavailable();
        const data = await this.api('/transferrecipient/' + encodeURIComponent(expected.id));
        const acct = String(data?.details?.account_number ?? '');
        const code = String(data?.details?.bank_code ?? '');
        if (String(data.recipient_code) !== expected.id || code !== expected.bank_code || !/^\d{10}$/.test(acct) || this.fingerprint(code, acct) !== expected.fingerprint)
            throw unavailable();
        return data;
    }
    async submit(): Promise<never> {
        if (!this.allowTransfers || !payoutTransfersEnabled())
            throw new Error('Driver payout transfers are disabled; account setup is verification-only.');
        throw unavailable();
    }
}
