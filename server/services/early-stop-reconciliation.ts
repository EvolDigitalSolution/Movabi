import {providerCurrencyOption} from './payments/provider-currency-options';
import {stripeApiAmountFromLedger} from './payments/stripe-currency-amounts';
import {currencyDecimals,toCurrencyMinor} from '../../src/app/shared/utils/currency-money';
import type {MarketPaymentRoute} from './payments/market-payment-registry';
import {assertOriginalRoute,type PaymentBinding,type PaymentCapability} from './payments/payment-contracts';
export interface EarlyStopReconciliationInput {
 job:any;calculation:any;binding:PaymentBinding|null;policies:readonly MarketPaymentRoute[];marketPaymentEnabled:boolean;
}
export interface EarlyStopReconciliationPlan {
 country:string;currency:string;exponent:number;provider:'stripe'|'kora'|null;amountMinor:number;originalMinor:number;
 action:'verify_original_payment'|'verify_before_capture'|'verify_before_release'|'verify_before_refund'|'authorise_then_capture'|'no_collection'|'review';
 reason:string;adjustmentMinor:number|null;providerAmountPreview?:{currency:string;operation:'charge'|'refund';apiAmount:number};executionEnabled:false;bookingUpdated:false;paymentUpdated:false;
}
/** A preview only. Never turns job payment_status into proof of provider payment. */
export function planEarlyStopReconciliation(input:EarlyStopReconciliationInput):EarlyStopReconciliationPlan {
 const {job,calculation:c,binding,policies}=input;
 const country=job?.country_code,currency=job?.currency_code;
 if(typeof country!=='string'||!/^[A-Z]{2}$/.test(country)||typeof currency!=='string'||!/^[A-Z]{3}$/.test(currency))throw Error('RECONCILIATION_INVALID_MARKET');
 const exponent=currencyDecimals(currency);
 if(!c||c.currency!==currency||c.exponent!==exponent||c.policyVersion!=='early-stop-distance-prorata-v1'
  ||![c.amountMinor,c.originalMinor].every(n=>Number.isSafeInteger(n)&&n>=0)||c.originalMinor<=0||c.amountMinor>c.originalMinor
  ||job.fare_breakdown?.currency!==currency||toCurrencyMinor(Number(job.fare_breakdown?.customerCharge),currency)!==c.originalMinor)
  throw Error('RECONCILIATION_INVALID_TERMS');
 const base:EarlyStopReconciliationPlan={country,currency,exponent,provider:null,amountMinor:c.amountMinor,originalMinor:c.originalMinor,
  action:'review',reason:'PAYMENT_ROUTE_NOT_CONFIGURED',adjustmentMinor:null,executionEnabled:false,bookingUpdated:false,paymentUpdated:false};
 const review=(reason:string)=>({...base,action:'review' as const,reason});
 const decision=(action:EarlyStopReconciliationPlan['action'],reason:string,adjustmentMinor:number|null=null):EarlyStopReconciliationPlan=>{
  const result={...base,action,reason,adjustmentMinor};
  if(base.provider==='stripe'&&['authorise_then_capture','verify_before_capture','verify_before_refund'].includes(action)){
   const operation=action==='verify_before_refund'?'refund':'charge';
   try{return {...result,providerAmountPreview:{currency:currency.toLowerCase(),operation,apiAmount:stripeApiAmountFromLedger(operation==='refund'?adjustmentMinor!:c.amountMinor,currency,exponent,operation)}};}
   catch{return review('PROVIDER_AMOUNT_REQUIRES_REVIEW');}
  }
  return result;
 };
 if(job.payment_method==='wallet'||job.payment_status==='wallet_funded')return review('WALLET_RECONCILIATION_REQUIRED');
 let policy:MarketPaymentRoute|undefined;
 const ready=(p:MarketPaymentRoute)=>p.merchantApproved===true&&p.adapterReady===true;
 if(binding){
  if(!['stripe','kora'].includes(binding.provider))return review('PROVIDER_NOT_SUPPORTED');
  if(binding.country!==country||binding.currency!==currency)return review('ORIGINAL_BINDING_MISMATCH');
  if(job.payment_intent_id&&(binding.provider!=='stripe'||binding.paymentReference!==job.payment_intent_id))return review('ORIGINAL_BINDING_MISMATCH');
  const matches=policies.filter(p=>p.provider===binding.provider&&p.merchantAccountRef===binding.merchantAccountRef&&p.country===country&&p.currency===currency);
  if(matches.length!==1)return review('ORIGINAL_ROUTE_NOT_CONFIGURED');
  policy=matches[0];
  try{assertOriginalRoute(binding,policy);}catch{return review('ORIGINAL_BINDING_MISMATCH');}
  base.provider=binding.provider as 'stripe'|'kora';
  // Existing money can need release/refund even after new payments are paused.
  if(!ready(policy))return review('ORIGINAL_ADAPTER_NOT_READY');
 }else{
  if(job.payment_intent_id||!['pending','unpaid'].includes(String(job.payment_status)))return review('ORIGINAL_PAYMENT_BINDING_REQUIRED');
  if(c.amountMinor===0)return decision('no_collection','ZERO_FARE_REQUIRES_CLOSURE_ONLY',0);
  if(!input.marketPaymentEnabled)return review('NEW_PAYMENTS_DISABLED_FOR_MARKET');
  const matches=policies.filter(p=>p.enabled===true&&p.country===country&&p.currency===currency&&p.methods.includes('card'));
  if(matches.length!==1)return review(matches.length?'AMBIGUOUS_PAYMENT_ROUTE':'PAYMENT_ROUTE_NOT_CONFIGURED');
  policy=matches[0];
  if(!['stripe','kora'].includes(policy.provider))return review('PROVIDER_NOT_SUPPORTED');
  base.provider=policy.provider as 'stripe'|'kora';
  if(!ready(policy))return review('PAYMENT_ADAPTER_NOT_READY');
 }
 if(!providerCurrencyOption(base.provider!,currency))return review('PROVIDER_CURRENCY_NOT_CONFIGURED');
 const has=(...caps:PaymentCapability[])=>caps.every(cap=>policy!.capabilities.includes(cap));
 if(!binding){
  if(policy!.provider==='kora')return review('KORA_COLLECTION_ADAPTER_REQUIRED');
  if(!has('authorise','capture','retrieve'))return review('PAYMENT_CAPABILITY_UNAVAILABLE');
  return decision('authorise_then_capture','NEW_APPROVED_ROUTE_REQUIRES_PROVIDER_VERIFICATION',c.amountMinor);
 }
 if(!has('retrieve'))return review('PAYMENT_CAPABILITY_UNAVAILABLE');
 if(job.payment_status==='authorized'){
  if(binding.provider!=='stripe')return review('PROVIDER_AUTHORISATION_NOT_IMPLEMENTED');
  if(c.amountMinor===0)return has('release')?decision('verify_before_release','VERIFY_ORIGINAL_AUTHORISATION',0):review('PAYMENT_CAPABILITY_UNAVAILABLE');
  return has('capture')?decision('verify_before_capture','VERIFY_ORIGINAL_AUTHORISATION',c.amountMinor):review('PAYMENT_CAPABILITY_UNAVAILABLE');
 }
 if(job.payment_status==='paid'){
  const difference=c.originalMinor-c.amountMinor;
  if(!difference)return decision('verify_original_payment','VERIFY_EXISTING_CAPTURE',0);
  return has('refund')?decision('verify_before_refund','VERIFY_ACTUAL_CAPTURE_AND_EXISTING_REFUNDS',difference):review('PAYMENT_CAPABILITY_UNAVAILABLE');
 }
 return decision('verify_original_payment','RECONCILE_EXISTING_REFERENCE_BEFORE_ANY_NEW_COLLECTION');
}
