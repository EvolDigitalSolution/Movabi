/** Completion no longer submits transfers synchronously. Transfer retries are exercised
 * in completion-payout-retries.spec.ts; transactional money invariants in the PostgreSQL runner. */
import {describe,it,expect} from 'vitest';
import fs from 'node:fs';import vm from 'node:vm';import ts from 'typescript';
function setup(options:any={}) {
 const job={id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',driver_id:'driver',customer_id:'customer',status:'en_route_to_customer',payment_method:'wallet',payment_status:'wallet_funded',currency_code:'GBP',country_code:'GB',metadata:{completion_pin_required:true},...options.job};
 const calls:any[]=[],captures:any[]=[],reads:string[]=[];
 const tables:any={jobs:job,job_payout_queue:options.queued?{job_id:job.id}:null,job_completion_secrets:{completion_pin:'1234'},profiles:{stripe_account_id:'acct_driver'},driver_earnings:options.paidEarnings?{job_id:job.id}:null};
 const db={from:(table:string)=>{reads.push(table);const chain:any={select:()=>chain,eq:()=>chain,ilike:()=>chain,update:()=>chain,maybeSingle:async()=>({data:tables[table],error:table==='job_completion_secrets'?options.secretError:null}),then:(resolve:any)=>Promise.resolve({}).then(resolve)};return chain;},rpc:async(fn:string,args:any)=>{calls.push({fn,args});if(options.rpcFailure)return {error:{message:'Atomic completion failed'}};tables.job_payout_queue={job_id:job.id};job.status='completed';return {data:[{...job,metadata:{driver_payout_pending:true}}]};}};
 const stripe={paymentIntents:{retrieve:async()=>({status:'requires_capture',currency:'gbp',amount_received:1000,...options.intent}),capture:async(...args:any[])=>{captures.push(args);return {status:'succeeded'};}}};
 const fare={customerCharge:10,platformFeeAmount:1,driverEntitlement:8,driverCommissionAmount:1,commissionPercent:10,currency:'GBP'};
 class HistoricalFareReconciliationRequired extends Error {}
 const context:any={exports:{},console,Date,require:(name:string)=>{
  if(name.includes('stripe.service'))return {stripe};if(name.includes('supabase.service'))return {supabaseAdmin:db};
  if(name.includes('fare-split.service'))return {HistoricalFareReconciliationRequired,FareSplitService:{fromSnapshot:()=>{if(options.badSnapshot)throw new HistoricalFareReconciliationRequired('Missing snapshot');return fare;},toMinor:(v:number)=>Math.round(v*100)}};
  if(name.includes('audit.service'))return {AuditService:{logBooking:async()=>{}}};
  if(name.includes('payment-authority'))return {PaymentAuthorityService:{resolve:async()=>({serviceFareMajor:10,totalAuthorisationMajor:10})}};
  return {};
 }};
 vm.runInNewContext(ts.transpileModule(fs.readFileSync('server/services/logistics.service.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,context);
 const service=context.exports.LogisticsService;
 return {run:(pin='1234',driver='driver')=>service.completeJob(job.id,pin,driver),calls,captures,reads,tables};
}
describe('completion with independently retryable payouts',()=>{
 it('queues the frozen entitlement rather than issuing a synchronous transfer',async()=>{const t=setup();const result=await t.run();expect(result.status).toBe('completed');expect(t.calls[0].fn).toBe('complete_job_with_pending_payout');expect(t.calls[0].args.p_terms.payout).toBe(8);});
 it('does not settle the wallet in a separate non-atomic RPC',async()=>{const t=setup();await t.run();expect(t.calls.map(c=>c.fn)).toEqual(['complete_job_with_pending_payout']);});
 it('marks the returned job with pending payout information',async()=>{const t=setup();expect((await t.run()).metadata.driver_payout_pending).toBe(true);});
 it('a completed queue returns without validating PIN or moving money again',async()=>{const t=setup({queued:true,job:{status:'completed'}});await t.run('');expect(t.calls).toHaveLength(0);expect(t.reads).not.toContain('job_completion_secrets');});
 it('a paid earnings marker is a no-op',async()=>{const t=setup({paidEarnings:true,job:{status:'completed'}});await t.run();expect(t.calls).toHaveLength(0);});
 it('an already settled wallet can complete without a second debit',async()=>{const t=setup({job:{payment_status:'paid'}});await t.run();expect(t.captures).toHaveLength(0);expect(t.calls).toHaveLength(1);});
 it('wrong driver is rejected before PIN lookup',async()=>{const t=setup();await expect(t.run('1234','stranger')).rejects.toThrow('assigned driver');expect(t.reads).not.toContain('job_completion_secrets');expect(t.calls).toHaveLength(0);});
 it('wrong PIN causes no financial operation',async()=>{const t=setup();await expect(t.run('9999')).rejects.toThrow('incorrect');expect(t.calls).toHaveLength(0);});
 it('failed PIN lookup fails closed',async()=>{const t=setup({secretError:{code:'PGRST205'}});await expect(t.run()).rejects.toThrow('could not be verified');expect(t.calls).toHaveLength(0);});
 it('required PIN cannot disappear silently',async()=>{const t=setup();t.tables.job_completion_secrets=null;await expect(t.run()).rejects.toThrow('unavailable');});
 it('cancelled bookings cannot complete',async()=>{const t=setup({job:{status:'cancelled'}});await expect(t.run()).rejects.toThrow('not ready');expect(t.calls).toHaveLength(0);});
 it('an ambiguous legacy transfer is blocked for reconciliation',async()=>{const t=setup({job:{settlement_status:'unknown'}});await expect(t.run()).rejects.toThrow('reconciliation');expect(t.calls).toHaveLength(0);});
 it('an already captured card is verified instead of captured again',async()=>{const t=setup({job:{payment_method:'card',payment_status:'authorized',payment_intent_id:'pi_fixture'},intent:{status:'succeeded'}});await t.run();expect(t.captures).toHaveLength(0);});
 it('capture uses the deterministic job key and exact fare',async()=>{const t=setup({job:{payment_method:'card',payment_status:'authorized',payment_intent_id:'pi_fixture'}});await t.run();expect(t.captures[0][1].amount_to_capture).toBe(1000);expect(t.captures[0][2].idempotencyKey).toContain('capture-job-');});
 it('captured amount mismatch requires reconciliation',async()=>{const t=setup({job:{payment_method:'card',payment_status:'authorized',payment_intent_id:'pi_fixture'},intent:{status:'succeeded',amount_received:900}});await expect(t.run()).rejects.toThrow('amount');expect(t.calls).toHaveLength(0);});
 it('missing frozen snapshot is never recomputed from live prices',async()=>{const t=setup({badSnapshot:true});await expect(t.run()).rejects.toThrow('Missing snapshot');expect(t.calls).toHaveLength(0);});
 it('database completion failure is reported without claiming success',async()=>{const t=setup({rpcFailure:true});await expect(t.run()).rejects.toThrow('Atomic completion failed');});
});
