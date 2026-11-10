import { describe,expect,it } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
function fixture(){
 const source=fs.readFileSync('src/app/apps/mobile/features/driver/navigation/journey-navigation.component.ts','utf8');
 const action=source.slice(source.indexOf(' async performAction()'),source.indexOf(' @Input() serviceType'));
 const refresh=source.slice(source.indexOf(' private refreshJobState()'),source.indexOf(' private async tick()'));
 const ctx:any={exports:{}};vm.runInNewContext(ts.transpileModule('export class Navigation {'+action+refresh+'}',{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,ctx);
 const nav:any=new ctx.exports.Navigation();let acting=false;nav.acting=()=>acting;nav.acting.set=(v:boolean)=>acting=v;nav.error={set:(message:string)=>nav.lastError=message};nav.destination={lat:1,lng:1};nav.route={old:true};nav.instruction={set:()=>{}};nav.map={clearRoute:()=>nav.cleared=true};nav.close=()=>nav.closed=true;
 let state:any={status:'accepted',actionLabel:'Arrived',destination:nav.destination,address:'Store',label:'Store'};nav.getJobState=()=>state;return {nav,setState:(value:any)=>state={...state,...value}};
}
describe('navigation action continuity',()=>{
 it('keeps navigation open and advances its action after success',async()=>{const t=fixture();t.nav.onJobAction=async()=>t.setState({status:'arrived',actionLabel:'Start shopping'});await t.nav.performAction();expect(t.nav.closed).not.toBe(true);expect(t.nav.actionLabel).toBe('Start shopping');});
 it('resets directions when the next step changes destination',async()=>{const t=fixture();t.nav.onJobAction=async()=>t.setState({status:'collected',destination:{lat:2,lng:3},label:'Customer',address:'Home'});await t.nav.performAction();expect(t.nav.destination).toEqual({lat:2,lng:3});expect(t.nav.route).toBeNull();expect(t.nav.cleared).toBe(true);});
 it('closes after completion',async()=>{const t=fixture();t.nav.onJobAction=async()=>t.setState({status:'completed'});await t.nav.performAction();expect(t.nav.closed).toBe(true);});
 it('keeps the current route open when an action fails',async()=>{const t=fixture();t.nav.onJobAction=async()=>{throw Error('offline');};await t.nav.performAction();expect(t.nav.closed).not.toBe(true);expect(t.nav.route).toEqual({old:true});expect(t.nav.lastError).toContain('retry');expect(t.nav.acting()).toBe(false);});
 it('does not reset directions for an unchanged destination',()=>{const t=fixture();t.nav.refreshJobState();expect(t.nav.route).toEqual({old:true});});
});

describe('driver live funding recovery',()=>{
 it('updates the decision even if card-status loading fails',async()=>{
  const source=fs.readFileSync('src/app/apps/mobile/features/driver/job-details/job-details.page.ts','utf8');
  const method=source.slice(source.indexOf('    private async refreshFundingLive('),source.indexOf('    private subscribeToErrandFunding('));
  const ctx:any={exports:{},console,ServiceTypeEnum:{ERRAND:'errand'}};
  vm.runInNewContext(ts.transpileModule('export class Driver {'+method+'}',{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,ctx);
  const p:any=new ctx.exports.Driver();let funding:any={over_budget_status:'requested'};p.job=()=>({id:'job',service_slug:'errand'});p.activeRequestTab=()=> 'overview';p.funding=()=>funding;p.funding.set=(value:any)=>funding=value;p.bookingService={getErrandFunding:async()=>({over_budget_status:'approved'})};p.loadIssuingCardStatus=async()=>{throw Error('offline');};
  await p.refreshFundingLive('job');expect(funding.over_budget_status).toBe('approved');expect(p.fundingRecoveryBusy).toBe(false);
 });
});
