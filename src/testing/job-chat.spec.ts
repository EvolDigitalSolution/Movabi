import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
import * as ts from 'typescript';
async function send(options: any = {}) {
 const job={id:'job',customer_id:'customer',driver_id:'driver',accepted_driver_id:'driver',tenant_id:'tenant',status:'en_route_to_customer',...options.job};
 const saved: any[]=[];let handler: any;
 const db = {
   auth: { getUser: async () => ({ data: { user: { id: options.sender || 'customer' } }, error: null }) },
   schema: () => ({
     from: (table: string) => {
       if (table === 'jobs') {
         return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: job, error: null }) }) }) };
       }
       return {
         insert: (message: any) => {
           saved.push(message);
           return { select: () => ({ single: async () => ({ data: { id: 'message', ...message }, error: null }) }) };
         }
       };
     }
   })
 };

 const context: any={exports:{},console,require:(name:string)=>{
  if(name==='express')return {Router:()=>({post:(_:string,h:any)=>{handler=h;}})};
  if(name.includes('supabase.service'))return {supabaseAdmin:db};
  if(name.includes('notification.service'))return {NotificationService:{notifyChatMessage:async()=>{if(options.pushFailure)throw Error('Push unavailable');}}};
  throw Error('Unexpected dependency '+name);
 }};
 const source=fs.readFileSync('server/routes/communication.routes.ts','utf8');
 const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 vm.runInNewContext(code,context);const result:any={status:200};
 const res={status:(status:number)=>{result.status=status;return res;},json:(body:any)=>{result.body=body;return res;}};
 await handler({headers:options.noToken?{}:{authorization:'Bearer fixture'},body:{jobId:'job',receiverId:options.receiver||'driver',message:'Hello',messageType:options.type||'text'}},res);
 return {result,saved};
}
describe('job chat send',()=>{
 it('requires authentication',async()=>{const r=await send({noToken:true});expect(r.result.status).toBe(401);expect(r.saved.length).toBe(0);});
 it('allows customer to send to assigned driver',async()=>{const r=await send();expect(r.result.status).toBe(200);expect(r.saved[0].sender_id).toBe('customer');});
 it('allows driver to send to customer',async()=>{const r=await send({sender:'driver',receiver:'customer'});expect(r.result.status).toBe(200);expect(r.saved[0].receiver_id).toBe('customer');});
 it('denies unrelated senders',async()=>{const r=await send({sender:'stranger',receiver:'customer'});expect(r.result.status).toBe(403);expect(r.saved.length).toBe(0);});
 it('denies an unrelated receiver',async()=>{const r=await send({receiver:'stranger'});expect(r.result.status).toBe(403);expect(r.saved.length).toBe(0);});
 it('denies self messages',async()=>{const r=await send({receiver:'customer'});expect(r.result.status).toBe(403);});
 it('keeps terminal chat history read-only',async()=>{const r=await send({job:{status:'completed'}});expect(r.result.status).toBe(409);expect(r.saved.length).toBe(0);});
 it('does not allow clients to forge system messages',async()=>{const r=await send({type:'system'});expect(r.result.status).toBe(400);expect(r.saved.length).toBe(0);});
 it('returns saved message success when push fails',async()=>{const r=await send({pushFailure:true});expect(r.result.status).toBe(200);expect(r.saved.length).toBe(1);});
});
