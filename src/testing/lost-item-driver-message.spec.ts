import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
async function send(options:any={}) {
 const handlers:any={},inserts:any[]=[],notifications:any[]=[];
 const job={id:'job',customer_id:'customer',driver_id:'driver',status:'completed',...options.job};
 const db:any={auth:{getUser:async()=>({data:{user:options.unauthenticated?null:{id:options.sender || 'customer'}}})},schema(){return this;},from(table:string){
  const chain:any={select(){return this;},eq(){return this;},maybeSingle:async()=>({data:job}),insert(value:any){inserts.push(value);return this;},single:async()=>({data:{id:'message',...inserts[0]}})};return chain;
 }};
 const router={get(){},post(path:string,handler:any){handlers[path]=handler;}};
 vm.runInNewContext(ts.transpileModule(fs.readFileSync('server/routes/communication.routes.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,
  {exports:{},console,require:(name:string)=>name==='express'?{Router:()=>router}:name.includes('supabase')?{supabaseAdmin:db}:{NotificationService:{notifyChatMessage:async(...args:any[])=>{notifications.push(args);if(options.pushFailure)throw Error('offline');}}}});
 const res:any={code:200,status(value:number){this.code=value;return this;},json(body:any){this.body=body;return this;}};
 await handlers['/messages']({headers:{authorization:options.noToken?'':'Bearer token'},body:{jobId:'job',receiverId:options.receiver || 'driver',message:'Blue bag left in the car',messageType:'text',purpose:'lost_item',...options.body}},res);
 return {res,inserts,notifications};
}
describe('lost item report to assigned driver',()=>{
 it('persists a completed customer report and notifies its driver',async()=>{const t=await send();expect(t.res.code).toBe(200);expect(t.inserts[0]).toMatchObject({sender_id:'customer',receiver_id:'driver',message_type:'text',message:'Lost item report: Blue bag left in the car'});expect(t.notifications[0][0]).toBe('driver');});
 it('preserves success when push delivery fails after persistence',async()=>{const t=await send({pushFailure:true});expect(t.res.code).toBe(200);expect(t.inserts).toHaveLength(1);});
 it('keeps ordinary completed-job chat read-only',async()=>{const t=await send({body:{purpose:undefined}});expect(t.res.code).toBe(409);expect(t.inserts).toHaveLength(0);});
 it.each(['cancelled','expired','failed','in_progress'])('rejects reports for %s jobs',async(status)=>{const t=await send({job:{status}});expect(t.res.code).toBe(403);expect(t.inserts).toHaveLength(0);});
 it('rejects an unrelated recipient',async()=>{expect((await send({receiver:'stranger'})).res.code).toBe(403);});
 it('rejects an unrelated sender',async()=>{expect((await send({sender:'stranger'})).res.code).toBe(403);});
 it('requires authentication',async()=>{expect((await send({noToken:true})).res.code).toBe(401);});
 it('rejects oversized descriptions',async()=>{expect((await send({body:{message:'x'.repeat(2001)}})).res.code).toBe(400);});
});
