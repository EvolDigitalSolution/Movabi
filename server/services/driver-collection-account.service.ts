import {DriverPaymentAccountService} from './driver-payment-account.service';
import {FlutterwaveCollectionSubaccount,sandboxSubaccountProvider,type SubaccountInput,type SubaccountTerms} from './payments/flutterwave-collection-subaccount';

export const SETUP_ONLY_COLLECTION_STORE=Object.freeze({markets:'driver_collection_setup_markets',accounts:'driver_collection_setup_accounts',claim:'claim_driver_collection_setup',explicitApprovals:true});
const LEGACY_COLLECTION_STORE=Object.freeze({markets:'driver_collection_markets',accounts:'driver_collection_subaccounts',claim:'claim_driver_collection_subaccount',explicitApprovals:false});

export class DriverCollectionAccountService {
 constructor(private db:any,private accounts:DriverPaymentAccountService,private provider:(merchant?:string)=>FlutterwaveCollectionSubaccount=sandboxSubaccountProvider,private allowedScope:(scope:any)=>boolean=()=>true,private store:{markets:string;accounts:string;claim:string;explicitApprovals:boolean}=LEGACY_COLLECTION_STORE){}
 async scope(driverId:string){
  const base=await this.accounts.scope(driverId);
  const result=await this.db.from(this.store.markets).select('*').eq('country_code',base.country).eq('currency_code',base.currency).maybeSingle();
  if(result.error)throw new Error('Collection account configuration unavailable.');return {...base,market:result.data};
 }
 private approved(s:any){return this.allowedScope(s)&&(!this.store.explicitApprovals||(s.market?.merchant_identity_verified===true&&s.market?.administrative_default_approved===true))&&s.country==='NG'&&s.currency==='NGN'&&s.market?.provider==='flutterwave'&&s.market.environment==='test'
  &&s.market.setup_approved===true&&s.market.adapter_ready===true&&!!s.market.capability_evidence_ref
  &&s.market.sandbox_driver_id===s.driverId&&s.market.sandbox_tenant_id===s.tenant&&!!s.market.merchant_account_ref
  &&['flat','percentage'].includes(s.market.default_split_type)&&s.market.default_split_value!==null;}
 private async authorize(driverId:string){const s=await this.scope(driverId);if(!this.approved(s))throw new Error('Collection account setup unavailable.');this.provider(s.market.merchant_account_ref);return s;}
 async record(s:any){
  const result=await this.db.from(this.store.accounts).select('*').eq('driver_id',s.driverId).eq('tenant_id',s.tenant)
   .eq('country_code',s.country).eq('currency_code',s.currency).eq('merchant_account_ref',s.market.merchant_account_ref).eq('environment','test').maybeSingle();
  if(result.error)throw new Error('Collection account status unavailable.');return result.data;
 }
 async status(driverId:string){
  const base=await this.accounts.scope(driverId);
  if(base.country==='GB'&&base.currency==='GBP')return this.accounts.status(driverId);
  const s=await this.scope(driverId);
  if(!this.approved(s))return {provider:s.market?.provider||base.market?.provider||null,state:'unavailable',available:false,purpose:'collection_subaccount'};
  try{this.provider(s.market.merchant_account_ref);}catch{return {provider:'flutterwave',state:'unavailable',available:false,purpose:'collection_subaccount'};}
  const row=await this.record(s);
  return this.view(row,s.market.f4b_approved===true);
 }
 private view(row:any,f4b=false){return {provider:'flutterwave',purpose:'collection_subaccount',state:row?.state||'not_started',available:true,
  accountTypes:f4b?['bank','flutterwave']:['bank'],last4:row?.last4||null,reconcileOnly:!!row&&row.state!=='completed',
  verification:row?.verification||null};}
 async banks(driverId:string){const s=await this.authorize(driverId);return this.provider(s.market.merchant_account_ref).banks();}
 async resolve(driverId:string,kind:string,bank:string,number:string){
  const s=await this.authorize(driverId);if(kind==='flutterwave'&&s.market.f4b_approved!==true)throw new Error('This account type is not approved.');
  return this.provider(s.market.merchant_account_ref).resolve(kind,bank,number);
 }
 private terms(row:any):SubaccountTerms{return {operationId:row.id,requestHash:row.request_hash,destinationHash:row.destination_hash,accountType:row.account_type,last4:row.last4,
  defaultSplitType:row.default_split_type,defaultSplitValue:String(row.default_split_value)};}
 private async save(row:any,result:any){
  const saved=await this.db.from(this.store.accounts).update({state:'completed',subaccount_id:result.id,provider_numeric_id:result.numericId,
   verification:'retrieved',updated_at:new Date().toISOString()}).eq('id',row.id).eq('request_hash',row.request_hash).select('id');
  if(saved.error||saved.data?.length!==1)throw new Error('Setup needs reconciliation.');return this.view({...row,state:'completed',verification:'retrieved'});
 }
 async reconcile(driverId:string){
  const s=await this.authorize(driverId);const row=await this.record(s);if(!row)return this.view(null,s.market.f4b_approved);
  const found=await this.provider(s.market.merchant_account_ref).reconcile(this.terms(row));
  if(found)return this.save(row,found);
  // Absence from a list is never proof that a timed-out creation did not happen.
  await this.db.from(this.store.accounts).update({state:'action_required',updated_at:new Date().toISOString()}).eq('id',row.id);
  return {...this.view({...row,state:'action_required'}),reconciliationReason:'not_found_yet',creationPermitted:false};
 }
 async setup(driverId:string,input:SubaccountInput){
  const s=await this.authorize(driverId);const provider=this.provider(s.market.merchant_account_ref);provider.validate(input);
  if(input.accountType==='flutterwave'&&s.market.f4b_approved!==true)throw new Error('This account type is not approved.');
  const old=await this.record(s);if(old)return this.reconcile(driverId); // Never repeat POST, even after timeout or changed input.
  const name=await provider.resolve(input.accountType,input.bankCode,input.accountNumber);
  if(!input.confirmedName||name!==input.confirmedName)throw new Error('Check and confirm the resolved account name again.');
  const requestHash=provider.hash(JSON.stringify({driverId,tenant:s.tenant,country:s.country,currency:s.currency,environment:'test',merchant:s.market.merchant_account_ref,
   name:input.name.trim(),email:input.email.trim(),phone:input.phone,kind:input.accountType,destination:provider.destinationHash(input),
   splitType:s.market.default_split_type,splitValue:String(s.market.default_split_value)}));
  const claim=await this.db.rpc(this.store.claim,{p_driver:driverId,p_tenant:s.tenant,p_merchant:s.market.merchant_account_ref,
   p_request_hash:requestHash,p_destination_hash:provider.destinationHash(input),p_account_type:input.accountType,p_last4:input.accountNumber.slice(-4)});
  if(claim.error)throw new Error('Setup claim unavailable.');
  const row=claim.data?.[0];if(!row)return this.reconcile(driverId);
  try{return await this.save(row,await provider.create(input,this.terms(row)));}
  catch{
   await this.db.from(this.store.accounts).update({state:'action_required',updated_at:new Date().toISOString()}).eq('id',row.id).neq('state','completed');
   throw new Error('Setup outcome is uncertain. Use Check setup status; do not create another account.');
  }
 }
 async ready(driverId:string){const s=await this.authorize(driverId);const account=await this.record(s);if(account?.state!=='completed'||!account.subaccount_id)throw new Error('Collection account setup incomplete.');const verified=await this.provider(s.market.merchant_account_ref).reconcile(this.terms(account));if(!verified||verified.id!==account.subaccount_id)throw new Error('Collection account must be reverified.');return {...s,account};}
}
