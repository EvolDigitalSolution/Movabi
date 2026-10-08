import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transpileModule, ScriptTarget } from 'typescript';
import { adminMessageRoute } from '../app/shared/utils/admin-message-route';
const id='11111111-2222-3333-4444-555555555555';
const js=(source:string)=>transpileModule(source,{compilerOptions:{target:ScriptTarget.ES2022}}).outputText;
const source=readFileSync('src/app/core/services/notification/onesignal.service.ts','utf8');
const click=source.slice(source.indexOf('    private handleNotificationClick('),source.indexOf('    private isDriverOpportunity('));
function clicked(data:any){const routes:string[]=[];const context:any={adminMessageRoute,console:{error(){}},router:{navigateByUrl:(route:string)=>routes.push(route)}};
runInNewContext(js(`class Handler {router:any;constructor(){this.router=router;} ${click}}; new Handler().handleNotificationClick({notification:{additionalData:data}});`),{...context,data});return routes;}
describe('admin message destinations',()=>{
 it.each(['driver','customer'])('opens the exact message for %s',role=>{expect(clicked({action:'admin_message',role,message_id:id})[0]).toBe(`/account/messages?messageId=${id}`);});
 it('routes old message notifications to the inbox',()=>{expect(clicked({action:'admin_driver_message'})[0]).toBe('/account/messages');});
 it('keeps driver opportunity routing intact',()=>{expect(clicked({action:'new_job',role:'driver',job_id:'job'})[0]).toBe('/driver');});
 it('keeps customer booking chat routing intact',()=>{expect(clicked({role:'customer',open:'booking_chat',job_id:'job'})[0]).toBe('/customer/tracking/job?tab=chat');});
 it.each(['https://untrusted.example','../driver','bad&id=other',''])('rejects invalid message identifiers',value=>{expect(adminMessageRoute(value)).toBe(null);});
});
const backend=readFileSync('server/routes/admin.routes.ts','utf8');
const customerRoute=backend.slice(backend.indexOf("router.post('/users/:userId/message'"),backend.indexOf("router.get('/heatmap'"));
async function send(options:{failed?:boolean;role?:string;message?:string}={}){
 let callback:any;const writes:any[]=[];const pushes:any[]=[];
 const supabaseAdmin={from(table:string){const q:any={eq:()=>q,select:()=>q,insert(value:any){writes.push({table,value});return q;},async single(){return table==='profiles'?{data:{id,role:options.role||'customer'}}:options.failed?{error:new Error('failed')}:{data:{id}};}};return q;}};
 runInNewContext(js(customerRoute),{supabaseAdmin,requireAdmin:()=>undefined,NotificationService:{pushSavedAdminMessage:async(...args:any[])=>{pushes.push(args);}},router:{post(_path:string,_guard:any,handler:any){callback=handler;}},console:{error(){},warn(){}}});
 const res:any={code:200,status(code:number){this.code=code;return this;},json(value:any){this.body=value;return this;}};
 await callback({params:{userId:id},body:{message:options.message??'Your support request is being reviewed.'}},res);return{res,writes,pushes};
}
describe('customer messages',()=>{
 it('saves the inbox record then attempts push without changing account state',async()=>{const{res,writes,pushes}=await send();expect(res.code).toBe(201);expect(writes).toHaveLength(1);expect(writes[0].table).toBe('notifications');expect(pushes).toHaveLength(1);expect(pushes[0][1]).toBe(id);});
 it('does not push when persistence fails',async()=>{const{res,pushes}=await send({failed:true});expect(res.code).toBe(500);expect(pushes).toHaveLength(0);});
 it.each(['admin','driver'])('rejects the wrong recipient role %s',async role=>{const{res,writes}=await send({role});expect(res.code).toBe(404);expect(writes).toHaveLength(0);});
 it('requires a nonblank message',async()=>{const{res,writes}=await send({message:' '});expect(res.code).toBe(422);expect(writes).toHaveLength(0);});
});
