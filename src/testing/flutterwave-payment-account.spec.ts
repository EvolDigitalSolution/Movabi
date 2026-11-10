import {describe,it,expect,vi,afterEach} from 'vitest';
import {createHmac} from 'node:crypto';
vi.mock('../../server/services/payout-eligibility.service',()=>({PayoutEligibilityService:{evaluateDriver:async()=>({eligible:true})}}));
import {FlutterwaveDriverPayout,payoutMarketReady} from '../../server/services/payments/flutterwave-driver-payout';
import {DriverPaymentAccountService,sandboxPayoutProvider} from '../../server/services/driver-payment-account.service';
import {FlutterwaveJobPayoutService} from '../../server/services/flutterwave-job-payout.service';
const account='0123456789',bank='044',fingerprintKey='synthetic-fingerprint-key-32-characters';
const beneficiary={id:'9',bank_code:bank,last4:'6789',fingerprint:createHmac('sha256',fingerprintKey).update(bank+':'+account).digest('hex')};
const transfer={reference:'vaydu-11111111-1111-4111-8111-111111111111_PMCK',amountMinor:10001,currency:'NGN',beneficiary};
function adapter(options:any={}){
 const calls:any[]=[];const request=vi.fn(async(url:any,init:any)=>{
  const path=String(url).replace('https://api.flutterwave.com/v3','');const body=init.body?JSON.parse(init.body):null;calls.push({path,body,raw:init.body});
  if(options.fail===path)throw Error('sensitive provider diagnostics');
  const data=path==='/banks/9/branches'?(options.branches||[]):path==='/banks/NG'?[{code:bank,name:'Test Bank',...(options.missingBranchFlag?{id:9}:{has_branches:false})},{code:'999',name:'Branch Bank',has_branches:true}]
   :path==='/accounts/resolve'?{account_number:account,account_name:options.name||'Test Driver'}
   :path==='/beneficiaries'?{id:9}:path==='/beneficiaries/9'?{id:options.otherId||9,bank_code:bank,account_number:options.otherAccount||account}
   :path.startsWith('/transfers?')?(options.transfers??[]):{id:12,status:'NEW'};
  return new Response(JSON.stringify({status:'success',data}));
 }) as any;
 return {provider:new FlutterwaveDriverPayout('FLWSECK_TEST-synthetic',fingerprintKey,request,undefined,options.allowTransfers===true),calls,request};
}
const market={country_code:'NG',currency_code:'NGN',provider:'flutterwave',merchant_account_ref:'test-merchant',enabled:true,merchant_approved:true,adapter_ready:true,capability_verified_at:'2026-10-27',capability_evidence_ref:'synthetic-only',merchant_mode:'test',sandbox_driver_id:'driver',sandbox_tenant_id:'tenant'};
const fullTransfer=(extra:any={})=>({id:12,reference:transfer.reference,amount:100.01,currency:'NGN',bank_code:bank,account_number:account,status:'SUCCESSFUL',fee:1.25,...extra});
describe('Flutterwave v3 beneficiary adapter',()=>{
 it('rejects live credentials before any request',()=>{const request=vi.fn();expect(()=>new FlutterwaveDriverPayout('FLWSECK-live',fingerprintKey,request)).toThrow();expect(request).not.toHaveBeenCalled();});
 it('requires a separate secure fingerprint key',()=>expect(()=>new FlutterwaveDriverPayout('FLWSECK_TEST-synthetic','short')).toThrow());
 it('filters branch-bearing banks instead of inventing branch details',async()=>expect(await adapter().provider.banks()).toEqual([{code:bank,name:'Test Bank'}]));
 it('queries branches when bank metadata omits the branch flag',async()=>{const h=adapter({missingBranchFlag:true});expect(await h.provider.resolve(bank,account)).toBe('Test Driver');expect(h.calls.some(c=>c.path==='/banks/9/branches')).toBe(true);});
 it('refuses a bank requiring uncollected branch details',async()=>expect(adapter({missingBranchFlag:true,branches:[{id:1}]}).provider.resolve(bank,account)).rejects.toThrow('branch details'));
 it('resolves NG accounts without persisting bank details',async()=>expect(await adapter().provider.resolve(bank,account)).toBe('Test Driver'));
 it.each(['123','not-an-account','01234567890'])('rejects invalid account %s before network',async a=>{const h=adapter();await expect(h.provider.resolve(bank,a)).rejects.toThrow();expect(h.calls).toHaveLength(0);});
 it('rejects a bank outside the returned list',async()=>expect(adapter().provider.resolve('888',account)).rejects.toThrow());
 it('requires the confirmed account name to remain unchanged',async()=>{const h=adapter({name:'Changed Name'});await expect(h.provider.createBeneficiary(bank,account,'Test Driver')).rejects.toThrow();expect(h.calls.some(c=>c.path==='/beneficiaries')).toBe(false);});
 it('stores a reference, last four and keyed fingerprint only',async()=>{const b=await adapter().provider.createBeneficiary(bank,account,'Test Driver');expect(b).toEqual(beneficiary);expect(JSON.stringify(b)).not.toContain(account);});
 it('does not accept another beneficiary destination',async()=>expect(adapter({otherAccount:'9999999999'}).provider.createBeneficiary(bank,account)).rejects.toThrow());
 it('requires the retrieved beneficiary identifier to match',async()=>expect(adapter({otherId:10}).provider.createBeneficiary(bank,account)).rejects.toThrow());
 it('keeps transfers disabled by default without contacting the provider',async()=>{const h=adapter();await expect(h.provider.submit(transfer)).rejects.toThrow('disabled');expect(h.calls).toHaveLength(0);});
 it('suppresses provider diagnostics',async()=>{await expect(adapter({fail:'/accounts/resolve'}).provider.resolve(bank,account)).rejects.toThrow('provider unavailable');});
 it('submits exact major-unit amount and unique test reference without assuming completion',async()=>{const h=adapter({allowTransfers:true});expect(await h.provider.submit(transfer)).toBeUndefined();const c=h.calls.find(c=>c.path==='/transfers');expect(c.body.amount).toBe(100.01);expect(c.raw).toContain('"amount":100.01');expect(c.body.reference).toBe(transfer.reference);});
 it.each([['NEW','pending'],['PENDING','pending'],['SUCCESSFUL','completed'],['FAILED','failed'],['unrecognized','unknown']])('maps %s only after lookup',async(status,state)=>expect(await adapter({transfers:[fullTransfer({status})]}).provider.lookup(transfer)).toMatchObject({state}));
 it.each([{currency:'GBP'},{amount:100},{reference:'other'},{account_number:'1111111111'},{bank_code:'033'}])('rejects mismatched transfer identity %j',async change=>expect(await adapter({transfers:[fullTransfer(change)]}).provider.lookup(transfer)).toEqual({state:'unknown'}));
 it('blocks ambiguous duplicate references',async()=>expect(await adapter({transfers:[fullTransfer(),fullTransfer()]}).provider.lookup(transfer)).toEqual({state:'unknown'}));
 it('returns missing separately from unknown',async()=>expect(await adapter().provider.lookup(transfer)).toBeNull());
});
function store(options:any={}){
 const writes:any[]=[];const filters:any[]=[];const row:any={id:'destination',driver_id:'driver',tenant_id:'tenant',state:'completed',beneficiary_id:'9',...beneficiary,...options.account};
 const db:any={from(table:string){const f:any={};let patch:any;const chain:any={select(){return chain;},is(){return chain;},eq(k:string,v:any){f[k]=v;filters.push([table,k,v]);return chain;},update(p:any){patch=p;return chain;},single(){return result();},maybeSingle(){return result();},then(resolve:any,reject:any){return result().then(resolve,reject);}};
  async function result(){if(patch){writes.push(patch);Object.assign(row,patch);return {data:[{id:row.id}]};}return {data:table==='profiles'?{id:'driver',role:'driver',registration_activated_at:'now',registration_country_code:'NG',tenant_id:'tenant',...options.profile}
   :table==='market_availability'?[{supported_currency:'NGN'}]:table==='driver_payout_markets'?{...market,...options.market}:options.missing?null:row};}return chain;},rpc:vi.fn(async()=>({data:options.noClaim?[]:[{id:row.id,setup_token:'lease'}]}))};
 return {db,writes,filters,row};
}
describe('owner-bound payment-account setup',()=>{
 it('requires all merchant capabilities independently of collection',()=>{for(const key of ['enabled','merchant_approved','adapter_ready','merchant_account_ref','capability_verified_at'])expect(payoutMarketReady({...market,[key]:null})).toBe(false);expect(payoutMarketReady(market)).toBe(true);});
 it.each([{sandbox_driver_id:'other'},{sandbox_tenant_id:'other'},{currency_code:'GBP'},{provider:'kora'},{merchant_approved:false}])('does not expose setup for another scope %j',async m=>{const h=store({market:m});expect(await new DriverPaymentAccountService(h.db,()=>adapter().provider).status('driver')).toMatchObject({state:'unavailable',available:false});});
 it('rejects a customer account',async()=>{const h=store({profile:{role:'customer'}});await expect(new DriverPaymentAccountService(h.db,()=>adapter().provider).status('driver')).rejects.toThrow('activated driver');});
 it('persists verified setup with owner and merchant filters',async()=>{const h=store();const s=new DriverPaymentAccountService(h.db,()=>adapter().provider);expect(await s.setup('driver',bank,account,'Test Driver')).toEqual({state:'completed',last4:'6789'});expect(JSON.stringify(h.writes)).not.toContain(account);await s.status('driver');expect(h.filters).toContainEqual(['driver_payment_accounts','tenant_id','tenant']);expect(h.filters).toContainEqual(['driver_payment_accounts','merchant_account_ref','test-merchant']);});
 it('parks an ambiguous submission for reconciliation instead of claiming action-required',async()=>{const h=store();await expect(new DriverPaymentAccountService(h.db,()=>adapter({fail:'/accounts/resolve'}).provider).setup('driver',bank,account,'Test Driver')).rejects.toThrow();expect(h.row.state).toBe('reconciliation_required');expect(h.row.submission_attempted_at).toBeTruthy();});
 it('does not call the provider without the durable setup claim',async()=>{const h=store({noClaim:true}),p=adapter();await expect(new DriverPaymentAccountService(h.db,()=>p.provider).setup('driver',bank,account,'Test Driver')).rejects.toThrow();expect(p.calls).toHaveLength(0);});
 it('delegates GB status to the existing Stripe authority',async()=>{const h=store({profile:{registration_country_code:'GB'},market:{provider:'stripe'}});h.db.from=((original:any)=>(table:string)=>table==='market_availability'?{select(){return this;},eq:async()=>({data:[{supported_currency:'GBP'}]})}:original(table))(h.db.from);expect(await new DriverPaymentAccountService(h.db,()=>{throw Error('never');}).status('driver')).toMatchObject({provider:'stripe',state:'completed'});});
});
function worker(options:any={}){
 let claimed=false,submits=0;const finishes:any[]=[],updates:any[]=[];
 const db={rpc:async(name:string,args:any)=>{if(name==='claim_flutterwave_job_submission'){const first=!claimed;claimed=true;return {data:first};}finishes.push(args);return {data:true};}};
 const accounts:any={ready:async()=>({account:{...beneficiary,id:'destination',beneficiary_id:'9'},tenant:'tenant',country:'NG',currency:'NGN',market})};
 const provider:any={lookup:async()=>{if(options.lookupError)throw Error('offline');return options.result||null;},submit:async()=>{submits++;if(options.submitError)throw Error('timeout');}};
 const q={job_id:'11111111-1111-4111-8111-111111111111',driver_id:'driver',destination:'flw:destination',amount_minor:10001,currency:'ngn',token:'lease',terms:{payout_provider:'flutterwave',payout_account_id:'destination',payout_merchant:'test-merchant',payout_tenant:'tenant',country:'NG',...options.terms}};
 const service=new FlutterwaveJobPayoutService(db,accounts,()=>provider);return {run:()=>service.process(q,async(...a)=>{updates.push(a);}),finishes,updates,submits:()=>submits};
}
describe('existing payout outbox Flutterwave dispatch',()=>{
 it('accepted is pending, never paid',async()=>{const h=worker();await h.run();expect(h.submits()).toBe(1);expect(h.finishes).toHaveLength(0);expect(h.updates[0][0]).toBe('reconcile');});
 it('commits only a server-verified successful transfer',async()=>{const h=worker({result:{state:'completed',id:'12',fee:'1.25'}});await h.run();expect(h.finishes[0]).toMatchObject({p_transfer:'12',p_fee:'1.25'});expect(h.submits()).toBe(0);});
 it.each(['pending','unknown','failed'])('reconciles/blocks %s without fallback or create',async state=>{const h=worker({result:{state,id:'12'}});await h.run();expect(h.submits()).toBe(0);expect(h.finishes).toHaveLength(0);expect(h.updates[0][0]).toBe(state==='failed'?'blocked':'reconcile');});
 it('concurrent requests claim one submission',async()=>{const h=worker();await Promise.all([h.run(),h.run()]);expect(h.submits()).toBe(1);});
 it('an unknown submission is never retried even if later lookup is empty',async()=>{const h=worker({submitError:true});await h.run();await h.run();expect(h.submits()).toBe(1);expect(h.finishes).toHaveLength(0);});
 it('lookup failure never triggers submission',async()=>{const h=worker({lookupError:true});await h.run();expect(h.submits()).toBe(0);});
 it.each([{payout_tenant:'other'},{payout_merchant:'other'},{payout_account_id:'other'},{country:'GH'}])('blocks a changed frozen scope %j',async terms=>{const h=worker({terms});await h.run();expect(h.updates[0][0]).toBe('blocked');expect(h.submits()).toBe(0);});
});
afterEach(()=>vi.unstubAllEnvs());
describe('runtime interlock',()=>{
 it('defaults disabled even with a test key',()=>{vi.stubEnv('FLUTTERWAVE_TEST_SECRET_KEY','FLWSECK_TEST-synthetic');expect(()=>sandboxPayoutProvider()).toThrow();});
 it('rejects production runtime before provider use',()=>{vi.stubEnv('NODE_ENV','production');vi.stubEnv('VAYDU_DEPLOYMENT_ENV','develop');vi.stubEnv('VAYDU_DRIVER_PAYOUT_SANDBOX','true');expect(()=>sandboxPayoutProvider()).toThrow();});
});
