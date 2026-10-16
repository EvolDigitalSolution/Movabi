import { supabaseAdmin } from './supabase.service';
export type InboxKind = 'messages' | 'updates';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ended=new Set(['completed','settled','cancelled','canceled','failed','expired','no_driver_found','refunded']);
function fail(message:string,status=400):never{throw Object.assign(new Error(message),{status});}
export function inboxKind(value:unknown):InboxKind {if(value!=='messages' && value!=='updates')fail('Invalid inbox category');return value;}
export function inboxCursor(value:unknown):{id:string;created_at:string}|null {
 if(!value)return null;
 try{const row=JSON.parse(String(value));if(!uuid.test(row.id)||typeof row.created_at!=='string'||!/^\d{4}-\d{2}-\d{2}T[\d:.+Z-]+$/.test(row.created_at)||!Number.isFinite(Date.parse(row.created_at)))fail('Invalid inbox cursor');return {id:row.id,created_at:row.created_at};}catch{ return fail('Invalid inbox cursor'); }
}
export function inboxJobRoute(id:string,status:string,chat:boolean):string {
 if(!uuid.test(id))return fail('Invalid booking reference');
 return ended.has(status)?`/driver/history/${id}`:`/driver/job-details/${id}${chat?'?chat=1':''}`;
}
export class DriverInboxService {
 private static owned(user:string,kind:InboxKind,selection:string,options?:any):any {
  const query=supabaseAdmin.from(kind==='messages'?'job_messages':'notifications').select(selection,options).eq(kind==='messages'?'receiver_id':'user_id',user);
  return kind==='updates'?query.neq('type','chat_message'):query;
 }
 static async counts(user:string){
  const [messages,updates]=await Promise.all([
   this.owned(user,'messages','id',{count:'exact',head:true}).is('read_at',null),
   this.owned(user,'updates','id',{count:'exact',head:true}).eq('is_read',false)
  ]);
  if(messages.error||updates.error)throw Error('Unread counts unavailable');
  return {messages:messages.count||0,updates:updates.count||0};
 }
 static async page(user:string,kind:InboxKind,cursor:{id:string;created_at:string}|null){
  const selection=kind==='messages'?'id,job_id,message,read_at,created_at':'id,title,body,is_read,created_at';
  let query=this.owned(user,kind,selection).order('created_at',{ascending:false}).order('id',{ascending:false}).limit(11);
  if(cursor)query=query.or(`created_at.lt.${cursor.created_at},and(created_at.eq.${cursor.created_at},id.lt.${cursor.id})`);
  const result=await query;if(result.error)throw Error('Inbox unavailable');if(!Array.isArray(result.data))throw Error('Invalid inbox response');
  const page=result.data.slice(0,10);
  return {items:page.map((row:any)=>({id:row.id,created_at:row.created_at,title:kind==='messages'?(String(row.message).startsWith('Lost item')?'Lost-item report':'Customer message'):row.title,body:kind==='messages'?row.message:row.body,unread:kind==='messages'?!row.read_at:!row.is_read})),cursor:result.data.length>10?{id:page[page.length-1].id,created_at:page[page.length-1].created_at}:null};
 }
 static async read(user:string,kind:InboxKind,id:string){
  if(!uuid.test(id))fail('Invalid inbox reference');
  const result=await supabaseAdmin.from(kind==='messages'?'job_messages':'notifications')
   .update(kind==='messages'?{read_at:new Date().toISOString()}:{is_read:true})
   .eq('id',id).eq(kind==='messages'?'receiver_id':'user_id',user).select('id').maybeSingle();
  if(result.error)throw Error('Could not mark item read');if(!result.data)fail('Inbox item unavailable',404);
  return {success:true};
 }
 static async target(user:string,kind:InboxKind,id:string):Promise<{route:string|null;label:string}> {
  if(!uuid.test(id))fail('Invalid inbox reference');
  const result=await this.owned(user,kind,kind==='messages'?'job_id':'metadata,data').eq('id',id).maybeSingle();
  if(result.error)throw Error('Inbox item unavailable');if(!result.data)fail('Inbox item unavailable',404);
  const row=result.data,meta={...(row.data||{}),...(row.metadata||{})};
  if(kind==='updates' && ['admin_message','admin_driver_message'].includes(meta.action))return {route:`/account/messages?messageId=${id}`,label:'Open message from Movabi'};
  const jobId=kind==='messages'?row.job_id:(meta.job_id||meta.jobId);
  if(!uuid.test(String(jobId||'')))return {route:null,label:''};
  if(kind==='updates' && ['new_job','negotiation','negotiation_counter'].includes(meta.action))return {route:'/driver',label:'View requests'};
  const job=await supabaseAdmin.from('jobs').select('driver_id,accepted_driver_id,status').eq('id',jobId).maybeSingle();
  if(job.error)throw Error('Booking unavailable');
  if(!job.data || (job.data.driver_id||job.data.accepted_driver_id)!==user)return {route:null,label:'This booking is no longer assigned to you.'};
  return {route:inboxJobRoute(jobId,job.data.status,kind==='messages'||meta.action==='open_chat'),label:ended.has(job.data.status)?'View booking and saved messages':kind==='messages'?'Open conversation':'View active booking'};
 }
}
