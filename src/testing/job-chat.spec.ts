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
  if(name==='express')return {Router:()=>({get:()=>{},post:(_:string,h:any)=>{handler=h;}})};
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
async function readChat(options:any={}) {
 const handlers:Record<string,any>={},filters:any[]=[];
 const db:any={auth:{getUser:async()=>({data:{user:{id:options.user || 'customer'}},error:null})},from:()=>{
  const chain:any={select:()=>chain,eq:(...a:any[])=>{filters.push(a);return chain;},is:(...a:any[])=>{filters.push(a);return chain;},lte:(...a:any[])=>{filters.push(a);return chain;},order:()=>chain,limit:()=>chain,update:()=>chain,
    maybeSingle:async()=>({data:{customer_id:'customer',driver_id:options.acceptedOnly?null:'driver',accepted_driver_id:'driver'},error:options.lookupError || null}),
    then:(resolve:any)=>Promise.resolve({data:[{id:'last',created_at:'2026-01-02'},{id:'first',created_at:'2026-01-01'}],count:2,error:null}).then(resolve)};
  return chain;
 }};
 const context:any={exports:{},console,Date,require:(name:string)=>{
  if(name==='express')return {Router:()=>({get:(path:string,h:any)=>{handlers['GET '+path]=h;},post:(path:string,h:any)=>{handlers['POST '+path]=h;}})};
  if(name.includes('supabase.service'))return {supabaseAdmin:db};return {};
 }};
 vm.runInNewContext(ts.transpileModule(fs.readFileSync('server/routes/communication.routes.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,context);
 const result:any={status:200};const res:any={status:(s:number)=>{result.status=s;return res;},json:(body:any)=>{result.body=body;return res;}};
 await handlers[options.route || 'GET /messages/:jobId']({headers:options.noToken?{}:{authorization:'Bearer fixture'},params:{jobId:options.badId?'bad':'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'},body:{through:options.through || '2026-01-01T00:00:00Z'}},res);
 return {result,filters};
}
describe('authenticated chat reads and acknowledgements',()=>{
 it('requires a session for history',async()=>expect((await readChat({noToken:true})).result.status).toBe(401));
 it('rejects unrelated readers',async()=>expect((await readChat({user:'stranger'})).result.status).toBe(403));
 it('rejects invalid booking IDs before querying',async()=>expect((await readChat({badId:true})).result.status).toBe(400));
 it('allows the accepted driver to read history',async()=>expect((await readChat({user:'driver',acceptedOnly:true})).result.status).toBe(200));
 it('orders the bounded history chronologically',async()=>expect((await readChat()).result.body.map((m:any)=>m.id)).toEqual(['first','last']));
 it('reports lookup failure as unavailable rather than a missing booking',async()=>expect((await readChat({lookupError:{}})).result.status).toBe(503));
 it('counts only unread messages received by the caller',async()=>{const t=await readChat({route:'GET /messages/:jobId/counts'});expect(t.filters).toContainEqual(['receiver_id','customer']);expect(t.filters).toContainEqual(['read_at',null]);});
 it('rejects a read acknowledgement for future messages',async()=>expect((await readChat({route:'POST /messages/:jobId/read',through:new Date(Date.now()+3600000).toISOString()})).result.status).toBe(400));
 it('acknowledges only received messages through the displayed timestamp',async()=>{const t=await readChat({route:'POST /messages/:jobId/read'});expect(t.filters).toContainEqual(['receiver_id','customer']);expect(t.filters).toContainEqual(['created_at','2026-01-01T00:00:00Z']);});
});
