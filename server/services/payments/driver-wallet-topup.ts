import { PaymentLayerError } from './payment-contracts';
import type { DriverCardTopupAdapter,DriverCardAdapterResolver } from './driver-card-topup-contracts';
import {assertApprovedDriverFee,DRIVER_SANDBOX_FEE_LABEL,DRIVER_SANDBOX_FEE_VERSION} from './driver-topup-approved-policy';

export interface DriverTopupDb {
  authGetUser(token: string): Promise<{ id: string; email?: string } | null>;
  rpc<T>(fn: string, args: Record<string, unknown>): Promise<T>;
  from(table: string): any;
}
export interface DriverTopupConfig {
  collectionEnabled(): Promise<boolean>;
  flutterwaveSecret(): string;
  flutterwaveWebhookSecret(): string;
  flutterwaveMerchant(currency: string): string;
  callbackUrl(): string;
  scopeAllowed?(owner:string,tenant:string):boolean;
  walletScopeRouting?:boolean;
  allowFirstFlutterwaveTestAccount?:boolean;
}
const fail = (code: string): never => { throw new PaymentLayerError(code, 'Driver top-up unavailable'); };
function minor(value: unknown): number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) {
    const n = BigInt(value);
    if (n <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(n);
  }
  return fail('TOPUP_TERMS_UNAVAILABLE');
}
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

export class DriverWalletTopupService {
  constructor(private readonly db: DriverTopupDb, private readonly config: DriverTopupConfig, private readonly adapters: DriverCardTopupAdapter | DriverCardAdapterResolver) {}

