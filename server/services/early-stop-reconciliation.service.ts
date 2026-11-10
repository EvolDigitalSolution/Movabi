import {planEarlyStopReconciliation} from './early-stop-reconciliation';
import {loadDatabasePaymentPolicies} from './payments/market-payment-store';
import {MarketAvailabilityService} from './market-availability.service';
export async function previewEarlyStopReconciliation(db:any,actor:string,jobId:string,stopId:string,proposalId:string){
 const args={p_actor:actor,p_job_id:jobId,p_stop_id:stopId};
 const {data:context,error:contextError}=await db.rpc('early_stop_fare_context_v23',args);
 if(contextError||!context?.authorityJob)throw Error('RECONCILIATION_CONTEXT_UNAVAILABLE');
 const {data:proposal,error:proposalError}=await db.from('journey_fare_proposals_v23')
  .select('id,stop_id,state,source_digest,calculation,customer_accepted_at,driver_accepted_at').eq('id',proposalId).eq('stop_id',stopId).maybeSingle();
 if(proposalError||!proposal||proposal.state!=='agreed'||!proposal.customer_accepted_at||!proposal.driver_accepted_at||proposal.source_digest!==context.digest)throw Error('RECONCILIATION_FARE_AGREEMENT_REQUIRED');
 const {data:row,error:bindingError}=await db.from('job_payment_bindings')
  .select('provider,merchant_account_ref,country,currency,payment_reference').eq('job_id',jobId).maybeSingle();
 if(bindingError)throw Error('RECONCILIATION_BINDING_UNAVAILABLE');
 const job=context.authorityJob;
 const binding=row?{provider:row.provider,merchantAccountRef:row.merchant_account_ref,country:row.country,currency:row.currency,paymentReference:row.payment_reference}:null;
 // A paused market must not prevent previewing release/refund of existing money.
 let marketPaymentEnabled=false;
 if(!binding){
  const market=await MarketAvailabilityService.resolveMarket({countryCode:job.country_code,marketCity:job.market_city||job.metadata?.market_city||job.metadata?.marketCity});
  marketPaymentEnabled=market.capabilities.payment;
 }
 const plan=planEarlyStopReconciliation({job,calculation:proposal.calculation,binding,policies:await loadDatabasePaymentPolicies(db,{country:job.country_code,currency:job.currency_code,method:'card',binding}),marketPaymentEnabled});
 // Preview is not an execution authorisation; no provider or ledger mutation here.
 return {...plan,proposalId,previewOnly:true};
}
export function reconciliationError(){return {status:409,code:'RECONCILIATION_REVIEW_REQUIRED',error:'The original payment route, fare consent or provider capability needs review. No payment or booking was changed.'};}
