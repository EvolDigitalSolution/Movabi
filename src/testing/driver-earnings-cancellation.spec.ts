import {describe,it,expect,vi,beforeEach} from 'vitest';
const fixture=vi.hoisted(()=>({role:'driver',profileTenant:null as string|null,job:{} as any,subscriptions:[] as any[],queries:[] as string[],failSubscriptions:false}));
vi.mock('../../server/services/supabase.service',()=>({supabaseAdmin:{from:(table:string)=>{
 fixture.queries.push(table);
 const data=()=>table==='profiles'?{id:'driver',role:fixture.role,tenant_id:fixture.profileTenant,registration_country_code:'GB'}:table==='jobs'?fixture.job:fixture.subscriptions;
 const q:any={select:()=>q,eq:()=>q,is:()=>q,not:()=>q,maybeSingle:async()=>({data:data(),error:null}),then:(resolve:any)=>Promise.resolve({data:data(),error:table==='subscriptions'&&fixture.failSubscriptions?Error('Unavailable'):null}).then(resolve)};
 return q;
}}}));
vi.mock('../../server/services/stripe.service',()=>({stripe:{}}));
vi.mock('../../server/services/pricing.service',()=>({PricingService:{applyAgreedFare:(job:any,n:number)=>({fare_breakdown:{...job.fare_breakdown,driverBase:n-2,driverEntitlement:n-3,driverCommissionAmount:1,driverCommissionPolicy:{...job.fare_breakdown.driverCommissionPolicy,standardCommissionAmount:1}}})}}));
import {DriverEarningsPreviewService} from '../../server/services/driver-earnings-preview.service';
import {NoShowService} from '../../server/services/no-show.service';
import {driverMoneyView} from '../app/shared/utils/driver-money-view';
beforeEach(()=>{fixture.role='driver';fixture.profileTenant='tenant';fixture.failSubscriptions=false;fixture.subscriptions=[];fixture.queries=[];fixture.job={id:'job',status:'searching',tenant_id:'tenant',country_code:'GB',currency_code:'GBP',negotiation_mode_enabled:true,fare_breakdown:{policyVersion:'fare-split-v1',customerCharge:12,platformFeeAmount:2,driverBase:10,driverEntitlement:8,driverCommissionAmount:2,driverCommissionPolicy:{version:'subscription-commission-v1',frozen:false,standardCommissionAmount:2}}};});
describe('driver earnings preview',()=>{
 it('excludes customer platform fees and uses persisted standard commission',async()=>{expect(await DriverEarningsPreviewService.preview('driver','job')).toMatchObject({gross:10,net:8,deductions:2,estimated:true});});
 it('waives commission for an authoritative active subscription',async()=>{fixture.subscriptions=[{stripe_subscription_id:'sub',current_period_end:'2099-01-01'}];expect(await DriverEarningsPreviewService.preview('driver','job')).toMatchObject({net:10,deductions:0});});
 it('does not waive commission for expired subscription',async()=>{fixture.subscriptions=[{stripe_subscription_id:'sub',current_period_end:'2020-01-01'}];expect((await DriverEarningsPreviewService.preview('driver','job')).net).toBe(8);});
 it('preserves already-frozen terms despite subscription changes',async()=>{fixture.job.driver_id='driver';fixture.job.fare_breakdown.driverCommissionPolicy.frozen=true;fixture.subscriptions=[{stripe_subscription_id:'sub'}];expect((await DriverEarningsPreviewService.preview('driver','job')).net).toBe(8);expect(fixture.queries).not.toContain('subscriptions');});
 it('rejects a different driver assignment',async()=>{fixture.job.driver_id='another';await expect(DriverEarningsPreviewService.preview('driver','job')).rejects.toThrow('unavailable');});
 it('rejects another tenant',async()=>{fixture.job.tenant_id='other';await expect(DriverEarningsPreviewService.preview('driver','job')).rejects.toThrow('unavailable');});
 it('rejects customer role',async()=>{fixture.role='customer';await expect(DriverEarningsPreviewService.preview('driver','job')).rejects.toThrow('Driver access');expect(fixture.queries).not.toContain('jobs');});
 it('rejects ended unassigned bookings',async()=>{fixture.job.status='cancelled';await expect(DriverEarningsPreviewService.preview('driver','job')).rejects.toThrow('unavailable');});
 it('does not show zero commission on a subscription read failure',async()=>{fixture.failSubscriptions=true;await expect(DriverEarningsPreviewService.preview('driver','job')).rejects.toThrow('Unavailable');});
 it('previews proposed negotiation money without changing stored job',async()=>{const before=JSON.stringify(fixture.job);expect(await DriverEarningsPreviewService.preview('driver','job',20)).toMatchObject({gross:18,net:17,deductions:1});expect(JSON.stringify(fixture.job)).toBe(before);});
 it.each([NaN,Infinity,-1,0])('rejects invalid proposed amount %s',async amount=>{await expect(DriverEarningsPreviewService.preview('driver','job',amount)).rejects.toThrow('Invalid');});
});
describe('versioned no-show terms',()=>{
 it('new economy policy caps charge at £3.80 or the entire fare, whichever lower',()=>{expect(NoShowService.computeCurrentNoShowSplit(2000).feeMinor).toBe(380);expect(NoShowService.computeCurrentNoShowSplit(250).feeMinor).toBe(250);});
 it('preserves old disclosed £5/half-fare terms',()=>{expect(NoShowService.computeNoShowSplit(350).feeMinor).toBe(175);expect(NoShowService.computeNoShowSplit(3000).feeMinor).toBe(500);});
 it('all disclosed waiting windows use the five-minute maximum',()=>{expect(NoShowService.graceMinutesFor({noShowPolicyVersion:'ride-no-show-v2'})).toBe(5);expect(NoShowService.graceMinutesFor({noShowPolicyVersion:'ride-no-show-v1'})).toBe(5);});
 it('supports reading both disclosed policy versions',()=>{for(const version of ['ride-no-show-v1','ride-no-show-v2'])expect(NoShowService.splitFromBreakdown({noShowPolicyVersion:version,noShowFeeMinor:380})?.feeMinor).toBe(380);});
 it('rejects unknown disclosure versions',()=>{expect(NoShowService.splitFromBreakdown({noShowPolicyVersion:'forged'})).toBeNull();});
 it('preserves compensation conservation at every fee penny',()=>{for(let n=0;n<600;n++){const s=NoShowService.computeCurrentNoShowSplit(n);expect(s.driverShareMinor+s.platformShareMinor).toBe(s.feeMinor);expect(s.feeMinor).toBeLessThanOrEqual(n);}});
});
describe('recorded driver money',()=>{
 it('reads the frozen snapshot instead of the inclusive agreed fare',()=>{expect(driverMoneyView({...fixture.job,agreed_fare:12,driver_payout:null})).toEqual({gross:10,net:8,deductions:2});});
 it('never falls back to a customer total or platform fee',()=>{expect(driverMoneyView({agreed_fare:12,price:12,platform_fee:2})).toEqual({gross:null,net:null,deductions:null});});
 it('preserves zero commission and zero payout',()=>{expect(driverMoneyView({fare_breakdown:{driverBase:0,driverEntitlement:0,driverCommissionAmount:0}})).toEqual({gross:0,net:0,deductions:0});});
});
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
function member(file:string,name:string,globals:any={}){
 const text=fs.readFileSync(file,'utf8'),ast=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true);
 const klass=ast.statements.find(ts.isClassDeclaration)!;
 const m=klass.members.find(x=>x.name?.getText(ast)===name)!;
 const ctx:any={exports:{},computed:(fn:any)=>fn,...globals};
 vm.runInNewContext(ts.transpileModule('export class View {'+m.getText(ast)+'}',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,ctx);
 const instance=new ctx.exports.View();const fn=instance[name];return function(this:any,...args:any[]){Object.assign(instance,this);return fn.apply(instance,args);};
}
const tracking='src/app/apps/mobile/features/customer/booking-tracking/booking-tracking.page.ts';
describe('customer tracking transitions',()=>{
 it('announces a handoff after refresh and stops the notice once replacement accepts',()=>{
  const fn=member(tracking,'driverReplacementNotice');
  const b:any={status:'searching',driver_id:null,metadata:{last_driver_handoff:{driver_id:'old'}}};const view={booking:()=>b};
  expect(fn.call(view)).toBe(true);b.driver_id='replacement';b.status='accepted';expect(fn.call(view)).toBe(false);
 });
 it('does not label a normal cancellation as customer no-show merely because arrival exists',()=>{
  const fn=member(tracking,'noShowOutcome');
  const view={booking:()=>({status:'cancelled',no_show_arrived_at:'2026-01-01'}),noShowTerms:()=>null};
  expect(fn.call(view)).toBeNull();
 });
 it('reports pending no-show payment honestly and confirmed payment separately',()=>{
  const fn=member(tracking,'noShowOutcome');let status='pending';const view={booking:()=>({status:'cancelled',no_show_status:status}),noShowTerms:()=>({feeMinor:380}),config:{formatCurrency:(n:number)=>'£'+n.toFixed(2)}};
  expect(fn.call(view).state).toBe('pending');status='fee_charged';expect(fn.call(view)).toMatchObject({state:'completed',feeDisplay:'£3.80'});
 });
 it('opens chat at 95% and retains mark-as-read',()=>{
  const calls:any[]=[];const fn=member(tracking,'setActiveTrackingTab');const view={activeTrackingTab:{set:(v:any)=>calls.push(v)},trackingMoreOpen:{set:()=>{}},trackingSheetHeight:{set:(v:any)=>calls.push(v)},updateSheetState:(v:any)=>calls.push(v),showChat:{set:()=>{}},booking:()=>({id:'job'}),notificationOrchestrator:{markAsRead:(id:string)=>calls.push(id)}};
  fn.call(view,'chat');expect(calls).toEqual(['chat',95,95,'job']);
 });
});
