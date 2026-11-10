import { supabaseAdmin } from './supabase.service';
import { EmailService } from './email.service';

export class AdminMessagingService {
  private static running=false;
  private static timer:ReturnType<typeof setInterval>|undefined;
  static async action(actor:string, action:string, thread:string|null=null, input:any={}) {
    const {data,error}=await supabaseAdmin.rpc('admin_message_conversation',{
      p_actor:actor,p_action:action,p_thread:thread,p_input:input
    });
    if(error) throw Object.assign(new Error(error.code==='P0001'?error.message:'Messages are temporarily unavailable. Please retry.'),{status:error.code==='P0001'?400:503});
    return data;
  }
  static start() {
    if(this.timer)return;
    this.timer=setInterval(()=>void this.tick(),60000);this.timer.unref();void this.tick();
  }
  static async tick() {
    if(this.running)return;this.running=true;
    try { for(let i=0;i<10;i++)if(!await this.deliver())break; }
    catch { console.warn('[AdminMessages] Email queue unavailable; delivery will retry.'); }
    finally {this.running=false;}
  }
  static async deliver():Promise<boolean> {
    const claim=await supabaseAdmin.rpc('claim_admin_message_email');
    if(claim.error)throw Error('Email claim unavailable');
    const r=claim.data;if(!r)return false;
    let sent=false,error='email_delivery_pending';
    try {
      // Recipient addresses come from Auth, never from browser input or profile edits.
      const auth=await supabaseAdmin.auth.admin.getUserById(r.userId);
      if(auth.error)throw Error('Recipient unavailable');
      const user=auth.data.user;
      if(!user?.email || !user.email_confirmed_at)throw Error('Verified recipient email unavailable');
      const base=String(process.env.MOBILE_APP_URL || process.env.APP_URL || '').replace(/\/$/,'');
      let link='Open the Vaydu app, then Messages from Vaydu, to reply.';
      try { const url=new URL(base);if(url.protocol==='https:')link=`Open and reply in Vaydu: ${url.origin}/account/messages?messageId=${encodeURIComponent(r.notificationId)}`; } catch { /* App instructions remain usable without a configured public URL. */ }
      sent=await EmailService.sendAdminMessageCopy(user.email,{
        id:String(r.notificationId || r.entryId),subject:String(r.subject),body:String(r.body),link
      });
    } catch { error='recipient_or_email_unavailable'; }
    const result=await supabaseAdmin.rpc('finish_admin_message_email',{
      p_entry:r.entryId,p_token:r.token,p_sent:sent,p_error:sent?null:error
    });
    if(result.error || result.data!==true)throw Error('Email delivery result unavailable');
    return true;
  }
}
