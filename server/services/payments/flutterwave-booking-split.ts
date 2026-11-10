import {FareSplitService} from '../fare-split.service';
import {PaymentAuthorityService} from '../payment-authority.service';
import {flutterwaveMajor} from './flutterwave-wallet-collection';
import {FlutterwaveCollectionSubaccount} from './flutterwave-collection-subaccount';

export function exactNgnMinor(value:unknown):number {
 const m=/^(\d+)(?:\.(\d{1,2}))?$/.exec(String(value));if(!m)throw new Error('Frozen money needs reconciliation.');
 const n=BigInt(m[1])*100n+BigInt((m[2]||'').padEnd(2,'0'));if(n>BigInt(Number.MAX_SAFE_INTEGER))throw new Error('Money exceeds exact supported range.');return Number(n);
}
/** No fee percentages originate here. Every share comes from the established frozen fare. */
export function frozenBookingSplit(job:any,scope:any){
 const m=scope.market,a=scope.account;
 if(job.metadata?.driver_settlement_method!=='split'||job.status!=='completed'||!job.driver_id||job.driver_id!==scope.driverId||job.tenant_id!==scope.tenant||job.country_code!=='NG'||job.currency_code!=='NGN'
  ||job.payment_method!=='card'||!['pending','unpaid','requires_payment'].includes(job.payment_status)||job.payment_intent_id||job.stripe_transfer_id||job.payout_transfer_id
  ||job.no_show_status||Number(job.total_refunded_minor||0)!==0||PaymentAuthorityService.isErrand(job)
  ||['claimed','unknown','transferred','reversed'].includes(job.settlement_status))throw new Error('Booking is not eligible for completed-job split collection.');
 if(m.split_collection_approved!==true||m.split_semantics_verified!==true||m.fee_passing_verified!==true||m.settlement_verified!==true
  ||m.environment!=='test'||!/^RS_[A-Za-z0-9]+$/.test(a.subaccount_id))throw new Error('Merchant split capability is unverified.');
 const b=job.fare_breakdown;
 if(b?.policyVersion!==FareSplitService.POLICY_VERSION||b.currency!=='NGN'
  ||['customerCharge','platformFeeAmount','driverCommissionAmount','driverEntitlement','driverBase','grossRevenue'].some(k=>b[k]===undefined||b[k]===null))throw new Error('Frozen fare snapshot required.');
 const fare=FareSplitService.fromSnapshot(b,'NGN');
 PaymentAuthorityService.assertFrozenServiceFare(job,PaymentAuthorityService.authoritativeServiceFare(job));
 const total=exactNgnMinor(fare.customerCharge),driver=exactNgnMinor(fare.driverEntitlement),platform=exactNgnMinor(fare.platformFeeAmount),commission=exactNgnMinor(fare.driverCommissionAmount);
 const gross=platform+commission;
 if(!total||!driver||total!==driver+gross||exactNgnMinor(fare.grossRevenue)!==gross||exactNgnMinor(fare.driverBase)!==driver+commission)throw new Error('Frozen fare does not conserve earnings.');
 const budget=Number(m.provider_fee_budget_minor),limit=Number(m.max_charge_minor);
 if(m.provider_fee_budget_minor===null||m.max_charge_minor===null||!Number.isSafeInteger(budget)||budget<0||gross<budget||!Number.isSafeInteger(limit)||total>limit)throw new Error('Provider deductions exceed the reviewed split margin.');
 return {version:'vaydu-frozen-booking-split-v1',provider:'flutterwave',environment:'test',jobId:job.id,customerId:job.customer_id,driverId:job.driver_id,tenantId:job.tenant_id,
  country:'NG',currency:'NGN',merchantAccountRef:m.merchant_account_ref,subaccountId:a.subaccount_id,subaccountRecordId:a.id,
  totalMinor:total,driverMinor:driver,vayduGrossMinor:gross,platformFeeMinor:platform,commissionMinor:commission,
  providerFeeBudgetMinor:budget,fareSnapshot:b,
  subaccounts:[{id:a.subaccount_id,transaction_charge_type:'flat_subaccount',transaction_charge:flutterwaveMajor(driver,2)}]};
}
export class FlutterwaveBookingSplit {
 constructor(private provider:FlutterwaveCollectionSubaccount,private expectedProviderAccountId:string){
  if(!/^\d+$/.test(expectedProviderAccountId))throw new Error('Verified test merchant identity required.');
 }
 async preflight(plan:ReturnType<typeof frozenBookingSplit>){
  const {data}=await this.provider.call('/transactions/fee?amount='+flutterwaveMajor(plan.totalMinor,2)+'&currency=NGN&payment_type=card');
  if(exactNgnMinor(data.charge_amount)!==plan.totalMinor||data.currency&&data.currency!=='NGN')throw new Error('Customer would be charged an unconfirmed amount.');
  // Fee estimate is supplemental; approved margin also covers reviewed VAT/duty/settlement deductions.
  if(exactNgnMinor(data.fee)>plan.providerFeeBudgetMinor)throw new Error('Provider fee exceeds the approved reserve.');
 }
 async checkout(plan:ReturnType<typeof frozenBookingSplit>,reference:string,email:string,redirectUrl:string){
  const url=new URL(redirectUrl);
  if(url.origin!=='https://movabi-develop.apps.evolsolution.com'||url.pathname!=='/booking-payment-return'||url.search||url.hash
   ||!/^vaydu-split-[a-f0-9-]+$/.test(reference)||!/^\S+@\S+\.\S+$/.test(email))throw new Error('Approved booking return details required.');
  const {data}=await this.provider.call('/payments',{tx_ref:reference,amount:flutterwaveMajor(plan.totalMinor,2),currency:'NGN',payment_options:'card',
   customer:{email},redirect_url:url.href,subaccounts:plan.subaccounts});
  const link=new URL(data.link);
  if(link.protocol!=='https:'||!['checkout.flutterwave.com','ravemodal-dev.flutterwave.com'].includes(link.hostname)||link.port||link.username||link.password)throw new Error('Checkout response needs reconciliation.');
  return link.href;
 }
 async verify(plan:ReturnType<typeof frozenBookingSplit>,reference:string){
  const {data}=await this.provider.call('/transactions/verify_by_reference?tx_ref='+encodeURIComponent(reference));
  if(data.status!=='successful'||data.tx_ref!==reference||data.currency!=='NGN'||String(data.account_id)!==this.expectedProviderAccountId
   ||data.payment_type!=='card'||exactNgnMinor(data.amount)!==plan.totalMinor||exactNgnMinor(data.charged_amount)!==plan.totalMinor||!/^\d+$/.test(String(data.id)))throw new Error('Collection is not confirmed.');
  return {id:String(data.id),appFee:data.app_fee===undefined?null:String(data.app_fee),merchantFee:data.merchant_fee===undefined?null:String(data.merchant_fee)};
 }
 /** Collection success is NOT settlement proof. Require a completed subaccount-filtered batch and exact transaction allocation. */
 async settlement(plan:ReturnType<typeof frozenBookingSplit>,reference:string,transactionId:string){
  const batches=await this.provider.call('/settlements?subaccount_id='+encodeURIComponent(plan.subaccountId)+'&page=1');
  if(!Array.isArray(batches.data)||Number(batches.meta?.page_info?.total_pages)!==1)throw new Error('Settlement pagination requires review.');
  let matched:any=null;
  for(const batch of batches.data){
   if(!/^\d+$/.test(String(batch.id)))throw new Error('Settlement identity unavailable.');
   const {data}=await this.provider.call('/settlements/'+batch.id);
   if(data.status!=='completed'||data.currency!=='NGN'||!Array.isArray(data.transactions))continue;
   // An unqualified platform batch or zero subaccount allocation cannot prove driver payment.
   const lines=data.transactions.filter((t:any)=>t.tx_ref===reference&&String(t.id)===transactionId&&t.status==='successful'&&t.currency==='NGN');
   for(const line of lines){
    if(exactNgnMinor(line.subaccount_settlement)!==plan.driverMinor||Number(line.chargeback||0)!==0||Number(line.refund||0)!==0)throw new Error('Driver settlement allocation needs review.');
    if(matched)throw new Error('Ambiguous driver settlement evidence.');
    matched={batchId:String(data.id),transactionId,reference,subaccountId:plan.subaccountId,driverMinor:plan.driverMinor,
     appFee:line.app_fee===undefined?null:String(line.app_fee),stampDuty:line.stampduty_charge===undefined?null:String(line.stampduty_charge)};
   }
  }
  if(!matched)throw new Error('Driver settlement remains pending.');return matched;
 }
}
