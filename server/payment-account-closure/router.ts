import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { SetupService } from './service';
import type { DriverPayoutAdapter } from './service';

/**
 * Setup-only payment-account surface. The baseline's supabaseAdmin is injected
 * explicitly by the mount; this module never imports the local supabase service.
 * No payout worker, transfer, collection or subaccount code is reachable here.
 */
export function driverPaymentAccountRouter(db: any, provider: (provider:string,merchant:string)=>DriverPayoutAdapter, requestLimit=20) {
  const service = new SetupService(db, provider);
  const router = Router();

  router.use(rateLimit({ windowMs: 60000, max: requestLimit, standardHeaders: true, legacyHeaders: false,
    message: { error: 'Please wait before retrying payment account setup.' } }));
  router.use(async (req: any, res: any, next: any) => {
    try {
      const token = /^Bearer (\S+)$/.exec(req.headers.authorization || '')?.[1];
      if (!token) return void res.status(401).json({ error: 'Sign in required.' });
      const result = await db.auth.getUser(token);
      if (result.error || !result.data?.user) return void res.status(401).json({ error: 'Sign in required.' });
      res.locals.driverId = result.data.user.id;
      next();
    } catch {
      res.status(401).json({ error: 'Sign in required.' });
    }
  });

  const handler = (fn: (req: any, id: string) => Promise<any>) => async (req: any, res: any) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      res.json(await fn(req, res.locals.driverId));
    } catch (error) {
      const upstream = (error as any)?.upstreamStatus;
      if (upstream === 429) {
        const retryAfter = Math.min(3600, Math.max(1, Number((error as any)?.retryAfter) || 30));
        res.setHeader('Retry-After', String(retryAfter));
        res.setHeader('Access-Control-Expose-Headers', 'Retry-After');
        res.status(429).json({ error: 'Too many account checks. Please wait before trying again.', errorCode: 'PAYMENT_ACCOUNT_RATE_LIMITED', retryAfterSeconds: retryAfter });
      }
      res.status(409).json({ error: 'Payment account request could not be verified. Refresh or contact support.', errorCode: 'PAYMENT_ACCOUNT_SETUP_FAILED' });
    }
  };

  router.get('/status', handler((_, id) => service.status(id)));
  router.get('/banks', handler(async (_, id) => ({ banks: await service.banks(id) })));
  router.post('/resolve', handler(async (req, id) => ({
    accountName: await service.resolve(id, String(req.body?.bankCode || ''), String(req.body?.accountNumber || '')),
  })));
  router.post('/setup', handler((req, id) => req.body?.confirmed === true
    ? service.setup(id, String(req.body?.bankCode || ''), String(req.body?.accountNumber || ''),
        String(req.body?.accountName || ''))
    : Promise.reject(new Error('Confirmation required.'))));
  // Read-only reconciliation surface: an ambiguous provider creation is never
  // retried automatically; the operator decides on a reviewed recovery.
  router.post('/reconcile', handler((_, id) => service.reconcile(id)));
  return router;
}
