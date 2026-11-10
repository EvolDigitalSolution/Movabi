/** Read-only API projection; 1E's acquiring transaction remains the money authority. */
export interface CashCreditFailure { status:number; code:string; error:string; }
const failures:Record<string,CashCreditFailure>={
 CE001:{status:409,code:'CASH_CREDIT_DISABLED',error:'Cash ride credit is not enabled.'},
 CE002:{status:403,code:'CASH_CREDIT_NOT_ELIGIBLE',error:'Cash rides are not approved for this driver and market.'},
 CE003:{status:409,code:'CASH_FARE_REFRESH_REQUIRED',error:'Refresh the cash ride fare before accepting.'},
 CE004:{status:409,code:'CASH_CREDIT_INSUFFICIENT',error:'Your cash credit is insufficient for this ride.'},
 CE005:{status:409,code:'CASH_CREDIT_CONFLICT',error:'The cash ride changed or its credit hold was already resolved.'},
 CE006:{status:409,code:'CASH_CREDIT_RECONCILIATION_REQUIRED',error:'Cash credit requires review before taking another cash ride.'}
};
export function mapCashCreditError(error:unknown):CashCreditFailure|null {
 const code=String((error as any)?.code||'');
 return Object.prototype.hasOwnProperty.call(failures,code)?{...failures[code]}:null;
}
function fail(code:string):never { throw Object.assign(new Error(mapCashCreditError({code})?.error||'Cash credit unavailable'),{code}); }
const uuid=(value:unknown)=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export function isCashRide(job:any):boolean {
 const service=Array.isArray(job?.service_type)?job.service_type[0]:job?.service_type;
 return job?.payment_method==='cash'&&(service?.slug||job?.service_slug)==='ride';
}
export function validateCashCreditStatus(value:any,driverId:string):any {
 if(!uuid(driverId)||!value||value.driverId!==driverId||!uuid(value.tenantId)
 ||typeof value.country!=='string'||typeof value.currency!=='string'
 ||!(/^[A-Z]{2}$/).test(value.country)||!(/^[A-Z]{3}$/).test(value.currency)
 ||typeof value.pilotEnabled!=='boolean'||typeof value.enrolled!=='boolean'
 ||value.topupAvailable!==false||value.payoutAvailable!==false||value.acceptanceAuthority!=='database')fail('CE006');
 const b=value.balance;
 if(!b||b.currency!==value.currency||typeof b.consistent!=='boolean')fail('CE006');
 for(const key of ['availableMinor','heldMinor','deficitMinor','eligibleDepositsMinor']) {
  if(typeof b[key]!=='string'||!(/^(0|[1-9][0-9]{0,39})$/).test(b[key]))fail('CE006');
 }
 // Return a whitelist; never expose provider evidence, references or arbitrary RPC fields.
 return {country:value.country,currency:value.currency,tenantId:value.tenantId,driverId,
  pilotEnabled:value.pilotEnabled,enrolled:value.enrolled,
  balance:{currency:b.currency,consistent:b.consistent,availableMinor:b.availableMinor,heldMinor:b.heldMinor,
   deficitMinor:b.deficitMinor,eligibleDepositsMinor:b.eligibleDepositsMinor},
  topupAvailable:false,payoutAvailable:false,acceptanceAuthority:'database'};
}
export async function readDriverCashCredit(db:any,driverId:string):Promise<any> {
 if(!uuid(driverId))fail('CE002');
 const {data,error}=await db.rpc('driver_cash_credit_status_v1f',{p_driver_id:driverId});
 if(error) { if(mapCashCreditError(error))throw Object.assign(new Error('Cash credit unavailable'),{code:error.code});
  throw Object.assign(new Error('Cash credit status temporarily unavailable'),{code:'CASH_CREDIT_UNAVAILABLE'}); }
 return validateCashCreditStatus(data,driverId);
}
/** false = leave existing payout checks in place, including while pilot is off. */
export async function cashRideAcquisitionApproved(db:any,driverId:string,job:any):Promise<boolean> {
 if(!isCashRide(job))return false;
 const status=await readDriverCashCredit(db,driverId);
 if(!status.pilotEnabled)return false;
 if(!status.enrolled||status.tenantId!==job.tenant_id||status.country!==job.country_code||status.currency!==job.currency_code
 ||(job.metadata?.country_code&&job.metadata.country_code!==status.country)
 ||job.metadata?.cash_collection_mode!=='full_customer_charge'||job.payment_intent_id!=null
 ||!['pending','cash_due','cash_pending'].includes(job.payment_status))fail('CE002');
 if(!status.balance.consistent||status.balance.deficitMinor!=='0')fail('CE006');
 // No balance reservation here: 1E reserves against the frozen post-subscription fare inside assignment.
 return true;
}