  private adapter(provider:string,merchant:string):DriverCardTopupAdapter {
    const adapter=typeof this.adapters==='function'?this.adapters(provider,merchant):this.adapters;
    if(adapter.provider!==provider)return fail('PAYMENT_PROVIDER_NOT_READY');return adapter;
  }
  private async principal(token: string) {
    const user = await this.db.authGetUser(token);
    if (!user || !uuid(user.id)) return fail('AUTHENTICATION_REQUIRED');
    const profile = await this.db.from('profiles').select('id,tenant_id,role,registration_activated_at').eq('id', user.id).maybeSingle();
    if (profile.error || !profile.data || profile.data.id !== user.id || profile.data.role !== 'driver' || !uuid(profile.data.tenant_id) || !profile.data.registration_activated_at) return fail('DRIVER_NOT_ELIGIBLE');
    if(this.config.scopeAllowed&&!this.config.scopeAllowed(user.id,profile.data.tenant_id))return fail('DRIVER_NOT_ELIGIBLE');
    return { id: user.id, tenant: profile.data.tenant_id as string, email: user.email || '' };
  }
  private async market(id: string, tenant: string) {
    const status = await this.db.rpc<any>('driver_cash_credit_status_v1f', {p_driver_id: id});
    if (!status || status.driverId !== id || status.tenantId !== tenant || !/^[A-Z]{2}$/.test(status.country) || !/^[A-Z]{3}$/.test(status.currency)) return fail('MARKET_UNAVAILABLE');
    let route:any;
    if(this.config.walletScopeRouting){
      if(status.country!=='NG'||status.currency!=='NGN')return fail('MARKET_UNAVAILABLE');
      const scoped=await this.db.from('driver_card_topup_sandbox_scopes').select('provider,merchant_account_ref').eq('driver_id',id).eq('tenant_id',tenant).eq('country_code',status.country).eq('currency_code',status.currency).eq('provider','flutterwave').eq('method','card').eq('enabled',true).maybeSingle();
      if(scoped.error||!scoped.data)return fail('PAYMENT_SANDBOX_REVIEW_REQUIRED');
      route={...scoped.data,capabilities:['collect']};
    }else{
    const routes = await this.db.from('market_payment_routes').select('provider,merchant_account_ref,capabilities').eq('country_code',status.country).eq('currency_code',status.currency).eq('method','card').eq('preferred',true).eq('enabled',true).eq('merchant_approved',true).eq('adapter_ready',true);
    if (routes.error || !Array.isArray(routes.data) || routes.data.length !== 1) return fail('PAYMENT_MARKET_UNAVAILABLE');
    route = routes.data[0];
    if (typeof route.provider !== 'string' || typeof route.merchant_account_ref !== 'string' || !route.merchant_account_ref.trim() || !Array.isArray(route.capabilities) || !route.capabilities.includes('collect')) return fail('PAYMENT_PROVIDER_NOT_READY');
    }
    if (route.provider === 'flutterwave' && route.merchant_account_ref !== this.config.flutterwaveMerchant(status.currency)) return fail('PAYMENT_ROUTE_MISMATCH');
    try {
      const callback = new URL(this.config.callbackUrl());
      if ((callback.protocol !== 'https:' && !(callback.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(callback.hostname))) || callback.username || callback.password || callback.hash) return fail('PAYMENT_CALLBACK_UNAVAILABLE');
    } catch { return fail('PAYMENT_CALLBACK_UNAVAILABLE'); }
    const review = await this.db.from('driver_card_topup_sandbox_scopes').select('id,provider_account_id,policy_version,fee_passing_mode').eq('provider',route.provider).eq('method','card').eq('country_code',status.country).eq('currency_code',status.currency).eq('merchant_account_ref',route.merchant_account_ref).eq('tenant_id',tenant).eq('driver_id',id).eq('enabled',true).maybeSingle();
    const knownAccount=typeof review.data?.provider_account_id==='string'&&!!review.data.provider_account_id;
    const firstTest=this.config.allowFirstFlutterwaveTestAccount===true&&this.config.walletScopeRouting===true&&route.provider==='flutterwave'&&status.country==='NG'&&status.currency==='NGN'&&id==='318e6be9-9164-41fa-bb0c-c5ccd3526585'&&tenant==='d0e8e8e8-e8e8-e8e8-e8e8-d0e8e8e8e8e8'&&review.data?.provider_account_id===null;
    if(review.error || !review.data || !uuid(review.data.id) || review.data.policy_version!==DRIVER_SANDBOX_FEE_VERSION || review.data.fee_passing_mode!=='merchant' || (!knownAccount&&!firstTest))return fail('PAYMENT_SANDBOX_REVIEW_REQUIRED');
    this.adapter(route.provider,route.merchant_account_ref);
    return { country: status.country as string, currency: status.currency as string, merchant: route.merchant_account_ref as string,provider:route.provider as string,providerAccountId:knownAccount?review.data.provider_account_id as string:undefined };
  }
  private async attempt(id: string, owner: string, tenant: string) {
    const q = await this.db.from('wallet_topup_attempts').select('id,owner_id,tenant_id,country_code,currency_code,payment_provider,merchant_account_ref,provider_reference,amount_minor,provider_fee_minor,total_charge_minor,fee_policy_version,fee_exponent,destination_account_purpose,status,provider_account_id').eq('id',id).eq('owner_id',owner).eq('tenant_id',tenant).maybeSingle();
    const a=q.data;
    if (q.error || !a || a.id !== id || a.owner_id !== owner || a.tenant_id !== tenant || typeof a.payment_provider !== 'string' || a.destination_account_purpose !== 'driver_cash_credit' || !/^[A-Z]{3}$/.test(a.currency_code) || typeof a.merchant_account_ref !== 'string' || !a.merchant_account_ref.trim() || !a.fee_policy_version || !Number.isInteger(a.fee_exponent) || a.fee_exponent < 0 || a.fee_exponent > 3) return fail('TOPUP_NOT_AVAILABLE');
    const credit=minor(a.amount_minor),fee=minor(a.provider_fee_minor),total=minor(a.total_charge_minor);
    if (credit <= 0 || !Number.isSafeInteger(credit+fee) || credit+fee !== total) return fail('TOPUP_TERMS_UNAVAILABLE');
    return {...a, credit, fee, total};
  }
  async availability(token: string) {
    const user = await this.principal(token);
    if (!(await this.config.collectionEnabled()) || await this.db.rpc('driver_card_sandbox_enabled', {}) !== true) return fail('COLLECTION_DISABLED');
    const market = await this.market(user.id, user.tenant);
    const policy = await this.db.from('wallet_topup_fee_schedules').select('*').eq('provider',market.provider).eq('country_code',market.country).eq('currency_code',market.currency).eq('method','card').eq('active',true).maybeSingle();
    if (policy.error || !policy.data || typeof policy.data.version !== 'string' || !policy.data.version.trim() || !Number.isInteger(policy.data.exponent) || policy.data.exponent < 0 || policy.data.exponent > 3) return fail('PAYMENT_FEE_MISSING');
    assertApprovedDriverFee(policy.data);
    if (await this.db.rpc('wallet_currency_minor_exponent', {p_currency_code:market.currency}) !== policy.data.exponent) return fail('PAYMENT_FEE_MISSING');
    return {currency:market.currency, exponent:policy.data.exponent,feeLabel:DRIVER_SANDBOX_FEE_LABEL,feePolicyVersion:policy.data.version};
  }
  async createCheckout(token: string, input: { amountMinor: number; idempotencyKey: string; confirmedTotalMinor?: number }) {
    const user=await this.principal(token);
    if (!(await this.config.collectionEnabled()) || await this.db.rpc('driver_card_sandbox_enabled', {}) !== true) return fail('COLLECTION_DISABLED');
    if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0 || !uuid(input.idempotencyKey) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user.email)) return fail('INVALID_PAYMENT_INPUT');
    const m=await this.market(user.id,user.tenant);
    const policy=await this.db.from('wallet_topup_fee_schedules').select('*').eq('provider',m.provider).eq('country_code',m.country).eq('currency_code',m.currency).eq('method','card').eq('active',true).maybeSingle();
    if (policy.error || !policy.data || typeof policy.data.version !== 'string' || !policy.data.version.trim()) return fail('PAYMENT_FEE_MISSING');
    assertApprovedDriverFee(policy.data);
    const attemptId=await this.db.rpc<string>('initiate_wallet_topup',{p_attempt_key:`driver-topup:${user.id}:${input.idempotencyKey}`,p_tenant_id:user.tenant,p_owner_id:user.id,p_country_code:m.country,p_currency_code:m.currency,p_amount_minor:input.amountMinor,p_destination_account_purpose:'driver_cash_credit',p_payment_provider:m.provider,p_merchant_account_ref:m.merchant,p_provider_idempotency_identity:input.idempotencyKey});
    if (!uuid(attemptId)) return fail('TOPUP_RESULT_UNCONFIRMED');
    await this.db.rpc('freeze_wallet_topup_fee',{p_attempt_id:attemptId,p_fee_policy_version:policy.data.version});
    const a=await this.attempt(attemptId,user.id,user.tenant);
    if (a.currency_code !== m.currency || a.country_code !== m.country || a.merchant_account_ref !== m.merchant || a.credit !== input.amountMinor) return fail('TOPUP_TERMS_UNAVAILABLE');
    const quote = {attemptId,walletAmountMinor:a.credit,feeMinor:a.fee,totalChargeMinor:a.total,currency:a.currency_code,exponent:a.fee_exponent,feePolicyVersion:a.fee_policy_version,feeLabel:a.fee_policy_version===DRIVER_SANDBOX_FEE_VERSION?DRIVER_SANDBOX_FEE_LABEL:'Card/provider fee',provider:a.payment_provider};
    if (input.confirmedTotalMinor === undefined) return {kind:'quote' as const,...quote};
    if (!Number.isSafeInteger(input.confirmedTotalMinor) || input.confirmedTotalMinor !== a.total) return fail('TOPUP_QUOTE_MISMATCH');
    const adapter=this.adapter(a.payment_provider,a.merchant_account_ref);
    try{await adapter.preflight({reference:attemptId,merchantAccountRef:a.merchant_account_ref,currency:a.currency_code,amountMinor:a.total,exponent:a.fee_exponent,providerAccountId:a.provider_account_id??undefined,walletAmountMinor:a.credit,feeMinor:a.fee,email:user.email,redirectUrl:this.config.callbackUrl()});}
    catch(error){if(error instanceof PaymentLayerError&&error.code==='PAYMENT_CHECKOUT_TOTAL_MISMATCH')throw error;throw new PaymentLayerError('PAYMENT_PREFLIGHT_UNAVAILABLE','Provider check failed; no checkout submitted');}
    const claimed=await this.db.rpc<boolean>('claim_wallet_topup_submission',{p_attempt_id:attemptId});
    if (claimed !== true) return fail('PAYMENT_RECONCILIATION_REQUIRED');
    try {
      const checkout=await this.adapter(a.payment_provider,a.merchant_account_ref).createCheckout({reference:attemptId,merchantAccountRef:a.merchant_account_ref,currency:a.currency_code,amountMinor:a.total,exponent:a.fee_exponent,providerAccountId:a.provider_account_id??undefined,walletAmountMinor:a.credit,feeMinor:a.fee,email:user.email,redirectUrl:this.config.callbackUrl()});
      if (checkout.providerReference !== attemptId) return fail('TOPUP_RESULT_UNCONFIRMED');
      await this.db.rpc('record_wallet_topup_provider_reference',{p_attempt_id:attemptId,p_provider_reference:checkout.providerReference});
      return {kind:'checkout' as const,...quote,checkoutUrl:checkout.checkoutUrl,clientSecret:checkout.clientSecret};
    } catch (error) {
      try { await this.db.rpc('mark_wallet_topup_uncertain',{p_attempt_id:attemptId,p_reason:'submission or reference binding requires reconciliation'}); } catch { /* durable claim remains */ }
      throw error;
    }
  }
  async recover(token: string, attemptId: string): Promise<{status:'confirmed';creditedEventId:string}|{status:string;clientSecret?:string}> {
    const user=await this.principal(token);
    if (!uuid(attemptId)) return fail('INVALID_PAYMENT_INPUT');
    const a=await this.attempt(attemptId,user.id,user.tenant);
    const reference=a.provider_reference || attemptId;
    if (reference!==attemptId) return {status:'unknown'};
    const verified=await this.adapter(a.payment_provider,a.merchant_account_ref).verify({reference,merchantAccountRef:a.merchant_account_ref,currency:a.currency_code,amountMinor:a.total,exponent:a.fee_exponent,providerAccountId:a.provider_account_id??undefined});
    if (verified.reference!==reference||verified.merchantAccountRef!==a.merchant_account_ref||verified.currency!==a.currency_code||verified.chargedAmountMinor!==a.total) return fail('PAYMENT_RESPONSE_UNCONFIRMED');
    if (verified.finalStatus==='succeeded'){const r=await this.verify(token,attemptId);return {status:'confirmed',...r};}
    if (verified.finalStatus==='processing') return {status:'processing'};
    if (['requires_payment_method','requires_confirmation','requires_action'].includes(String(verified.finalStatus))) return {status:verified.finalStatus,clientSecret:(verified as any).clientSecret};
    return {status:String(verified.finalStatus||'unknown')};
  }
  async verify(token: string, attemptId: string): Promise<{ creditedEventId: string }> {
    const user=await this.principal(token);
    if (!uuid(attemptId)) return fail('INVALID_PAYMENT_INPUT');
    return this.verifyPrincipal(user,attemptId);
  }
  async verifyWebhook(attemptId:string){
    if(!uuid(attemptId)||!this.config.scopeAllowed)return fail('TOPUP_NOT_AVAILABLE');
    const r=await this.db.from('wallet_topup_attempts').select('owner_id,tenant_id').eq('id',attemptId).maybeSingle();
    if(r.error||!r.data||!this.config.scopeAllowed(r.data.owner_id,r.data.tenant_id))return fail('TOPUP_NOT_AVAILABLE');
    return this.verifyPrincipal({id:r.data.owner_id,tenant:r.data.tenant_id},attemptId);
  }
  private async verifyPrincipal(user:{id:string;tenant:string},attemptId:string){
    const a=await this.attempt(attemptId,user.id,user.tenant);
    const reference=a.provider_reference || attemptId;
    if (reference !== attemptId) return fail('TOPUP_TERMS_UNAVAILABLE');
    const verified=await this.adapter(a.payment_provider,a.merchant_account_ref).verify({reference,merchantAccountRef:a.merchant_account_ref,currency:a.currency_code,amountMinor:a.total,exponent:a.fee_exponent,providerAccountId:a.provider_account_id??undefined});
    if (verified.reference !== reference || verified.merchantAccountRef !== a.merchant_account_ref || verified.currency !== a.currency_code || verified.chargedAmountMinor !== a.total || verified.finalStatus !== 'succeeded') return fail('PAYMENT_RESPONSE_UNCONFIRMED');
    if (!a.provider_reference) await this.db.rpc('record_wallet_topup_provider_reference',{p_attempt_id:attemptId,p_provider_reference:reference});
    const event=await this.db.rpc<string>('confirm_wallet_topup_with_total',{p_attempt_id:attemptId,p_verified_provider_reference:reference,p_verified_merchant_account_ref:a.merchant_account_ref,p_verified_currency:a.currency_code,p_verified_total_minor:a.total,p_final_status:'succeeded'});
    if (!uuid(event)) return fail('TOPUP_RESULT_UNCONFIRMED');
    return {creditedEventId:event};
  }
}
