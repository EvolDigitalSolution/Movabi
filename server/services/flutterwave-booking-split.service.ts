import {DriverCollectionAccountService} from './driver-collection-account.service';
import {FlutterwaveBookingSplit,frozenBookingSplit} from './payments/flutterwave-booking-split';
import {sandboxSubaccountProvider} from './payments/flutterwave-collection-subaccount';

export class FlutterwaveBookingSplitService {
 constructor(private db:any,private accounts:DriverCollectionAccountService,private adapter:(merchant:string)=>FlutterwaveBookingSplit=bookingSplitProvider){}
 private async principalJob(customerId:string,jobId:string){
  const result=await this.db.from('jobs').select('*').eq('id',jobId).eq('customer_id',customerId).single();
  if(result.error||!result.data||result.data.customer_id!==customerId)throw new Error('Booking unavailable.');return result.data;
 }
 async quote(customerId:string,jobId:string){
  const job=await this.principalJob(customerId,jobId);const scope=await this.accounts.ready(job.driver_id);const plan=frozenBookingSplit(job,scope);
  this.adapter(plan.merchantAccountRef);
  return {plan,public:{totalMinor:plan.totalMinor,driverMinor:plan.driverMinor,vayduGrossMinor:plan.vayduGrossMinor,currency:'NGN',version:plan.version}};
 }
 async checkout(customerId:string,jobId:string,email:string,confirmedTotal:number){
  const q=await this.quote(customerId,jobId);if(confirmedTotal!==q.plan.totalMinor)throw new Error('Confirm the current frozen total.');
  const reserve=await this.db.rpc('reserve_flutterwave_booking_split',{p_job:jobId,p_customer:customerId,p_terms:q.plan});
  if(reserve.error||!reserve.data?.[0])throw new Error('Settlement method/terms could not be reserved.');
  const row=reserve.data[0];if(row.state==='checkout'&&row.checkout_url)return {checkoutUrl:row.checkout_url,...q.public};
  if(row.state!=='reserved')throw new Error('Collection is already submitted; verify the existing reference.');
  const provider=this.adapter(q.plan.merchantAccountRef);await provider.preflight(q.plan);
  const claim=await this.db.rpc('claim_flutterwave_split_submission',{p_job:jobId,p_customer:customerId});
  if(claim.error||claim.data!==true)throw new Error('Collection already claimed; reconcile it.');
  // Once claimed, a timeout never permits another POST or another settlement method.
  const checkoutUrl=await provider.checkout(q.plan,row.reference,email,'https://movabi-develop.apps.evolsolution.com/booking-payment-return');
  const saved=await this.db.rpc('save_flutterwave_split_checkout',{p_job:jobId,p_customer:customerId,p_url:checkoutUrl});
  if(saved.error||saved.data!==true)throw new Error('Checkout requires reconciliation.');return {checkoutUrl,...q.public};
 }
 private async reserved(customerId:string,jobId:string){
  await this.principalJob(customerId,jobId);
  const result=await this.db.from('job_settlement_methods').select('*').eq('job_id',jobId).eq('method','split').single();
  if(result.error||!result.data||result.data.terms.customerId!==customerId)throw new Error('Split collection unavailable.');
  return result.data;
 }
 async verify(customerId:string,jobId:string){
  const row=await this.reserved(customerId,jobId);if(!['submitting','checkout','collected','settled'].includes(row.state))throw new Error('Collection needs review.');
  const result=await this.adapter(row.terms.merchantAccountRef).verify(row.terms,row.reference);
  const saved=await this.db.rpc('confirm_flutterwave_split_collection',{p_job:jobId,p_customer:customerId,p_transaction:result.id,p_observation:{appFee:result.appFee,merchantFee:result.merchantFee}});
  if(saved.error||saved.data!==true)throw new Error('Verified collection needs local reconciliation.');
  return {paymentVerified:true,driverSettlement:row.state==='settled'?'settled':'pending'};
 }
 async settlement(customerId:string,jobId:string){
  const row=await this.reserved(customerId,jobId);if(!['collected','settled'].includes(row.state))throw new Error('Collection must be verified first.');
  const evidence=await this.adapter(row.terms.merchantAccountRef).settlement(row.terms,row.reference,row.provider_transaction_id);
  const result=await this.db.rpc('finish_flutterwave_split_settlement',{p_job:jobId,p_transaction:row.provider_transaction_id,p_evidence:evidence});
  if(result.error||result.data!==true)throw new Error('Driver settlement needs local reconciliation.');return {driverSettlement:'settled'};
 }
}
export function bookingSplitProvider(merchant:string){
 if(process.env.VAYDU_FLUTTERWAVE_BOOKING_SPLIT_SANDBOX!=='true'||process.env.VAYDU_BOOKING_SPLIT_TIMING_APPROVED!=='true')throw new Error('Booking split collection/timing is disabled.');
 return new FlutterwaveBookingSplit(sandboxSubaccountProvider(merchant),process.env.FLUTTERWAVE_PROVIDER_ACCOUNT_ID||'');
}
