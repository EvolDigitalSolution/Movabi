import { Router, Request, Response } from 'express';
import { supabaseAdmin } from '../services/supabase.service';
import { NotificationService } from '../services/notification.service';

const router = Router();

router.post('/messages', async (req: Request, res: Response) => {
  try {
    const { jobId, receiverId, message, messageType } = req.body || {};
    const cleanMessage = String(message || '').trim();
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();

    if (!token) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { data: authData, error: authError } = await supabaseAdmin.auth.getUser(token);
    const senderId = authData?.user?.id;

    if (authError || !senderId) {
      return res.status(401).json({ error: 'Invalid session' });
    }

    if (!jobId || !receiverId || !cleanMessage || cleanMessage.length > 2000) {
      return res.status(400).json({ error: 'jobId, receiverId and message are required' });
    }

    const { data: job, error: jobError } = await supabaseAdmin
      .schema('public')
      .from('jobs')
      .select('id, tenant_id, customer_id, driver_id, accepted_driver_id, status')
      .eq('id', jobId)
      .maybeSingle();

    if (jobError || !job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const assignedDriverId = job.driver_id || job.accepted_driver_id;
    const participants = [job.customer_id, assignedDriverId].filter(Boolean);
    const expectedReceiver = senderId === job.customer_id ? assignedDriverId : job.customer_id;
    if (!assignedDriverId || receiverId !== expectedReceiver || receiverId === senderId) {
      return res.status(403).json({ error: 'Messages must be sent to the other participant on this job' });
    }
    if (['completed', 'settled', 'delivered', 'cancelled', 'canceled', 'expired', 'failed', 'no_driver_found'].includes(String(job.status))) {
      return res.status(409).json({ error: 'This job has ended; its chat history is read-only' });
    }
    if (messageType && !['text', 'quick'].includes(messageType)) {
      return res.status(400).json({ error: 'Unsupported message type' });
    }

    if (!participants.includes(senderId) || !participants.includes(receiverId)) {
      return res.status(403).json({ error: 'You can only message participants on this job' });
    }

    const { data, error } = await supabaseAdmin
      .schema('public')
      .from('job_messages')
      .insert({
        tenant_id: job.tenant_id || null,
        job_id: jobId,
        sender_id: senderId,
        receiver_id: receiverId,
        message: cleanMessage,
        message_type: messageType || 'text'
      })
      .select('*')
      .single();

    if (error) {
      console.error('[CommunicationRoutes] message insert failed:', error);
      return res.status(400).json({
        error: error.message,
        code: error.code,
        details: error.details,
        hint: error.hint
      });
    }

    try {
      await NotificationService.notifyChatMessage(receiverId, jobId, senderId, cleanMessage);
    } catch (notificationError: any) {
      // The message is already durable. Push failure must not invite duplicate retries.
      console.warn('[CommunicationRoutes] chat push unavailable:', notificationError?.code || 'notification_failed');
    }

    return res.json({ success: true, message: data });
  } catch (error: any) {
    console.error('[CommunicationRoutes] send message failed:', error);
    return res.status(500).json({ error: error.message || 'Failed to send message' });
  }
});

export default router;
