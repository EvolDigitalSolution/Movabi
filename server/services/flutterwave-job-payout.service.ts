import {DriverPaymentAccountService,beneficiaryOf} from './driver-payment-account.service';
import {FlutterwaveDriverPayout,type FrozenTransfer} from './payments/flutterwave-driver-payout';
/** Uses the existing leased job outbox and settlement RPC. An irreversible submit
 * marker is committed BEFORE the network request; an uncertain result is lookup-only. */
export class FlutterwaveJobPayoutService {
 constructor(private db:any,private accounts:DriverPaymentAccountService,private adapter:(merchant?:string)=>FlutterwaveDriverPayout){}
 async process(q:any,update:(state:string,code:string)=>Promise<void>){
  let provider:FlutterwaveDriverPayout;let scope:any;
  try{scope=await this.accounts.ready(q.driver_id);provider=this.adapter(scope.market.merchant_account_ref);}catch{await update('reconcile','sandbox_payout_unavailable');return;}
  const terms=q.terms;
  if(terms.payout_provider!=='flutterwave'||terms.payout_account_id!==scope.account.id||terms.payout_merchant!==scope.market.merchant_account_ref
   ||terms.payout_tenant!==scope.tenant||terms.country!==scope.country||String(q.currency).toUpperCase()!==scope.currency
   ||q.destination!==`flw:${scope.account.id}`){await update('blocked','payout_scope_mismatch');return;}
  const t:FrozenTransfer={reference:`vaydu-${q.job_id}_PMCK`,amountMinor:Number(q.amount_minor),currency:scope.currency,beneficiary:beneficiaryOf(scope.account)};
  let found;
  try{found=await provider.lookup(t);}catch{await update('reconcile','transfer_lookup_unavailable');return;}
  if(found){
   if(found.state==='completed'){
    const result=await this.db.rpc('finish_flutterwave_job_payout',{p_job:q.job_id,p_token:q.token,p_reference:t.reference,p_transfer:found.id,p_fee:found.fee||null});
    if(result.error||result.data!==true)throw new Error('Payout completion requires reconciliation.');
   }else await update(found.state==='failed'?'blocked':'reconcile',found.state==='failed'?'provider_transfer_failed':'provider_transfer_pending');
   return;
  }
  const submitted=await this.db.rpc('claim_flutterwave_job_submission',{p_job:q.job_id,p_token:q.token,p_reference:t.reference});
  if(submitted.error)throw new Error('Payout submission marker unavailable.');
  if(submitted.data!==true){await update('reconcile','transfer_outcome_unknown');return;}
  try{await provider.submit(t);}catch{await update('reconcile','transfer_outcome_unknown');return;}
  await update('reconcile','transfer_accepted_verification_required');
 }
}
