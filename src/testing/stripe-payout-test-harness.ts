import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
function actualMethod(file:string,name:string){const source=readFileSync(resolve(process.cwd(),file),'utf8');const tree=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true);let found='';const visit=(n:ts.Node)=>{if(ts.isMethodDeclaration(n)&&n.name.getText(tree)===name)found=n.getText(tree);ts.forEachChild(n,visit);};visit(tree);if(!found)throw Error('Method unavailable: '+name);return found;}
function create(file:string,name:string,context:Record<string,any>,fields:Record<string,any>){const method=actualMethod(file,name);const js=ts.transpileModule(`class Subject {${method}};result=new Subject();`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;const sandbox:any={...context,result:null,console:{warn(){}}};runInNewContext(js,sandbox);return Object.assign(sandbox.result,fields);}
export function connectHarness(){
 const pending:Array<{resolve:(value:any)=>void;reject:(error:any)=>void}>=[];let clock=1000,refreshes=0,ownerId='driver-one';
 const value={ok:true,stripeAccountId:'acct_example',connectStatus:'pending',chargesEnabled:false,payoutsEnabled:false,detailsSubmitted:false,requirementsCurrentlyDue:[]};
 const subject=create('src/app/core/services/stripe/connect.service.ts','getPayoutSettings',{Date:{now:()=>clock},firstValueFrom:(promise:any)=>promise},{supabase:{auth:{getSession:async()=>({data:{session:{user:{id:ownerId}}}})}},marketSafety:{requireStripePayoutMarket:async()=>{}},payoutSettingsInFlight:null,payoutSettingsInFlightForced:false,payoutSettingsCache:null,payoutSettingsCacheMs:10000,apiUrl:'/api/connect',getAuthHeaders:async()=>({}),http:{get:()=>new Promise((resolve,reject)=>pending.push({resolve,reject}))},refreshAccountStatus:async()=>{refreshes++;return{status:'connected',charges_enabled:true,payouts_enabled:true,details_submitted:true,requirements:{currently_due:[]}};}});
 return{subject,pending,value,setOwner:(id:string)=>{ownerId=id;},refreshes:()=>refreshes,advance:(ms:number)=>{clock+=ms;},drain:async()=>{for(let i=0;i<12;i++)await Promise.resolve();}};
}
export function stripeReturnHarness(outcome:'success'|'refresh'|null='success',fail=false){
 const calls:Array<any>=[];
 const subject=create('src/app/apps/mobile/features/driver/dashboard/dashboard.page.ts','handleStripeReturn',{}, {route:{snapshot:{queryParamMap:{get:()=>outcome}}},driverService:{fetchStripeAccount:async(force?:boolean)=>{calls.push(['fetch',force]);if(fail)throw Error('offline');}},refreshStripeUiStateFromDb:async(force?:boolean)=>{calls.push(['ui',force]);},isStripeReady:()=>true,showToast:(...args:any[])=>calls.push(['toast',...args]),router:{navigate:async(_commands:any,options:any)=>calls.push(['navigate',options])}});
 return{subject,calls};
}
