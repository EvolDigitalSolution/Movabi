import { supabaseAdmin } from './supabase.service';
import { BookingHistoryService } from './booking-history.service';
import { EmailService } from './email.service';
import { NotificationService } from './notification.service';
export const supportCategories = new Set(['help','issue','payment','safety','lost_item']);
export function validateSupportInput(input: any) {
  const jobId=String(input?.jobId || ''); const requestId=String(input?.requestId || '');
  const category=String(input?.category || 'help'); const message=String(input?.message || '').trim();
  const maxLength=category==='lost_item'?1500:2000;
  const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if(!uuid.test(jobId)||!uuid.test(requestId)||!supportCategories.has(category)||message.length<3||message.length>maxLength)
    throw Object.assign(new Error('A booking, request reference and message of 3–2000 characters are required'),{status:400});
  return {jobId,requestId,category,message};
}
export function resolveSupportRecipients(tenant: string | null,country: string | null,city: string | null): string[] {
  let map: Record<string,string>={};
  try { map=JSON.parse(process.env.SUPPORT_MARKET_EMAILS || '{}'); } catch { /* Invalid configuration leaves mail queued. */ }
  const c=String(country || '').toUpperCase(), town=String(city || '').trim().toLowerCase();
  let onboardingMap:Record<string,string>={};
  try{onboardingMap=JSON.parse(process.env.DRIVER_ONBOARDING_MARKET_EMAILS || '{}');}catch{}
  const raw=map[`${tenant || ''}:${c}:${town}`] || map[`${tenant || ''}:${c}`] || map[String(tenant || '')]
    || process.env[`SUPPORT_ADMIN_EMAILS_${c}`] || process.env.SUPPORT_ADMIN_EMAILS
    || onboardingMap[`${c}:${town}`] || process.env[`DRIVER_ONBOARDING_ADMIN_EMAILS_${c}`] || process.env.DRIVER_ONBOARDING_ADMIN_EMAILS || '';
  return [...new Set(String(raw).split(',').map(s=>s.trim().toLowerCase()).filter(s=>/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(s)))];
}
export class BookingSupportService {
  private static running=false;
  static start() { const timer=setInterval(()=>void this.tick(),60000);timer.unref();void this.tick(); }
  static async submit(userId: string,email: string | undefined,input: any) {
    const v=validateSupportInput(input);
    const j=await BookingHistoryService.participantJob(v.jobId,userId);
    if(v.category==='lost_item' && (j.customer_id!==userId || !(j.driver_id || j.accepted_driver_id) || !['completed','settled'].includes(j.status)))
      throw Object.assign(new Error('Lost item reports require your completed booking and an assigned driver'),{status:409});
    const {data,error}=await supabaseAdmin.rpc('create_booking_support_request',{
      p_user_id:userId,p_job_id:j.id,p_request_id:v.requestId,p_category:v.category,p_message:v.message,
      p_email:email || null,p_tenant_id:j.tenant_id || null,p_country:j.country_code || null,
      p_city:j.market_city || j.metadata?.city || null,p_driver_id:j.driver_id || j.accepted_driver_id || null
    });
    if(error)throw Object.assign(new Error(error.code==='P0001'?error.message:'Your request could not be saved. Please retry.'),{status:error.message?.includes('Too many')?429:error.message?.includes('reference reused')?409:503});
    const row=Array.isArray(data)?data[0]:data;
    if(!row?.id)throw new Error('Support request was not saved');
    // A saved reference is returned even if SMTP is unavailable. Worker retries.
    void this.deliver(row.id).catch(()=>console.warn('[BookingSupport] queued delivery deferred'));
    return {id:row.id,status:row.status,deliveryStatus:row.email_status};
  }
  static async tick() {
    if(this.running)return;this.running=true;
    try { for(let i=0;i<5;i++)if(!await this.deliver())break; }
    catch { console.warn('[BookingSupport] delivery worker unavailable'); }
    finally { this.running=false; }
  }
  static async deliver(id?: string): Promise<boolean> {
    const claimed=await supabaseAdmin.rpc('claim_booking_support_email',{p_id:id || null});
    if(claimed.error)throw new Error('Support delivery claim unavailable');
    const r=claimed.data?.[0];if(!r)return false;
    let driverMessageSaved=!!r.driver_message_saved;
    if(r.category==='lost_item' && !driverMessageSaved) {
      const msg=await supabaseAdmin.from('job_messages').insert({id:r.id,tenant_id:r.tenant_id,job_id:r.job_id,sender_id:r.user_id,receiver_id:r.driver_id,message:`Lost item report (${r.id}): ${r.message}`,message_type:'text'});
      if(!msg.error || msg.error.code==='23505') {
        driverMessageSaved=true;
        if(!msg.error)try{await NotificationService.notifyChatMessage(r.driver_id,r.job_id,r.user_id,`Lost item report: ${r.message}`);}catch{ /* Durable message is still available in the app. */ }
      }
    }
    const recipients=resolveSupportRecipients(r.tenant_id,r.country_code,r.market_city);
    const sent=!!r.email_sent_at || await EmailService.sendBookingSupportNotification(recipients,{
      id:r.id,replyTo:r.sender_email,subject:`Movabi ${r.category.replace('_',' ')} — ${r.id}`,
      text:[`Reference: ${r.id}`,`Booking: ${r.job_id}`,`Account: ${r.user_id}`,`Market: ${r.country_code || ''} ${r.market_city || ''}`,`Category: ${r.category}`,'',r.message].join('\n')
    });
    const complete=sent && (r.category!=='lost_item' || driverMessageSaved);
    const result=await supabaseAdmin.from('booking_support_requests').update({
      email_status:complete?'sent':'pending',email_sent_at:sent?new Date().toISOString():r.email_sent_at,
      driver_message_saved:driverMessageSaved,lease_token:null,lease_until:null,
      retry_at:new Date(Date.now()+Math.min(3600000,60000*2**Math.min(Number(r.attempt_count),6))).toISOString(),
      last_error:complete?null:!recipients.length?'support_recipients_not_configured':!sent?'email_delivery_pending':'driver_message_pending'
    }).eq('id',r.id).eq('lease_token',r.lease_token);
    if(result.error)throw new Error('Support delivery result could not be saved');
    return true;
  }
}
