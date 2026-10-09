import { describe,it,expect } from 'vitest';
import { issueJourneyGrant,verifyJourneyGrant,parseJourneyPoint,ACTIVE_JOURNEY_STATUSES } from '../../server/services/journey-location.service';
import { journeyProgress } from '../app/shared/utils/journey-progress';
import fs from 'node:fs';import vm from 'node:vm';import ts from 'typescript';
const grant={jobId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',driverId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',tenantId:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',expires:Date.now()+100000};
describe('journey upload authority',()=>{
 it('accepts the signed scoped journey',()=>expect(verifyJourneyGrant(issueJourneyGrant(grant,'secret'),'secret')?.driverId).toBe(grant.driverId));
 it('rejects tampering',()=>expect(verifyJourneyGrant(issueJourneyGrant(grant,'secret')+'x','secret')).toBeNull());
 it('rejects another signing key',()=>expect(verifyJourneyGrant(issueJourneyGrant(grant,'secret'),'other')).toBeNull());
 it('rejects expiry',()=>expect(verifyJourneyGrant(issueJourneyGrant({...grant,expires:Date.now()-1},'secret'),'secret')).toBeNull());
 it('rejects an unbounded expiry',()=>expect(verifyJourneyGrant(issueJourneyGrant({...grant,expires:Date.now()+7*3600000},'secret'),'secret')).toBeNull());
 it('accepts a fresh accurate point',()=>expect(parseJourneyPoint({latitude:53,longitude:-2,time:Date.now(),accuracy:8})?.lat).toBe(53));
 for(const [name,value] of [['old',{time:Date.now()-100000}],['future',{time:Date.now()+60000}],['inaccurate',{accuracy:120}],['NaN',{latitude:NaN}],['zero',{latitude:0,longitude:0}],['string',{latitude:'53'}],['bounds',{longitude:181}]] as const)
 it('rejects '+name+' GPS',()=>expect(parseJourneyPoint({latitude:53,longitude:-2,time:Date.now(),accuracy:8,...value})).toBeNull());
 it('does not permit completed or cancelled uploads',()=>{expect(ACTIVE_JOURNEY_STATUSES.has('completed')).toBe(false);expect(ACTIVE_JOURNEY_STATUSES.has('cancelled')).toBe(false);});
});
const route={coordinates:[[0,51],[0.001,51],[0.002,51]],steps:[{instruction:'Continue',startIndex:0,endIndex:1,distanceMeters:70,durationSeconds:10},{instruction:'Arrive',startIndex:1,endIndex:2,distanceMeters:70,durationSeconds:10}],distanceMeters:140,durationSeconds:20};
describe('navigation progress',()=>{
 it('advances to the next instruction',()=>expect(journeyProgress(route,{lat:51,lng:0.001}).step?.instruction).toBe('Arrive'));
 it('accepts the middle of a sparse route segment',()=>{const sparse={...route,coordinates:[[0,51],[0.01,51]],distanceMeters:700};const p=journeyProgress(sparse,{lat:51,lng:0.005});expect(p.offRoute).toBe(false);expect(p.remainingMeters).toBeGreaterThan(300);expect(p.remainingMeters).toBeLessThan(400);});
 it('keeps progress monotonic',()=>expect(journeyProgress(route,{lat:51,lng:0},1).index).toBe(1));
 it('does not advance on an off-route fix',()=>{const result=journeyProgress(route,{lat:52,lng:1},1);expect(result.offRoute).toBe(true);expect(result.index).toBe(1);expect(result.remainingMeters).toBeNull();});
 it('calculates zero remaining at the destination',()=>expect(journeyProgress(route,{lat:51,lng:0.002}).remainingMeters).toBe(0));
});
function tracker(native=true){
 let user:any={id:grant.driverId};let job:any={id:grant.jobId,driver_id:grant.driverId,status:'en_route_to_customer'};
 const effects:Array<()=>void>=[],starts:any[]=[],stops:any[]=[],posts:any[]=[],watches:any[]=[],clears:any[]=[];let callback:any;
 const signal=(value:any)=>Object.assign(()=>value,{set:(next:any)=>value=next});
 const dependencies=[{activeJob:()=>job},{currentUser:()=>user},{auth:{getSession:async()=>({data:{session:{access_token:'user-token'}}})}},{getApiUrl:(p:string)=>'https://api.test'+p},{post:(url:string,body:any)=>{posts.push({url,body});return Promise.resolve({token:'scoped-token',expires:Date.now()+3600000});}}];
 const background={start:async(options:any,fn:any)=>{starts.push(options);callback=fn;},stop:async()=>{stops.push(true);},updateHeaders:async()=>{}};
 const require=(name:string)=>name==='@angular/core'?{Injectable:()=>()=>{},inject:()=>dependencies.shift(),signal,effect:(fn:any)=>{effects.push(fn);fn();},untracked:(fn:any)=>fn()}:name==='@capacitor/core'?{Capacitor:{isNativePlatform:()=>native,isPluginAvailable:()=>native}}:name==='@capgo/background-geolocation'?{BackgroundGeolocation:background}:name==='rxjs'?{firstValueFrom:(value:any)=>value}:{};
 const context:any={exports:{},require,Date,Number,Set,Promise,navigator:{geolocation:{watchPosition:(fn:any)=>{watches.push(fn);return 1;},clearWatch:(id:any)=>clears.push(id)}},setInterval:()=>1,clearInterval:()=>{}};
 const code=ts.transpileModule(fs.readFileSync('src/app/core/services/logistics/journey-tracking.service.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,experimentalDecorators:true}}).outputText;
 vm.runInNewContext(code,context);const instance:any=new context.exports.JourneyTrackingService();
 return {instance,starts,stops,posts,watches,clears,callback:()=>callback,change:(nextJob:any,nextUser:any=user)=>{job=nextJob;user=nextUser;effects.forEach(fn=>fn());}};
}
describe('tracking lifecycle',()=>{
 it('starts one native uploader with a scoped token, not the user bearer',async()=>{const t=tracker();await t.instance.serial;expect(t.starts).toHaveLength(1);expect(t.starts[0].headers).toEqual({'X-Movabi-Journey-Token':'scoped-token'});expect(t.starts[0].minIntervalMs).toBe(10000);});
 it('stops on completion',async()=>{const t=tracker();await t.instance.serial;t.change({id:grant.jobId,driver_id:grant.driverId,status:'completed'});await t.instance.serial;expect(t.stops).toHaveLength(1);expect(t.instance.mode()).toBe('stopped');});
 it('stops on logout',async()=>{const t=tracker();await t.instance.serial;t.change(null,null);await t.instance.serial;expect(t.stops).toHaveLength(1);});
 it('does not restart for a same-job status change',async()=>{const t=tracker();await t.instance.serial;t.change({id:grant.jobId,driver_id:grant.driverId,status:'arrived_at_customer'});await t.instance.serial;expect(t.starts).toHaveLength(1);});
 it('ignores stale native fixes',async()=>{const t=tracker();await t.instance.serial;t.callback()({latitude:53,longitude:-2,accuracy:8,bearing:null,time:Date.now()-100000});expect(t.instance.point()).toBeNull();});
 it('uses foreground browser GPS and clears the watcher',async()=>{const t=tracker(false);await t.instance.serial;expect(t.starts).toHaveLength(0);expect(t.watches).toHaveLength(1);t.change(null,null);await t.instance.serial;expect(t.clears).toEqual([1]);});
});
