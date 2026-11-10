import {payoutMarketReady, type Beneficiary} from '../services/payments/flutterwave-driver-payout';
export interface DriverPayoutAdapter{
 banks():Promise<{code:string;name:string}[]>;
 resolve(bank:string,account:string):Promise<string>;
 createBeneficiary(bank:string,account:string,confirmedName?:string,beforeSubmit?:()=>Promise<void>,afterCreated?:(b:Beneficiary)=>Promise<void>):Promise<Beneficiary>;
 verifyBeneficiary(expected:Beneficiary):Promise<void>;
 fingerprint(bank:string,account:string):string;
}

export const APPROVED_DRIVER='318e6be9-9164-41fa-bb0c-c5ccd3526585';
export const APPROVED_TENANT='d0e8e8e8-e8e8-e8e8-e8e8-d0e8e8e8e8e8';
type Provider=(provider:string,merchant:string)=>DriverPayoutAdapter;
const blocked=(stage='blocked')=>{const e=new Error('Payment account setup is unavailable or requires support review.');(e as any).stage=stage;return e;};

/** Instance-owned dependencies. This service cannot complete compliance or move money. */
export class SetupService {
 constructor(private db:any,private provider:Provider){}
 async scope(id:string){
  const {data:p,error}=await this.db.from('profiles').select('id,tenant_id,role,registration_activated_at,registration_country_code,country_code').eq('id',id).single();
  if(error||!p||p.id!==id||p.role!=='driver'||!p.registration_activated_at)throw blocked();
  const country=String(p.registration_country_code||p.country_code||'').toUpperCase();
  // GB status is owned by the existing Stripe route/UI, never by this closure.
  if(country==='GB')return {stripe:true,p};
  if(id!==APPROVED_DRIVER||p.tenant_id!==APPROVED_TENANT||country!=='NG')throw blocked();
  const currencies=await this.db.from('market_availability').select('supported_currency').eq('country_code','NG');
  const values=[...new Set((currencies.data||[]).map((m:any)=>String(m.supported_currency).toUpperCase()))];
  if(currencies.error||values.length!==1||values[0]!=='NGN')throw blocked();
  const m=await this.db.from('driver_payout_markets').select('*').eq('country_code','NG').eq('currency_code','NGN').maybeSingle();
  if(m.error)throw blocked();return {stripe:false,p,market:m.data};
 }
 private async authorized(id:string){const s=await this.scope(id);const m=s.market;
  if(s.stripe||!payoutMarketReady(m)||m.sandbox_driver_id!==id||m.sandbox_tenant_id!==s.p.tenant_id)throw blocked();
  return {s,provider:this.provider(m.provider,m.merchant_account_ref)};
 }
 private async row(id:string,merchant:string){const r=await this.db.from('driver_payment_accounts').select('*').eq('driver_id',id).eq('tenant_id',APPROVED_TENANT).eq('country_code','NG').eq('currency_code','NGN').eq('merchant_account_ref',merchant).maybeSingle();if(r.error)throw blocked();return r.data;}
 async status(id:string){const s=await this.scope(id);if(s.stripe)return {provider:'stripe',available:false,state:'unavailable',delegated:true};
  if(!payoutMarketReady(s.market))return {provider:s.market?.provider||'flutterwave',available:false,state:'unavailable'};
  const {provider}=await this.authorized(id);void provider;const r=await this.row(id,s.market.merchant_account_ref);
  return {provider:s.market.provider,available:true,state:r?.state||'not_started',last4:r?.last4||null,reconcileOnly:!!r?.submission_attempted_at&&r.state!=='completed'};
 }
 async banks(id:string){return (await this.authorized(id)).provider.banks();}
 async resolve(id:string,bank:string,account:string){return (await this.authorized(id)).provider.resolve(bank,account);}
 private async update(row:any,values:any,states:string[]=['in_progress']){
  const r=await this.db.from('driver_payment_accounts').update({...values,updated_at:new Date().toISOString()}).eq('id',row.id).eq('setup_token',row.setup_token).in('state',states).select('id');
  if(r.error||r.data?.length!==1)throw blocked();
 }
 async setup(id:string,bank:string,account:string,name:string){
  if(!name.trim())throw blocked();const {s,provider}=await this.authorized(id);
  const fingerprint=provider.fingerprint(bank,account);const previous=await this.row(id,s.market.merchant_account_ref);
  if(previous?.state==='completed'){if(previous.fingerprint!==fingerprint)throw blocked();return {state:'completed',last4:previous.last4};}
  const claim=await this.db.rpc('claim_driver_payment_setup',{p_driver:id,p_tenant:APPROVED_TENANT,p_country:'NG',p_currency:'NGN',p_merchant:s.market.merchant_account_ref});
  if(claim.error){const e=blocked('claim') as any;e.code=claim.error.code||null;throw e;}
  if(!Array.isArray(claim.data)||claim.data.length!==1){const e=blocked('claim_shape') as any;e.code=typeof claim.data+':'+(Array.isArray(claim.data)?claim.data.length:'non-array');throw e;}
  const row=claim.data[0];
  try{
   const b=await provider.createBeneficiary(bank,account,name,async()=>{
    const r=await this.db.rpc('fence_driver_payment_setup',{p_id:row.id,p_token:row.setup_token,p_bank:bank,p_last4:account.slice(-4),p_fingerprint:fingerprint});
    if(r.error||r.data!==true){const e=blocked('fence') as any;e.code=r.error?(r.error.code||null):('data:'+typeof r.data);throw e;}
   },async b=>this.update(row,{beneficiary_id:b.id}));
   await this.update(row,{state:'completed',beneficiary_id:b.id});return {state:'completed',last4:b.last4};
  }catch(setupErr){
   // A pre-contact failure may be reclaimed after the lease; a fenced attempt
   // is reconciliation-only even when no provider identifier was persisted.
   const current=await this.row(id,s.market.merchant_account_ref);
   if(current?.setup_token===row.setup_token&&current.submission_attempted_at){try{await this.update(row,{state:'reconciliation_required'});}catch{}}
   const e=blocked('provider') as any;if((setupErr as any)?.stage){e.stage=(setupErr as any).stage;e.code=(setupErr as any).code||null;}
   throw e;
  }
 }
 /** GET-only retry of a persisted candidate. Never calls creation. */
 async reconcile(id:string){const {s,provider}=await this.authorized(id);const r=await this.row(id,s.market.merchant_account_ref);
  if(r?.state==='completed')return this.status(id);
  if(!r?.submission_attempted_at||!r.beneficiary_id)return {...await this.status(id),supportRequired:true};
  const expected:Beneficiary={id:r.beneficiary_id,bank_code:r.bank_code,last4:r.last4,fingerprint:r.fingerprint};
  await provider.verifyBeneficiary(expected);
  await this.update(r,{state:'completed'},['in_progress','reconciliation_required']);return this.status(id);
 }
}
