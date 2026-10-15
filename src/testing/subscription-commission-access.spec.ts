import {expect,it,vi} from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
function driver(plan:string,subscription:string,slug:string,compatible=true){
 const source=fs.readFileSync('src/app/core/services/driver/driver.service.ts','utf8');
 const parsed=ts.createSourceFile('driver.ts',source,ts.ScriptTarget.Latest,true);
 const klass=parsed.statements.find(ts.isClassDeclaration)!;
 const method=klass.members.filter(m=>['acceptJob','toggleOnline'].includes(m.name?.getText(parsed)||'')).map(m=>m.getText(parsed)).join('\n');
 const ctx:any={exports:{},environment:{apiUrl:'test'},firstValueFrom:async(x:any)=>x,console,acquisitionErrorMessage:(_:any,fallback:string)=>fallback};
 vm.runInNewContext(ts.transpileModule('export class Driver {'+method+'}',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,ctx);
 const r=new ctx.exports.Driver();const post=vi.fn(async()=>({accepted:true}));const job={id:'job',service_slug:slug};
 r.auth={currentUser:()=>({id:'driver'}),accountStatus:()=> 'active'};
 r.compliance={getDriverBaseMissingRequirements:()=>[]};
 r.fetchStripeAccount=async()=>({});r.fetchAvailableJobs=async()=>[];r.subscribeToJobs=()=>{};r.subscribeToNegotiationSessions=()=>{};r.onlineStatus={set:vi.fn()};r.supabase={from:()=>({update(){return this;},eq:async()=>({error:null})})};
 r.fetchProfile=async()=>({pricing_plan:plan,subscription_status:subscription});r.vehicle=()=>({});r.getAcceptanceBlockers=async()=>[];
 r.bookingService={getBooking:async()=>job};r.compliance={getDriverBaseMissingRequirements:()=>[],canDriverAcceptService:()=>({allowed:true})};
 r.vehicleCompatibility={isCompatible:()=>compatible,getRequiredLabel:()=> 'van',getVehicleLabel:()=> 'car'};
 r.http={post};r.authHeaders=async()=>({});r.eventService={logEvent:async()=>{}};r.activeJob={set:vi.fn()};r.availableJobs={update:vi.fn()};
 return {r,post};
}
it.each(['delivery','van-moving'])('allows Starter %s to reach authoritative acceptance without a subscription',async slug=>{const {r,post}=driver('starter','inactive',slug);await r.acceptJob('job');expect(post).toHaveBeenCalledTimes(1);expect(r.activeJob.set).toHaveBeenCalled();});
it.each(['delivery','van-moving'])('allows unsubscribed Pro-labelled %s with standard checks',async slug=>{const {r,post}=driver('pro','inactive',slug);await r.acceptJob('job');expect(post).toHaveBeenCalledTimes(1);});
it.each(['delivery','van-moving'])('allows subscribed Pro %s',async slug=>{const {r,post}=driver('pro','active',slug);await r.acceptJob('job');expect(post).toHaveBeenCalledTimes(1);});
it('retains the van compatibility rejection',async()=>{const {r,post}=driver('starter','inactive','van-moving',false);await expect(r.acceptJob('job')).rejects.toThrow('needs van');expect(post).not.toHaveBeenCalled();});

it.each(['starter','pro'])('allows %s drivers online without a subscription',async plan=>{const {r}=driver(plan,'inactive','delivery');await r.toggleOnline('online');expect(r.onlineStatus.set).toHaveBeenCalledWith('online');});
it('still blocks suspended accounts',async()=>{const {r,post}=driver('starter','inactive','delivery');r.auth.accountStatus=()=> 'suspended';await expect(r.acceptJob('job')).rejects.toThrow('suspended');await expect(r.toggleOnline('online')).rejects.toThrow('suspended');expect(post).not.toHaveBeenCalled();});
it('still blocks unresolved driver compliance',async()=>{const {r,post}=driver('starter','inactive','delivery');r.getAcceptanceBlockers=async()=>['Insurance expired'];r.formatAcceptanceBlockers=(b:any)=>b.join(',');await expect(r.acceptJob('job')).rejects.toThrow('Insurance expired');expect(post).not.toHaveBeenCalled();});
