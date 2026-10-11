import { IssuingCapacityService } from '../services/issuing-capacity.service';
import { ShoppingBudgetService } from '../services/shopping-budget.service';
import { Router, Request, Response } from 'express';
import { IssuingService } from '../services/issuing.service';
import { supabaseAdmin } from '../services/supabase.service';

const router = Router();

const getBearerToken = (req: Request): string | null => {
  const raw = req.headers.authorization || '';
  const [scheme, token] = raw.split(' ');
  return scheme?.toLowerCase() === 'bearer' && token ? token : null;
};

const requireUser = async (req: Request) => {
  const token = getBearerToken(req);

  if (!token) {
    throw new Error('Authentication required');
  }

  const { data, error } = await supabaseAdmin.auth.getUser(token);

  if (error || !data.user) {
    throw new Error('Invalid session');
  }

  return data.user;
};

const assertJobParticipant = async (jobId: string, userId: string) => {
  const { data: job, error } = await supabaseAdmin
    .from('jobs')
    .select('id, customer_id, driver_id')
    .eq('id', jobId)
    .maybeSingle();

  if (error || !job) {
    throw new Error('Request not found');
  }

  if (job.customer_id !== userId && job.driver_id !== userId) {
    throw new Error('You do not have access to this request');
  }
};

const getProfileTenant = async (userId: string): Promise<string | null> => {
  const { data } = await supabaseAdmin
    .from('profiles')
    .select('tenant_id')
    .eq('id', userId)
    .maybeSingle();

  return (data as any)?.tenant_id || null;
};

router.get('/shopping-capacity', async (req: Request, res: Response) => {
  try { await requireUser(req); }
  catch { return res.status(401).json({ error: 'Authentication required' }); }
  const currency = String(req.query.currency || '').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) return res.status(400).json({ error: 'Invalid currency' });
  res.set('Cache-Control', 'no-store');
  try {
    const maximumBudget = await IssuingCapacityService.maximumAvailable(currency);
    return res.json({ currency, maximumBudget });
  } catch {
    return res.status(503).json({ error: 'Shopping funding could not be verified. Please try again later.' });
  }
});

router.post('/budget/:jobId/prepare', async (req: Request,res: Response) => {
  try { const user=await requireUser(req); const result=await ShoppingBudgetService.prepare(String(req.params.jobId),user.id); if(result.approved) await IssuingService.activateErrandCard(String(req.params.jobId)).catch(error => console.error('[ShoppingBudget] card activation pending',error.message)); return res.json(result); }
  catch(error: unknown) { return res.status(400).json({error:error instanceof Error ? error.message : 'Budget approval failed'}); }
});
router.post('/budget/:jobId/approve', async (req: Request,res: Response) => {
  try { const user=await requireUser(req); await ShoppingBudgetService.approve(String(req.params.jobId),user.id,String(req.body?.requestId || ''));
    const card=await IssuingService.activateErrandCard(String(req.params.jobId)).catch(error => {console.error('[ShoppingBudget] card activation pending',error.message);return null;}); return res.json({approved:true,card,cardReady:!!card}); }
  catch(error: unknown) { return res.status(400).json({error:error instanceof Error ? error.message : 'Budget approval failed'}); }
});

router.post('/driver-card/ensure', async (req: Request, res: Response) => {
  try {
    const user = await requireUser(req);
    const tenantId = await getProfileTenant(user.id);
    const status = await IssuingService.ensureDriverVirtualCard(user.id, tenantId);

    return res.json(status);
  } catch (error: any) {
    console.error('[IssuingRoutes] driver-card ensure failed:', {
      message: error?.message,
      type: error?.type,
      code: error?.code,
      statusCode: error?.statusCode,
      detail: error?.details || error?.detail
    });

    const status = /auth|session/i.test(error.message) ? 401 : 400;
    return res.status(status).json({ error: error.message || 'Failed to prepare Movabi Pay virtual card' });
  }
});

router.post('/card-details/ephemeral-key', async (req: Request, res: Response) => {
  try {
    const user = await requireUser(req);
    const cardId = String(req.body?.cardId || '').trim();
    const nonce = String(req.body?.nonce || '').trim();

    if (!cardId || !nonce) {
      return res.status(400).json({ error: 'cardId and nonce required' });
    }

    const result = await IssuingService.createCardDetailsEphemeralKey(user.id, cardId, nonce);
    return res.json(result);
  } catch (error: any) {
    const status = /auth|session/i.test(error.message) ? 401 : 400;
    return res.status(status).json({ error: error.message || 'Failed to create secure card details session' });
  }
});

router.get('/errand-card/:jobId/status', async (req: Request, res: Response) => {
  try {
    const user = await requireUser(req);
    const jobId = String(req.params.jobId || '').trim();

    if (!jobId) {
      return res.status(400).json({ error: 'jobId required' });
    }

    await assertJobParticipant(jobId, user.id);

    const status = await IssuingService.getErrandCardStatus(jobId);
    return res.json(status);
  } catch (error: any) {
    const status = /auth|session/i.test(error.message) ? 401 : 400;
    return res.status(status).json({ error: error.message || 'Failed to load Movabi Pay card status' });
  }
});

router.post('/errand-card/activate', async (req: Request, res: Response) => {
  try {
    const user = await requireUser(req);
    const jobId = String(req.body?.jobId || '').trim();

    if (!jobId) {
      return res.status(400).json({ error: 'jobId required' });
    }

    await assertJobParticipant(jobId, user.id);

    const status = await IssuingService.activateErrandCard(jobId);
    return res.json(status);
  } catch (error: any) {
    console.error('[IssuingRoutes] errand-card activate failed:', {
      message: error?.message,
      type: error?.type,
      code: error?.code,
      statusCode: error?.statusCode,
      detail: error?.details || error?.detail
    });

    const status = /auth|session/i.test(error.message) ? 401 : 400;
    return res.status(status).json({ error: error.message || 'Failed to activate Movabi Pay card' });
  }
});

export default router;
