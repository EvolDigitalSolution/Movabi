import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
export type KoraMode='test'|'live';
export class KoraCollectionError extends Error {
 code:string;
 constructor(code:string){super(code);this.code=code;}
}
const stop=(code:string):never=>{throw new KoraCollectionError(code);};
const clean=(v:unknown)=>typeof v==='string'?v:'';
const https=(v:string)=>{try{const u=new URL(v);if(u.protocol!=='https:'||u.username||u.password||u.hash||u.port&&u.port!=='443')return stop('INVALID_SERVER_CALLBACK');return u.href;}catch{return stop('INVALID_SERVER_CALLBACK');}};
export interface FrozenKoraTerms{
 provider:'kora';mode:KoraMode;credentialFingerprint:string;merchantAccountRef:string;
 reference:string;currency:string;minorExponent:number;amountMinor:bigint;
}
export interface KoraCollectionPolicy{
 collectionEnabled:boolean;destinationReady:boolean;merchantApproved:boolean;adapterReady:boolean;
 provider:'kora';merchantAccountRef:string;currency:string;minorExponent:number;capabilities:readonly string[];
}
export interface KoraSubmissionStore{
 /** Must commit a unique durable claim AND the exact frozen terms before returning true. */
 claim(terms:Readonly<FrozenKoraTerms>):Promise<boolean>;
 /** A durable ambiguous claim must remain non-retryable even when this write fails. */
 submitted(reference:string,checkoutUrl:string):Promise<void>;
 uncertain(reference:string):Promise<void>;
}
export function exactKoraMinor(value:unknown,exponent:number):bigint{
 if(typeof value!=='string'&&typeof value!=='number')return stop('PROVIDER_RESPONSE_UNCONFIRMED');
 if(!Number.isInteger(exponent)||exponent<0||exponent>3)return stop('INVALID_CURRENCY_EXPONENT');
 const m=/^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/.exec(String(value));
 if(!m)return stop('PROVIDER_RESPONSE_UNCONFIRMED');
 const decimals=m[2]||'';
 if(decimals.length>exponent&&/[1-9]/.test(decimals.slice(exponent)))return stop('PROVIDER_RESPONSE_UNCONFIRMED');
 const result=BigInt(m[1])*10n**BigInt(exponent)+BigInt(decimals.slice(0,exponent).padEnd(exponent,'0')||'0');
 if(result>9223372036854775807n)return stop('PROVIDER_RESPONSE_UNCONFIRMED');
 return result;
}
/** Immutable per-process configuration; no fallback to another key or provider. */
export class StartupKoraCollection{
 private key:string;private account:string;private mode:KoraMode|null;private fingerprint:string;
 private returnUrl:string;private notificationUrl:string;
 private request:typeof fetch;
 constructor(env:NodeJS.ProcessEnv,request:typeof fetch=fetch){
  this.request=request;
  this.key=clean(env.KORA_SECRET_KEY);this.account=clean(env.KORA_MERCHANT_ACCOUNT_REF);
  this.mode=/^sk_test_[A-Za-z0-9_-]+$/.test(this.key)?'test':/^sk_live_[A-Za-z0-9_-]+$/.test(this.key)?'live':null;
  this.fingerprint=this.mode?createHash('sha256').update(this.key).digest('hex'):'';
  this.returnUrl=clean(env.KORA_COLLECTION_RETURN_URL);this.notificationUrl=clean(env.KORA_COLLECTION_NOTIFICATION_URL);
 }
 serverIdentity(){if(!this.mode||!this.account)return stop('KORA_STARTUP_CONFIGURATION_UNAVAILABLE');return Object.freeze({provider:'kora' as const,mode:this.mode,credentialFingerprint:this.fingerprint,merchantAccountRef:this.account});}
 status(){return {provider:'kora',configured:!!this.key,mode:this.mode||'unconfirmed',merchantConfigured:!!this.account&&this.account===this.account.trim(),collectionEnabled:false};}
 freeze(reference:string,currency:string,minorExponent:number,amountMinor:bigint):Readonly<FrozenKoraTerms>{
  if(!this.mode||!this.account||this.account!==this.account.trim())return stop('KORA_STARTUP_CONFIGURATION_UNAVAILABLE');
  if(!/^[A-Za-z0-9_-]{8,100}$/.test(reference)||!/^[A-Z]{3}$/.test(currency)||!Number.isInteger(minorExponent)||minorExponent<0||minorExponent>3
   ||typeof amountMinor!=='bigint'||amountMinor<=0n||amountMinor>9223372036854775807n)return stop('INVALID_COLLECTION_TERMS');
  return Object.freeze({provider:'kora',mode:this.mode,credentialFingerprint:this.fingerprint,merchantAccountRef:this.account,reference,currency,minorExponent,amountMinor});
 }
 private original(t:FrozenKoraTerms){
  const v=this.freeze(t.reference,t.currency,t.minorExponent,t.amountMinor);
  if(t.provider!=='kora'||t.mode!==v.mode||t.credentialFingerprint!==v.credentialFingerprint||t.merchantAccountRef!==v.merchantAccountRef)return stop('ORIGINAL_COLLECTION_CREDENTIAL_REQUIRED');
 }
 private async call(path:string,body?:unknown){
  try{
   const response=await this.request('https://api.korapay.com/merchant/api/v1'+path,{method:body===undefined?'GET':'POST',redirect:'error',headers:{Authorization:'Bearer '+this.key,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(15000)});
   if(!response.ok)return stop('PROVIDER_RESPONSE_UNCONFIRMED');
   const value:any=await response.json();if(value?.status!==true||!value.data||typeof value.data!=='object'||Array.isArray(value.data))return stop('PROVIDER_RESPONSE_UNCONFIRMED');return value.data;
  }catch{return stop('PROVIDER_RESPONSE_UNCONFIRMED');}
 }
 async create(t:FrozenKoraTerms,policy:KoraCollectionPolicy,email:string,store:KoraSubmissionStore){
  this.original(t);
  if(!policy.collectionEnabled||!policy.destinationReady||!policy.merchantApproved||!policy.adapterReady||!policy.capabilities.includes('collect'))return stop('COLLECTION_NOT_READY');
  if(policy.provider!=='kora'||policy.merchantAccountRef!==t.merchantAccountRef||policy.currency!==t.currency||policy.minorExponent!==t.minorExponent)return stop('COLLECTION_POLICY_MISMATCH');
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return stop('INVALID_CUSTOMER_EMAIL');
  const redirectUrl=https(this.returnUrl),notificationUrl=https(this.notificationUrl);
  const divisor=10n**BigInt(t.minorExponent),major=t.amountMinor/divisor,minor=t.amountMinor%divisor;
  const amount=Number(major.toString()+(t.minorExponent?'.'+minor.toString().padStart(t.minorExponent,'0'):''));
  if(t.amountMinor>BigInt(Number.MAX_SAFE_INTEGER)||!Number.isFinite(amount)||exactKoraMinor(amount,t.minorExponent)!==t.amountMinor)return stop('COLLECTION_AMOUNT_NOT_REPRESENTABLE');
  if(!await store.claim(t))return stop('COLLECTION_RECONCILIATION_REQUIRED');
  try{
   const data=await this.call('/charges/initialize',{reference:t.reference,currency:t.currency,amount,customer:{email},channels:['card'],redirect_url:redirectUrl,notification_url:notificationUrl,merchant_bears_cost:true});
   if(data.reference!==t.reference)return stop('PROVIDER_RESPONSE_UNCONFIRMED');
   const checkout=new URL(https(data.checkout_url));
   const hosts=this.mode==='test'?['test-checkout.korapay.com','checkout.korapay.com']:['checkout.korapay.com'];
   if(!hosts.includes(checkout.hostname))return stop('PROVIDER_RESPONSE_UNCONFIRMED');
   await store.submitted(t.reference,checkout.href);
   return {provider:'kora' as const,reference:t.reference,checkoutUrl:checkout.href,status:'pending' as const};
  }catch{try{await store.uncertain(t.reference);}catch{/* committed claim is retained */}return stop('COLLECTION_RECONCILIATION_REQUIRED');}
 }
 /** Reconciliation does not require collectionEnabled. Persisted terms are mandatory. */
 async verify(t:FrozenKoraTerms){
  this.original(t);
  const data=await this.call('/charges/'+encodeURIComponent(t.reference));
  if(data.reference!==t.reference||data.currency!==t.currency||exactKoraMinor(data.amount,t.minorExponent)!==t.amountMinor)return stop('VERIFICATION_TERMS_MISMATCH');
  const status=data.status==='success'?'succeeded':data.status==='failed'?'failed':['pending','processing'].includes(data.status)?'pending':'unknown';
  if(status==='succeeded'&&exactKoraMinor(data.amount_paid,t.minorExponent)!==t.amountMinor)return stop('VERIFICATION_TERMS_MISMATCH');
  return {provider:'kora' as const,reference:t.reference,merchantAccountRef:t.merchantAccountRef,currency:t.currency,amountMinor:t.amountMinor,finalStatus:status};
 }
 authenticWebhook(data:unknown,signature:unknown){
  if(!this.mode||!data||typeof data!=='object'||Array.isArray(data)||typeof signature!=='string'||!/^[a-fA-F0-9]{64}$/.test(signature))return false;
  const expected=createHmac('sha256',this.key).update(JSON.stringify(data)).digest();return timingSafeEqual(expected,Buffer.from(signature,'hex'));
 }
}
// Loading captures credentials once. It never performs a provider request.
export const startupKoraCollection=new StartupKoraCollection(process.env);
