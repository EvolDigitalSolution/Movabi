import { createKoraBookingPilot } from '../services/payments/kora-booking-pilot';
import { Router, type Request, type Response } from 'express';
import { supabaseAdmin } from '../services/supabase.service';
import { createSandboxSession, sandboxConfig, SandboxSessionError } from '../services/payments/kora-sandbox-session';
const router = Router();
router.use((_req, res, next) => {res.setHeader('Cache-Control', 'no-store'); next();});
function available(): boolean {
  return process.env.VAYDU_KORA_SANDBOX_API === 'true' && process.env.NODE_ENV !== 'production';
}
async function auth(req: Request) {
  const match = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization || ''));
  if (!match) throw new SandboxSessionError(401, 'AUTHENTICATION_REQUIRED');
  const {data, error} = await supabaseAdmin.auth.getUser(match[1]);
  if (error || !data?.user?.id) throw new SandboxSessionError(401, 'AUTHENTICATION_REQUIRED');
  return data.user;
}
function failure(res: Response, error: unknown) {
  if (error instanceof SandboxSessionError) return res.status(error.status).json({code: error.code});
  // Never return provider payloads, tokens, credential-bearing request objects or raw errors.
  return res.status(503).json({code: 'SANDBOX_RESULT_UNCONFIRMED'});
}
router.post('/checkout', async (req: Request, res: Response) => {
  if (!available()) return res.status(404).json({code: 'SANDBOX_UNAVAILABLE'});
  try {
    const user = await auth(req);
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
        Object.keys(body).length !== 1 || typeof body.requestId !== 'string')
      throw new SandboxSessionError(400, 'INVALID_SANDBOX_REQUEST');
    const service = createSandboxSession(supabaseAdmin, sandboxConfig(process.env));
    return res.json(await service.create(user.id, user.email || '', body.requestId));
  } catch (error) {return failure(res, error);}
});
router.post('/verify', async (req: Request, res: Response) => {
  if (!available()) return res.status(404).json({code: 'SANDBOX_UNAVAILABLE'});
  try {
    const user = await auth(req);
    if (!req.body || Object.keys(req.body).length !== 1 || typeof req.body.reference !== 'string' ||
        !/^vaydu-(test-[a-f0-9]{32}|kora-test-[a-f0-9]{64})$/.test(req.body.reference))
      throw new SandboxSessionError(400, 'INVALID_SANDBOX_REQUEST');
    return res.json(await createSandboxSession(supabaseAdmin, sandboxConfig(process.env)).verify(user.id, req.body.reference));
  } catch (error) {return failure(res, error);}
});
router.post('/webhook', async (req: Request, res: Response) => {
  if (!available()) return res.status(404).json({code: 'SANDBOX_UNAVAILABLE'});
  try {
    const reference = req.body?.data?.reference;
    if (typeof reference === 'string' && /^vaydu-(book|refund)-[a-f0-9]{32}$/.test(reference)) {
      if (process.env.VAYDU_KORA_BOOKING_PILOT !== 'true')
        throw new SandboxSessionError(404,'BOOKING_PILOT_UNAVAILABLE');
      await createKoraBookingPilot(supabaseAdmin,process.env)
        .webhook(req.body?.data,req.headers['x-korapay-signature']);
    } else {
      await createSandboxSession(supabaseAdmin, sandboxConfig(process.env))
        .webhook(req.body?.data, req.headers['x-korapay-signature']);
    }
    return res.json({received: true});
  } catch (error) {return failure(res, error);}
});
// Completed-booking sandbox pilot. Original operational payment routes are not modified.
for (const operation of ['checkout','verify','refund','refund-verify'] as const) {
  router.post('/booking/' + operation, async (req: Request, res: Response) => {
    if (!available() || process.env.VAYDU_KORA_BOOKING_PILOT !== 'true')
      return res.status(404).json({code:'BOOKING_PILOT_UNAVAILABLE'});
    try {
      const user = await auth(req);
      const body = req.body;
      const allowed = operation === 'refund' ? ['jobId','completionStatus'] : ['jobId'];
      if (!body || typeof body !== 'object' || Array.isArray(body) ||
          Object.keys(body).some(k=>!allowed.includes(k)) || typeof body.jobId !== 'string' ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.jobId) ||
          (operation === 'refund' && !['success','failed'].includes(body.completionStatus)))
        throw new SandboxSessionError(400,'INVALID_BOOKING_PILOT_REQUEST');
      const service = createKoraBookingPilot(supabaseAdmin,process.env);
      const result = operation === 'checkout' ? await service.create(user.id,user.email||'',body.jobId)
        : operation === 'verify' ? await service.verify(user.id,body.jobId)
        : operation === 'refund' ? await service.refund(user.id,body.jobId,body.completionStatus)
        : await service.verifyRefund(user.id,body.jobId);
      return res.json(result);
    } catch(error) {return failure(res,error);}
  });
}
export default router;
