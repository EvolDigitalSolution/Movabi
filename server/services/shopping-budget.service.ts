import { PaymentMarginService, PaymentMarginPolicy } from './payment-margin.service';
import { stripe } from './stripe.service';
import { supabaseAdmin } from './supabase.service';
import { PaymentAuthorityService } from './payment-authority.service';
import { FareSplitService } from './fare-split.service';

export class ShoppingBudgetService {
  static async assertSustainableBudget(job:Record<string,unknown>,budget:number) {
    if(job['payment_method']!=='card') return;
    const payable=await PaymentAuthorityService.resolve(job);
    const breakdown=job['fare_breakdown'] as {paymentMargin?:{policy?:PaymentMarginPolicy}} | undefined;
    const policy=breakdown?.paymentMargin?.policy || PaymentMarginService.policy(String(job['currency_code']));
    const payout=Number(job['driver_payout']);
    if(job['driver_payout']==null || !Number.isFinite(payout) || payout<0) throw new Error('Driver payment terms require review');
    const result=PaymentMarginService.evaluate(payable.serviceFareMajor,payout,budget,policy);
    if(!result.passes) throw new Error('This larger shopping budget needs a revised service quote to cover processing costs. Contact Movabi before purchasing.');
  }
  static async assertCustomerFunds(jobId:string,budget:number):Promise<void> {
    const {data:job,error}=await supabaseAdmin.from('jobs').select('*,service_type:service_types(*)').eq('id',jobId).single();
    if(error || !job) throw new Error('Customer funding could not be verified');
    const payable=await PaymentAuthorityService.resolve(job);
    const required=FareSplitService.toMinor(payable.serviceFareMajor+budget,String(job.currency_code));
    if(job.payment_method==='card') {
      if(!job.payment_intent_id) throw new Error('Customer payment authorization is missing');
      const intent=await stripe.paymentIntents.retrieve(job.payment_intent_id);
      if(intent.currency!==String(job.currency_code).toLowerCase() || intent.status!=='requires_capture'
        || intent.amount_capturable<required) throw new Error('Customer payment does not cover this shopping budget');
    } else if(job.payment_method==='wallet' && job.payment_status==='wallet_funded') {
      const {data:transactions,error:ledgerError}=await supabaseAdmin.from('wallet_transactions')
        .select('transaction_type,amount').eq('job_id',jobId).eq('user_id',job.customer_id);
      if(ledgerError) throw new Error('Customer wallet reservation could not be verified');
      const reserved=(transactions || []).reduce((sum,row)=>sum+(row.transaction_type==='reservation'?Number(row.amount):['release','settlement'].includes(row.transaction_type)?-Number(row.amount):0),0);
      if(FareSplitService.toMinor(reserved,String(job.currency_code))<required) throw new Error('Customer wallet reservation does not cover this shopping budget');
    } else throw new Error('Customer payment is not ready for shopping');
  }
  static async reserve(jobId: string, budget: number, currency: string): Promise<number> {
    if (process.env.STRIPE_ISSUING_ENABLED !== 'true') throw new Error('Shopping card funding is unavailable');
    const balance = await stripe.balance.retrieve();
    const available = FareSplitService.fromMinor(balance.issuing?.available.find(x => x.currency === currency.toLowerCase())?.amount || 0, currency);
    const { error } = await supabaseAdmin.rpc('reserve_job_issuing_budget', {
      p_job: jobId, p_budget: budget, p_available: available, p_currency: currency
    });
    if (error) throw new Error(error.message);
    return available;
  }
  static async context(jobId: string, customerId: string) {
    const { data: job, error } = await supabaseAdmin.from('jobs').select('*,service_type:service_types(*)').eq('id',jobId).single();
    if (error || !job || job.customer_id !== customerId) throw new Error('Customer booking not found');
    if (!PaymentAuthorityService.isErrand(job)) throw new Error('Shopping budget is not applicable');
    const { data: funding, error: fundingError } = await supabaseAdmin.from('errand_funding').select('*').eq('job_id',jobId).single();
    if (fundingError || !funding) throw new Error('Shopping budget not found');
    return { job, funding };
  }
  static async prepare(jobId: string, customerId: string) {
    const { job, funding } = await this.context(jobId,customerId);
    if (funding.over_budget_status === 'approved') return {approved:true,clientSecret:null,requestId:null};
    if (funding.over_budget_status !== 'requested') throw new Error('No pending budget increase');
    const budget = Number(funding.requested_over_budget_amount);
    if (!Number.isFinite(budget) || budget <= Number(funding.item_budget)) throw new Error('Invalid shopping budget');
    await this.assertSustainableBudget(job,budget);
    await this.reserve(jobId,budget,String(job.currency_code));
    if (job.payment_method === 'wallet' && job.payment_status === 'wallet_funded') {
      const { error } = await supabaseAdmin.rpc('approve_errand_over_budget',{p_job_id:jobId});
      if (error) throw new Error(error.message);
      return { approved: true, clientSecret: null, requestId: null };
    }
    if (job.payment_method !== 'card' || job.payment_status !== 'authorized' || !job.payment_intent_id) throw new Error('Customer card payment is not authorized');
    const requestId = String(funding.metadata?.budget_request_id || '');
    if (!/^[0-9a-f-]{36}$/i.test(requestId)) throw new Error('Please submit a new budget request');
    const original = await stripe.paymentIntents.retrieve(job.payment_intent_id);
    if (original.status !== 'requires_capture') throw new Error('Customer authorization must be renewed before shopping');
    const { error: insertError } = await supabaseAdmin.from('job_budget_authorizations').upsert({
      id:requestId, job_id:jobId, old_intent_id:original.id,total_budget:budget
    },{onConflict:'id',ignoreDuplicates:true});
    if (insertError) throw new Error(insertError.message);
    const { data: record, error: readError } = await supabaseAdmin.from('job_budget_authorizations').select('*').eq('id',requestId).single();
    if (readError || !record || record.status !== 'created' || record.old_intent_id !== original.id || record.total_budget !== budget) throw new Error('Budget request requires reconciliation');
    let intent;
    if (record.new_intent_id) intent = await stripe.paymentIntents.retrieve(record.new_intent_id);
    else {
      const payable = await PaymentAuthorityService.resolve(job);
      intent = await stripe.paymentIntents.create({
        amount:FareSplitService.toMinor(payable.serviceFareMajor+budget,job.currency_code),
        currency:String(job.currency_code).toLowerCase(),capture_method:'manual',payment_method_types:['card'],
        metadata:{jobId,requestId,purpose:'shopping_budget_reauthorization'}
      },{idempotencyKey:`shopping-budget-${requestId}`});
      const { error: bindError } = await supabaseAdmin.from('job_budget_authorizations').update({new_intent_id:intent.id}).eq('id',requestId).eq('status','created');
      if (bindError) throw new Error(bindError.message);
    }
    if (!['requires_payment_method','requires_confirmation','requires_action','requires_capture'].includes(intent.status)) throw new Error('Budget payment must be reviewed');
    return { approved:false,clientSecret:intent.client_secret,requestId };
  }
  static async approve(jobId: string, customerId: string, requestId: string) {
    const { job, funding } = await this.context(jobId,customerId);
    const { data: record, error } = await supabaseAdmin.from('job_budget_authorizations').select('*').eq('id',requestId).eq('job_id',jobId).single();
    if (error || !record?.new_intent_id) throw new Error('Budget authorization not found');
    if (record.status === 'approved') return;
    await this.assertSustainableBudget(job,Number(record.total_budget));
    const intent = await stripe.paymentIntents.retrieve(record.new_intent_id);
    const payable = await PaymentAuthorityService.resolve(job);
    if (intent.id !== record.new_intent_id || intent.status !== 'requires_capture' || intent.capture_method !== 'manual' || intent.metadata.requestId !== requestId
      || intent.metadata.jobId !== jobId || intent.currency !== String(job.currency_code).toLowerCase()
      || intent.amount_capturable !== FareSplitService.toMinor(payable.serviceFareMajor+Number(record.total_budget),job.currency_code)
      || funding.over_budget_status !== 'requested') throw new Error('Additional customer authorization is not ready');
    // Recheck available funds at commit; do not trust the earlier availability check.
    const available = await this.reserve(jobId,Number(record.total_budget),String(job.currency_code));
    const { error: commitError } = await supabaseAdmin.rpc('approve_card_errand_budget',{
      p_job:jobId,p_request:requestId,p_old_intent:record.old_intent_id,p_new_intent:intent.id,
      p_budget:record.total_budget,p_available:available,p_currency:job.currency_code
    });
    if (commitError) throw new Error(commitError.message);
    await this.cleanup().catch(error => console.error('[ShoppingBudget] release retry scheduled',error.message));
  }
  static async cleanup() {
    const { data, error } = await supabaseAdmin.rpc('shopping_authorizations_pending_cleanup');
    if (error) throw new Error(error.message);
    for (const record of data || []) {
      const { data: job } = await supabaseAdmin.from('jobs').select('status,payment_intent_id').eq('id',record.job_id).single();
      const { data: funding } = await supabaseAdmin.from('errand_funding').select('metadata,over_budget_status').eq('job_id',record.job_id).single();
      if (!job || !funding) continue;
      const abandoned = record.status !== 'approved' && (['cancelled','canceled','expired','failed','completed','settled'].includes(job.status)
        || funding.over_budget_status === 'rejected' || funding.metadata?.budget_request_id !== record.id);
      const target = record.status === 'approved' ? record.old_intent_id : abandoned ? record.new_intent_id : null;
      if (!target || target === job.payment_intent_id) continue;
      try {
        const intent = await stripe.paymentIntents.retrieve(target);
        if (intent.status === 'succeeded') throw new Error('Obsolete budget authorization was captured; review required');
        if (intent.status !== 'canceled') await stripe.paymentIntents.cancel(target,{}, {idempotencyKey:`shopping-release-${record.id}`});
        const { error: markError } = await supabaseAdmin.from('job_budget_authorizations').update({cleanup_done:true,...(abandoned?{status:'abandoned'}:{})}).eq('id',record.id);
        if (markError) throw new Error(markError.message);
      } catch (error) { console.error('[ShoppingBudget] authorization release pending',record.id,error instanceof Error ? error.message : 'unknown'); }
    }
  }
}
