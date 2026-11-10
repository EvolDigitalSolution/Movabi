import {PaymentLayerError,type PaymentBinding} from './payment-contracts';
import {paymentPolicies,type MarketPaymentRoute} from './market-payment-registry';
import {providerCurrencyOption} from './provider-currency-options';
export interface DatabasePaymentScope {country:string;currency:string;method:string;binding?:PaymentBinding|null;}
const fields='country_code,currency_code,method,provider,merchant_account_ref,preferred,enabled,merchant_approved,adapter_ready,payout_approved,capabilities';
async function rows(db:any,scope:DatabasePaymentScope){
 if(!/^[A-Z]{2}$/.test(scope.country)||!/^[A-Z]{3}$/.test(scope.currency)||!['card','bank_transfer','mobile_money'].includes(scope.method))throw new PaymentLayerError('INVALID_PAYMENT_MARKET','An explicit market and method are required');
 const binding=scope.binding;
 if(binding&&(binding.country!==scope.country||binding.currency!==scope.currency))throw new PaymentLayerError('PAYMENT_ROUTE_MISMATCH','Original payment market does not match');
 let query=db.from('market_payment_routes').select(fields).eq('country_code',scope.country).eq('currency_code',scope.currency).eq('method',scope.method);
 query=binding?query.eq('provider',binding.provider).eq('merchant_account_ref',binding.merchantAccountRef):query.eq('preferred',true);
 const {data,error}=await query;
 if(error||!Array.isArray(data))throw new PaymentLayerError('PAYMENT_ROUTE_DATABASE_UNAVAILABLE','Database payment routes are unavailable');
 if(data.some((r:any)=>r.country_code!==scope.country||r.currency_code!==scope.currency||r.method!==scope.method
  ||(binding?(r.provider!==binding.provider||r.merchant_account_ref!==binding.merchantAccountRef):r.preferred!==true)))throw new PaymentLayerError('PAYMENT_ROUTE_MISMATCH','Database returned another payment route');
 if(data.length>1)throw new PaymentLayerError('AMBIGUOUS_PAYMENT_ROUTE','The database payment route is ambiguous');
 return data;
}
/** No environment fallback, provider guessing or caching. Existing references use historical identities. */
export async function loadDatabasePaymentPolicies(db:any,scope:DatabasePaymentScope):Promise<readonly MarketPaymentRoute[]>{
 const data=await rows(db,scope);
 const mapped=data.flatMap((r:any)=>{
  if(!providerCurrencyOption(r.provider,r.currency_code))throw new PaymentLayerError('PAYMENT_CURRENCY_UNAVAILABLE','Currency is not configured for this provider');
  if(!r.merchant_account_ref){
   if(r.enabled||r.merchant_approved||r.adapter_ready||r.payout_approved||!Array.isArray(r.capabilities)||r.capabilities.length)throw new PaymentLayerError('PAYMENT_ACCOUNT_UNCONFIGURED','Merchant account is required');
   return [];
  }
  return [{country:r.country_code,currency:r.currency_code,provider:r.provider,merchantAccountRef:r.merchant_account_ref,
   methods:[r.method],enabled:r.enabled,merchantApproved:r.merchant_approved,adapterReady:r.adapter_ready,payoutApproved:r.payout_approved,capabilities:r.capabilities}];
 });
 return paymentPolicies(JSON.stringify(mapped));
}
export async function readDatabasePaymentAssignment(db:any,scope:DatabasePaymentScope){
 const data=await rows(db,{...scope,binding:null});const row=data[0];
 if(!row)return {country:scope.country,currency:scope.currency,method:scope.method,provider:null,assigned:false,routeEnabled:false,merchantApproved:false,adapterReady:false};
 if(!providerCurrencyOption(row.provider,row.currency_code))throw new PaymentLayerError('PAYMENT_CURRENCY_UNAVAILABLE','Currency is not configured for this provider');
 return {country:scope.country,currency:scope.currency,method:scope.method,provider:row.provider,assigned:true,
  routeEnabled:row.enabled,merchantApproved:row.merchant_approved,adapterReady:row.adapter_ready};
}
