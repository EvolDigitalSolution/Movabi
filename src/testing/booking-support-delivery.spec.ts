import {describe,it,expect} from 'vitest';import fs from 'node:fs';import vm from 'node:vm';import ts from 'typescript';
function fixture(options:any={}){
 const updates:any[]=[],messages:any[]=[],mail:any[]=[],notifications:any[]=[];let claimed=false;
 const row={id:'ticket',job_id:'job',user_id:'customer',driver_id:'driver',tenant_id:'tenant',category:options.category || 'help',message:'Please help',email_sent_at:null,driver_message_saved:false,attempt_count:1,lease_token:'lease',country_code:'GB',...options.row};
 const db={rpc:async()=>{if(claimed || options.noClaim)return {data:[]};claimed=true;return {data:[row]};},from:(table:string)=>({insert:async(value:any)=>{messages.push(value);return {error:options.messageFailure?{code:'offline'}:options.duplicateMessage?{code:'23505'}:null};},update:(value:any)=>{updates.push(value);const c:any={eq:()=>c,then:(resolve:any)=>Promise.resolve({error:null}).then(resolve)};return c;}})};
 const c:any={exports:{},console,process:{env:{SUPPORT_ADMIN_EMAILS:'admin@example.com'}},Date,setInterval,require:(name:string)=>name.includes('supabase')?{supabaseAdmin:db}:name.includes('booking-history')?{}:name.includes('email.service')?{EmailService:{sendBookingSupportNotification:async(...args:any[])=>{mail.push(args);return !options.mailFailure;}}}:{NotificationService:{notifyChatMessage:async(...args:any[])=>notifications.push(args)}}};
 vm.runInNewContext(ts.transpileModule(fs.readFileSync('server/services/booking-support.service.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,c);
 return {service:c.exports.BookingSupportService,updates,messages,mail,notifications};
}
describe('durable support delivery',()=>{
 it('sends to the server configured admin and records delivery',async()=>{const t=fixture();await t.service.deliver('ticket');expect(t.mail[0][0]).toEqual(['admin@example.com']);expect(t.updates[0]).toMatchObject({email_status:'sent',last_error:null,lease_token:null});});
 it('keeps email failure queued instead of losing the request',async()=>{const t=fixture({mailFailure:true});await t.service.deliver('ticket');expect(t.updates[0]).toMatchObject({email_status:'pending',last_error:'email_delivery_pending'});});
 it('does not deliver when another worker owns the claim',async()=>{const t=fixture({noClaim:true});expect(await t.service.deliver('ticket')).toBe(false);expect(t.mail).toHaveLength(0);});
 it('saves a lost item message for the assigned driver and emails admin',async()=>{const t=fixture({category:'lost_item'});await t.service.deliver('ticket');expect(t.messages[0]).toMatchObject({id:'ticket',job_id:'job',sender_id:'customer',receiver_id:'driver'});expect(t.notifications).toHaveLength(1);expect(t.mail).toHaveLength(1);expect(t.updates[0].driver_message_saved).toBe(true);});
 it('does not duplicate a durable driver message on retry',async()=>{const t=fixture({category:'lost_item',duplicateMessage:true});await t.service.deliver('ticket');expect(t.notifications).toHaveLength(0);expect(t.updates[0].driver_message_saved).toBe(true);});
 it('retries the driver copy without emailing admin twice',async()=>{const t=fixture({category:'lost_item',messageFailure:true,row:{email_sent_at:new Date().toISOString()}});await t.service.deliver('ticket');expect(t.mail).toHaveLength(0);expect(t.updates[0]).toMatchObject({email_status:'pending',last_error:'driver_message_pending'});});
});
function ratingRoute(user:string|null){
 const routes:any={},writes:any[]=[];
 const db={auth:{getUser:async()=>({data:{user:user?{id:user}:null},error:null})},from:(table:string)=>{const c:any={select(){return c;},eq(){return c;},maybeSingle:async()=>({data:table==='jobs'?{id:'job',customer_id:'customer',driver_id:'driver',status:'completed'}:null}),single:async()=>({data:table==='jobs'?{id:'job',customer_id:'customer',driver_id:'driver',status:'completed'}:{id:'rating'}}),insert(v:any){writes.push(v);return c;},update(v:any){writes.push(v);return c;},then(resolve:any){return Promise.resolve({data:[]}).then(resolve);}};return c;}};
 const router:any={get(){},post:(path:string,...handlers:any[])=>{routes[path]=handlers.at(-1);},patch(){},delete(){},use(){}};
 const c:any={exports:{},console,process:{env:{}},require:(name:string)=>name==='express'?{Router:()=>router}:name==='express-rate-limit'?{rateLimit:()=>()=>{}}:name.includes('supabase')?{supabaseAdmin:db}:{}};
 vm.runInNewContext(ts.transpileModule(fs.readFileSync('server/routes/booking.routes.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,c);
 return {async call(body:any){const res:any={statusCode:200,status(n:number){this.statusCode=n;return this;},json(data:any){this.body=data;return this;}};await routes['/rate']({headers:{authorization:user?'Bearer token':''},body},res);return res;},writes};
}
describe('rating identity boundary',()=>{
 it('requires a session even when the caller supplies the real customer ID',async()=>{const t=ratingRoute(null);expect((await t.call({jobId:'job',customerId:'customer',score:5})).statusCode).toBe(401);expect(t.writes).toHaveLength(0);});
 it('does not allow another account to impersonate the customer',async()=>{const t=ratingRoute('other');expect((await t.call({jobId:'job',customerId:'customer',score:5})).statusCode).toBe(403);expect(t.writes).toHaveLength(0);});
 it('uses the authenticated customer rather than a forged body ID',async()=>{const t=ratingRoute('customer');expect((await t.call({jobId:'job',customerId:'other',score:5})).statusCode).toBe(200);expect(t.writes[0].customer_id).toBe('customer');});
 it('rejects invalid ratings before writing',async()=>{const t=ratingRoute('customer');expect((await t.call({jobId:'job',score:6})).statusCode).toBe(400);expect(t.writes).toHaveLength(0);});
});
