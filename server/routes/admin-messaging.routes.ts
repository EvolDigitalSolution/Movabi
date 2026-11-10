import { Router, Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { supabaseAdmin } from '../services/supabase.service';
import { AdminMessagingService } from '../services/admin-messaging.service';
import { NotificationService } from '../services/notification.service';
const router=Router();
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
router.use(rateLimit({windowMs:60000,max:90,message:{error:'Please wait before refreshing messages.'}}));
router.use(async(req:Request,res:Response,next:NextFunction)=>{
  try {
    const token=String(req.headers.authorization || '').replace(/^Bearer\s+/i,'').trim();
    const auth=token?await supabaseAdmin.auth.getUser(token):null;
    if(auth?.error || !auth?.data.user?.id)return res.status(401).json({error:'Authentication required.'});
    (req as any).messageUserId=auth.data.user.id;return next();
  } catch {return res.status(503).json({error:'Messages are temporarily unavailable.'});}
});
async function call(req:Request,res:Response,action:string) {
  try {
    const thread=req.params.threadId?String(req.params.threadId):null;
    if(thread&&!uuid.test(thread))return res.status(400).json({error:'Valid conversation required.'});
    const input:any=action==='send'?{message:String(req.body?.message || '').trim(),requestId:String(req.body?.requestId || '')}
      :action==='read'?{ids:req.body?.ids}:action==='thread'?{before:req.query.before || null}:{};
    if(action==='send'&&(!uuid.test(input.requestId)||input.message.length<1||input.message.length>2000))return res.status(400).json({error:'Enter a message of 1–2000 characters.'});
    const result=await AdminMessagingService.action((req as any).messageUserId,action,thread,input);
    if(action==='send'&&result?.notificationId) {
      // Persistence and email queue are already committed; a push failure cannot lose the reply.
      void NotificationService.pushSavedAdminMessage(result.userId,result.notificationId,result.role || 'customer')
        .catch(()=>console.warn('[AdminMessages] Push delivery unavailable.'));
    }
    return res.status(action==='send'?201:200).json(result);
  } catch(error:any) {return res.status(error?.status || 503).json({error:error?.message || 'Messages are temporarily unavailable.'});}
}
router.get('/',(req,res)=>void call(req,res,'list'));
router.get('/:threadId',(req,res)=>void call(req,res,'thread'));
router.post('/:threadId/replies',rateLimit({windowMs:60000,max:12,message:{error:'Please wait before sending another reply.'}}),(req,res)=>void call(req,res,'send'));
router.post('/:threadId/read',(req,res)=>void call(req,res,'read'));
export default router;
