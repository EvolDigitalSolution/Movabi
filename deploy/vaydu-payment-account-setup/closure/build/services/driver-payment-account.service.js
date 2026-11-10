"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.DriverPaymentAccountService = void 0;
exports.sandboxPayoutProvider = sandboxPayoutProvider;
exports.beneficiaryOf = beneficiaryOf;
const flutterwave_driver_payout_1 = require("./payments/flutterwave-driver-payout");
/** Private tables are server-only; neither account numbers nor provider payloads are persisted. */
class DriverPaymentAccountService {
    constructor(db, provider, collectionScopeOnly = false) {
        this.db = db;
        this.provider = provider;
        this.collectionScopeOnly = collectionScopeOnly;
    }
    async scope(driverId) {
        const profile = await this.db.from('profiles').select('*').eq('id', driverId).single();
        const p = profile.data;
        if (profile.error || !p || p.role !== 'driver' || !p.registration_activated_at || !p.tenant_id)
            throw new Error('An activated driver account is required.');
        const country = String(p.registration_country_code || p.country_code || '').toUpperCase();
        const markets = await this.db.from('market_availability').select('supported_currency').eq('country_code', country);
        const currencies = [...new Set((markets.data || []).map((m) => m.supported_currency))];
        if (markets.error || currencies.length !== 1)
            throw new Error('Registered driver market is ambiguous.');
        const currency = currencies[0];
        if (this.collectionScopeOnly)
            return { driverId, tenant: p.tenant_id, country, currency, market: null };
        const route = await this.db.from('driver_payout_markets').select('*').eq('country_code', country).eq('currency_code', currency).maybeSingle();
        if (route.error)
            throw new Error('Payment account configuration is unavailable.');
        return { driverId, tenant: p.tenant_id, country, currency, market: route.data };
    }
    async status(driverId) {
        const scope = await this.scope(driverId);
        // GB delegates to the existing owner-authenticated Stripe route and unchanged Connect UI.
        if (scope.country === 'GB' && scope.currency === 'GBP' && (!scope.market || scope.market.provider === 'stripe')) {
            const { PayoutEligibilityService } = await Promise.resolve().then(() => __importStar(require('./payout-eligibility.service')));
            const e = await PayoutEligibilityService.evaluateDriver(driverId);
            return { provider: 'stripe', state: e.eligible ? 'completed' : e.code === 'NO_STRIPE_ACCOUNT' ? 'not_started' : 'action_required', available: true };
        }
        if (!(0, flutterwave_driver_payout_1.payoutMarketReady)(scope.market) || !this.allowed(scope))
            return { provider: scope.market?.provider || null, state: 'unavailable', available: false };
        try {
            this.provider(scope.market.merchant_account_ref);
        }
        catch {
            return { provider: 'flutterwave', state: 'unavailable', available: false };
        }
        const record = await this.record(scope);
        return { provider: 'flutterwave', state: record?.state || 'not_started', available: true, last4: record?.last4 || null };
    }
    async record(scope) {
        const r = await this.db.from('driver_payment_accounts').select('*').eq('driver_id', scope.driverId).eq('tenant_id', scope.tenant)
            .eq('country_code', scope.country).eq('currency_code', scope.currency).eq('merchant_account_ref', scope.market?.merchant_account_ref).maybeSingle();
        if (r.error)
            throw new Error('Payment account status is unavailable.');
        return r.data;
    }
    async ready(driverId) {
        const scope = await this.scope(driverId);
        if (!(0, flutterwave_driver_payout_1.payoutMarketReady)(scope.market) || !this.allowed(scope))
            throw new Error('Sandbox payout market unavailable.');
        const account = await this.record(scope);
        if (account?.state !== 'completed')
            throw new Error('Payment account setup is incomplete.');
        this.provider(scope.market.merchant_account_ref);
        return { ...scope, account };
    }
    async banks(driverId) { const s = await this.authorize(driverId); return this.provider(s.market.merchant_account_ref).banks(); }
    async resolve(driverId, bank, account) { const s = await this.authorize(driverId); return this.provider(s.market.merchant_account_ref).resolve(bank, account); }
    allowed(s) { return s.market?.country_code === s.country && s.market?.currency_code === s.currency && s.market?.sandbox_driver_id === s.driverId && s.market?.sandbox_tenant_id === s.tenant; }
    async authorize(driverId) { const scope = await this.scope(driverId); if (!(0, flutterwave_driver_payout_1.payoutMarketReady)(scope.market) || !this.allowed(scope))
        throw new Error('Sandbox payout market unavailable.'); this.provider(scope.market.merchant_account_ref); return scope; }
    async setup(driverId, bank, account, confirmedName) {
        if (!confirmedName?.trim())
            throw new Error('Check and confirm the account name.');
        const s = await this.authorize(driverId);
        const claim = await this.db.rpc('claim_driver_payment_setup', { p_driver: driverId, p_tenant: s.tenant, p_country: s.country, p_currency: s.currency, p_merchant: s.market.merchant_account_ref });
        if (claim.error || !claim.data?.length)
            throw new Error('Setup is already in progress. Refresh before retrying.');
        const row = claim.data[0];
        // Persist submission intent BEFORE the provider call. Once this marker exists,
        // no lease expiry, retry or stale worker may authorize another creation.
        const intent = await this.db.from('driver_payment_accounts')
            .update({ submission_attempted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
            .eq('id', row.id).eq('setup_token', row.setup_token).eq('state', 'in_progress').is('submission_attempted_at', null).select('id');
        if (intent.error || intent.data?.length !== 1)
            throw new Error('Setup is already in progress. Refresh before retrying.');
        try {
            const b = await this.provider(s.market.merchant_account_ref).createBeneficiary(bank, account, confirmedName);
            const result = await this.db.from('driver_payment_accounts').update({ state: 'completed', beneficiary_id: b.id, bank_code: b.bank_code, last4: b.last4, fingerprint: b.fingerprint,
                updated_at: new Date().toISOString() }).eq('id', row.id).eq('setup_token', row.setup_token).eq('state', 'in_progress').select('id');
            if (result.error || result.data?.length !== 1)
                throw new Error('Provider creation requires reconciliation.');
            return { state: 'completed', last4: b.last4 };
        }
        catch {
            // An ambiguous outcome (timeout, crash, 5xx, or persistence failure after a
            // successful provider call) never retries automatically. It is parked for a
            // reviewed reconciliation decision; no second beneficiary POST is authorized.
            await this.db.from('driver_payment_accounts').update({ state: 'reconciliation_required', updated_at: new Date().toISOString() })
                .eq('id', row.id).eq('setup_token', row.setup_token).eq('state', 'in_progress');
            throw new Error('Could not verify the payment account. Setup needs reconciliation before any retry.');
        }
    }
}
exports.DriverPaymentAccountService = DriverPaymentAccountService;
function sandboxPayoutProvider(expectedMerchant) {
    if (!['test', 'development'].includes(process.env.NODE_ENV || '') || process.env.VAYDU_DEPLOYMENT_ENV !== 'develop'
        || process.env.VAYDU_DRIVER_PAYOUT_SANDBOX !== 'true')
        throw new Error('Sandbox payout runtime is disabled.');
    const target = new URL(process.env.SUPABASE_URL || '');
    if (!['http://movabi-develop-kong:8000/', 'https://movabi-supabase-develop.apps.evolsolution.com/'].includes(target.href))
        throw new Error('Verified develop database target required.');
    if (!process.env.FLUTTERWAVE_PAYOUT_MERCHANT_REF || (expectedMerchant && expectedMerchant !== process.env.FLUTTERWAVE_PAYOUT_MERCHANT_REF))
        throw new Error('Approved payout merchant binding is missing.');
    const callback = new URL(process.env.FLUTTERWAVE_PAYOUT_CALLBACK_URL || '');
    if (callback.origin !== 'https://movabi-develop.apps.evolsolution.com' || callback.pathname !== '/api/driver-payment-account/webhook'
        || callback.search || callback.hash || callback.username || callback.password || process.env.VAYDU_DRIVER_PAYOUT_CALLBACK_APPROVED !== 'true')
        throw new Error('Approved develop callback required.');
    const webhook = process.env.FLUTTERWAVE_PAYOUT_WEBHOOK_SECRET || '';
    if (webhook.length < 32 || webhook === process.env.FLUTTERWAVE_TEST_SECRET_KEY)
        throw new Error('Separate webhook secret required.');
    return new flutterwave_driver_payout_1.FlutterwaveDriverPayout(process.env.FLUTTERWAVE_TEST_SECRET_KEY || '', process.env.DRIVER_PAYOUT_FINGERPRINT_KEY || '', fetch, callback.href, (0, flutterwave_driver_payout_1.payoutTransfersEnabled)());
}
function beneficiaryOf(account) { return { id: account.beneficiary_id, bank_code: account.bank_code, last4: account.last4, fingerprint: account.fingerprint }; }
