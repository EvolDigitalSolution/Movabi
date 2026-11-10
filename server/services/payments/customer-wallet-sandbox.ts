import {startupKoraCollection,KoraCollectionError} from './wallet-collection-startup';
import type {StartupKoraCollection,FrozenKoraTerms} from './wallet-collection-startup';
export class WalletSandboxError extends Error{
 status:number;code:string;constructor(status:number,code:string){super(code);this.status=status;this.code=code;}
}
const bad=(status:number,code:string):never=>{throw new WalletSandboxError(status,code);};
const uuid=(x:unknown):x is string=>typeof x==='string'&&/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(x);
export class CustomerWalletSandbox{
 private db:any;private transport:StartupKoraCollection;
 constructor(db:any,transport:StartupKoraCollection=startupKoraCollection){this.db=db;this.transport=transport;}
 private async rpc(name:string,args:any){const {data,error}=await this.db.rpc(name,args);if(error){const map:Record<string,[number,string]>={BL001:[404,'SANDBOX_ATTEMPT_UNAVAILABLE'],BL002:[400,'INVALID_SANDBOX_INPUT'],BL003:[409,'SANDBOX_REPLAY_CONFLICT'],BL004:[409,'SANDBOX_NOT_ENABLED_OR_ELIGIBLE'],BL005:[409,'SANDBOX_EVIDENCE_MISMATCH'],BL006:[409,'SANDBOX_HISTORY_PROTECTED']};const v=map[String(error.code)]||[503,'SANDBOX_STORAGE_UNAVAILABLE'];return bad(v[0],v[1]);}return data;}
 private terms(a:any):FrozenKoraTerms{
  if(!a||!uuid(a.id)||!uuid(a.owner_id)||a.provider!=='kora'||a.mode!=='test'||!['initiated','submitting','provider_pending','uncertain','verified_test_only','failed'].includes(a.status)
   ||typeof a.amount_minor!=='string'||!/^[1-9][0-9]{0,18}$/.test(a.amount_minor)||typeof a.credential_fingerprint!=='string'||!/^[0-9a-f]{64}$/.test(a.credential_fingerprint)||typeof a.merchant_account_ref!=='string'
   ||typeof a.reference!=='string'||!/^[A-Za-z0-9_-]{8,100}$/.test(a.reference)||typeof a.currency_code!=='string'||!/^[A-Z]{3}$/.test(a.currency_code)||!Number.isInteger(a.minor_exponent)||a.minor_exponent<0||a.minor_exponent>3)return bad(503,'SANDBOX_RESPONSE_UNAVAILABLE');
  const amount=BigInt(a.amount_minor);if(amount>9223372036854775807n)return bad(503,'SANDBOX_RESPONSE_UNAVAILABLE');
  return {provider:'kora',mode:'test',credentialFingerprint:a.credential_fingerprint,merchantAccountRef:a.merchant_account_ref,reference:a.reference,currency:a.currency_code,minorExponent:a.minor_exponent,amountMinor:amount};
 }
 private public(a:any){this.terms(a);if(a.checkout_url!=null&&(typeof a.checkout_url!=='string'||!/^https:\/\/(test-checkout[.]korapay[.]com|checkout[.]korapay[.]com)\//.test(a.checkout_url)))return bad(503,'SANDBOX_RESPONSE_UNAVAILABLE');return {attemptId:a.id,currency:a.currency_code,amountMinor:a.amount_minor,status:a.status,testOnly:true,spendableCredit:false,...(a.status==='provider_pending'&&a.checkout_url?{checkoutUrl:a.checkout_url}:{})};}
 private async get(owner:string,id:string){if(!uuid(owner)||!uuid(id))return bad(400,'INVALID_SANDBOX_INPUT');const a=await this.rpc('get_customer_wallet_sandbox_v1l',{p_owner:owner,p_id:id});if(a?.owner_id!==owner||a?.id!==id)return bad(503,'SANDBOX_RESPONSE_UNAVAILABLE');this.terms(a);return a;}
 async eligibility(owner:string){
  if(!uuid(owner))return bad(401,'AUTH_REQUIRED');
  if(this.transport.status().mode!=='test'||!this.transport.status().merchantConfigured)return {eligible:false};
  let returnOrigin:string;try{const u=new URL(process.env.KORA_COLLECTION_RETURN_URL||'');if(u.protocol!=='https:'||u.username||u.password||u.hash)return {eligible:false};returnOrigin=u.origin;}catch{return {eligible:false};}
  const r=await this.rpc('customer_wallet_sandbox_eligibility_v1m',{p_owner:owner});
  if(r?.eligible===false)return {eligible:false};
  if(!r||r.eligible!==true||r.ownerId!==owner||r.testOnly!==true||r.spendableCredit!==false||typeof r.currency!=='string'||!/^[A-Z]{3}$/.test(r.currency)||!Number.isInteger(r.minorExponent)||r.minorExponent<0||r.minorExponent>3||typeof r.limitMinor!=='string'||!/^[1-9][0-9]{0,18}$/.test(r.limitMinor)||BigInt(r.limitMinor)>BigInt(Number.MAX_SAFE_INTEGER))return bad(503,'SANDBOX_RESPONSE_UNAVAILABLE');
  return {eligible:true,ownerId:owner,currency:r.currency,minorExponent:r.minorExponent,limitMinor:r.limitMinor,testOnly:true,spendableCredit:false,returnOrigin};
 }
 async status(owner:string,id:string){return this.public(await this.get(owner,id));}
 private async record(a:any,status:string,checkout:string|null=null){const t=this.terms(a);const updated=await this.rpc('record_customer_wallet_sandbox_v1l',{p_owner:a.owner_id,p_id:a.id,p_fingerprint:t.credentialFingerprint,p_status:status,p_reference:t.reference,p_currency:t.currency,p_amount:t.amountMinor.toString(),p_checkout:checkout});if(updated?.id!==a.id||updated?.owner_id!==a.owner_id)return bad(503,'SANDBOX_RESPONSE_UNAVAILABLE');return updated;}
 async begin(owner:string,email:string,input:any){
  if(!uuid(owner)||!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).sort().join(',')!=='amountMinor,idempotencyKey'||!uuid(input.idempotencyKey)||typeof input.amountMinor!=='string'||!/^[1-9][0-9]{0,18}$/.test(input.amountMinor)||BigInt(input.amountMinor)>9223372036854775807n)return bad(400,'INVALID_SANDBOX_INPUT');
  if(typeof email!=='string'||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return bad(409,'VERIFIED_CUSTOMER_EMAIL_REQUIRED');
  const identity=this.transport.serverIdentity();if(identity.mode!=='test')return bad(409,'SANDBOX_TEST_KEY_REQUIRED');
  const a=await this.rpc('prepare_customer_wallet_sandbox_v1l',{p_owner:owner,p_key:input.idempotencyKey,p_amount:input.amountMinor,p_merchant:identity.merchantAccountRef,p_fingerprint:identity.credentialFingerprint});
  if(a?.owner_id!==owner)return bad(503,'SANDBOX_RESPONSE_UNAVAILABLE');
  const t=this.terms(a);if(t.amountMinor.toString()!==input.amountMinor||t.mode!==identity.mode||t.merchantAccountRef!==identity.merchantAccountRef||t.credentialFingerprint!==identity.credentialFingerprint)return bad(503,'SANDBOX_RESPONSE_UNAVAILABLE');
  if(a.status!=='initiated')return this.public(a); // poll/reconcile; never blind creation replay
  const store={
   claim:async()=>{const claimed=await this.rpc('claim_customer_wallet_sandbox_v1l',{p_owner:owner,p_id:a.id,p_fingerprint:t.credentialFingerprint});if(typeof claimed!=='boolean')return bad(503,'SANDBOX_RESPONSE_UNAVAILABLE');return claimed;},
   submitted:async(_r:string,url:string)=>{await this.record(a,'provider_pending',url);},
   uncertain:async()=>{await this.record(a,'uncertain');}
  };
  try{
   const checkout=await this.transport.create(t,{provider:'kora',merchantAccountRef:t.merchantAccountRef,currency:t.currency,minorExponent:t.minorExponent,collectionEnabled:true,destinationReady:true,merchantApproved:true,adapterReady:true,capabilities:['collect']},email,store);
   return {...this.public({...a,status:'provider_pending'}),checkoutUrl:checkout.checkoutUrl};
  }catch(e){if(e instanceof KoraCollectionError)return bad(409,e.code);throw e;}
 }
 async reconcile(owner:string,id:string){
  const a=await this.get(owner,id);if(['verified_test_only','failed'].includes(a.status))return this.public(a);
  if(a.status==='initiated')return this.public(a);
  try{const verified=await this.transport.verify(this.terms(a));
   const state=verified.finalStatus==='succeeded'?'verified_test_only':verified.finalStatus==='failed'?'failed':'uncertain';
   return this.public(await this.record(a,state));
  }catch(e){if(e instanceof KoraCollectionError)return bad(409,e.code);throw e;}
 }
 async webhook(data:any,signature:unknown){
  if(!this.transport.authenticWebhook(data,signature))return bad(401,'INVALID_SANDBOX_SIGNATURE');
  if(typeof data.reference!=='string'||!/^[A-Za-z0-9_-]{8,100}$/.test(data.reference))return bad(400,'INVALID_SANDBOX_INPUT');
  const a=await this.rpc('lookup_customer_wallet_sandbox_v1l',{p_reference:data.reference});if(!a)return {received:true};
  this.terms(a);await this.reconcile(a.owner_id,a.id);return {received:true};
 }
}
