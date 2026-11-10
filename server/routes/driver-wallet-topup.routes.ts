import { Router, type Request, type Response } from 'express';
import { supabaseAdmin } from '../services/supabase.service';
import { FlutterwaveWalletCollection } from '../services/payments/flutterwave-wallet-collection';
import Stripe from 'stripe';
import {StripeDriverTopupSandbox} from '../services/payments/stripe-driver-topup-sandbox';
import type {DriverCardTopupAdapter,DriverCardAdapterResolver} from '../services/payments/driver-card-topup-contracts';
import { DriverWalletTopupService, type DriverTopupDb, type DriverTopupConfig } from '../services/payments/driver-wallet-topup';
import { PaymentLayerError } from '../services/payments/payment-contracts';

/** Injected dependencies. Production uses the real Supabase client + Flutterwave
 * adapter; tests inject mocks without weakening production auth. */
export interface DriverTopupDeps {
  supabase: DriverTopupDb;
  config: DriverTopupConfig;
  adapter: DriverCardTopupAdapter | DriverCardAdapterResolver;
}

export function createDriverTopupRouter(deps: DriverTopupDeps): Router {
  const router = Router();
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  const service = new DriverWalletTopupService(deps.supabase, deps.config, deps.adapter);
  function failure(res: Response, error: unknown) {
    if (error instanceof PaymentLayerError) {
      const status = error.code === 'AUTHENTICATION_REQUIRED' ? 401
        : error.code === 'TOPUP_NOT_AVAILABLE' ? 404
        : ['COLLECTION_DISABLED','PAYMENT_RECONCILIATION_REQUIRED','TOPUP_QUOTE_MISMATCH'].includes(error.code) ? 409
        : 400;
      return res.status(status).json({ code: error.code });
    }
    return res.status(503).json({ code: "TOPUP_RESULT_UNCONFIRMED" });
  }
  router.get('/availability', async (req: Request, res: Response) => {
    try {
      const match = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization || ''));
      if (!match) throw new PaymentLayerError('AUTHENTICATION_REQUIRED', 'Authentication required');
      return res.json(await service.availability(match[1]));
    } catch (error) { return failure(res, error); }
  });
  router.post('/checkout', async (req: Request, res: Response) => {
    try {
      const body = req.body || {};
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !['amountMinor','idempotencyKey','confirmedTotalMinor'].includes(k)) || typeof body.amountMinor !== 'number' || typeof body.idempotencyKey !== 'string' || (body.confirmedTotalMinor !== undefined && typeof body.confirmedTotalMinor !== 'number'))
        throw new PaymentLayerError('INVALID_PAYMENT_INPUT', 'amountMinor and idempotencyKey are required');
      const match = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization || ''));
      if (!match) throw new PaymentLayerError('AUTHENTICATION_REQUIRED', 'Authentication required');
      return res.json(await service.createCheckout(match[1], { amountMinor: body.amountMinor, idempotencyKey: body.idempotencyKey, confirmedTotalMinor: body.confirmedTotalMinor }));
    } catch (error) { return failure(res, error); }
  });
  router.post('/recover', async (req: Request, res: Response) => {
    try {
      if (!req.body||typeof req.body!=='object'||Array.isArray(req.body)||Object.keys(req.body).some(k=>k!=='attemptId')||typeof req.body.attemptId!=='string')
        throw new PaymentLayerError('INVALID_PAYMENT_INPUT','attemptId is required');
      const match=/^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization||''));
      if (!match) throw new PaymentLayerError('AUTHENTICATION_REQUIRED','Authentication required');
      return res.json(await service.recover(match[1],req.body.attemptId));
    } catch (error) { return failure(res,error); }
  });
  router.post('/verify', async (req: Request, res: Response) => {
    try {
      if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).some(k => k !== 'attemptId') || typeof req.body.attemptId !== 'string')
        throw new PaymentLayerError('INVALID_PAYMENT_INPUT', 'attemptId is required');
      const match = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization || ''));
      if (!match) throw new PaymentLayerError('AUTHENTICATION_REQUIRED', 'Authentication required');
      return res.json(await service.verify(match[1], req.body.attemptId));
    } catch (error) { return failure(res, error); }
  });
  return router;
}

// Production defaults (real Supabase + Flutterwave; disabled by default).
export function flutterwaveAttemptStore(db: Pick<DriverTopupDb, 'from'> & Partial<Pick<DriverTopupDb,'rpc'>>) {
  return {
    begin: async (reference: string, request: unknown) => {
      const { error } = await db.from('payment_checkout_attempts').insert({ reference, request, state: 'started' });
      if (error?.code === '23505') return false;
      if (error) throw new PaymentLayerError('PAYMENT_STORE_UNAVAILABLE', 'Could not reserve payment reference');
      return true;
    },
    finish: async (reference: string, state: 'submitted' | 'unknown', checkoutUrl?: string,providerSessionId?:string) => {
      const { data, error } = await db.from('payment_checkout_attempts')
        .update({ state, ...(checkoutUrl?{checkout_url:checkoutUrl}:{}),...(providerSessionId?{provider_session_id:providerSessionId}:{}) }).eq('reference', reference).select('reference');
      if (error || !Array.isArray(data) || data.length !== 1 || data[0]?.reference !== reference)
        throw new PaymentLayerError('PAYMENT_RECONCILIATION_REQUIRED', 'Payment attempt requires reconciliation');
    },
    get: async (reference: string) => {
      const { data, error } = await db.from('payment_checkout_attempts').select('request,state,provider_session_id').eq('reference', reference).maybeSingle();
      if (error) throw new PaymentLayerError('PAYMENT_RECONCILIATION_REQUIRED', 'Payment attempt requires reconciliation');
      return data?{...data,providerSessionId:data.provider_session_id}:null;
    },
    observe: async(reference:string,evidence:Readonly<Record<string,unknown>>)=>{
      if(!db.rpc)throw new PaymentLayerError('PAYMENT_STORE_UNAVAILABLE','Observation store unavailable');
      await db.rpc('record_driver_topup_provider_observation',{p_attempt_id:reference,p_evidence:evidence});
    },
  };
}
function productionAdapter(): FlutterwaveWalletCollection {
  const attempts = flutterwaveAttemptStore(productionDb);
  const webhookSecret = process.env['FLUTTERWAVE_WEBHOOK_SECRET'] || '';
  if (!/^[A-Za-z0-9_-]{8,}$/.test(webhookSecret)) throw new PaymentLayerError('INVALID_PAYMENT_INPUT', 'Flutterwave webhook secret is not configured');
  return new FlutterwaveWalletCollection(
    process.env['FLUTTERWAVE_SECRET_KEY'] || '', process.env['FLUTTERWAVE_MERCHANT_REF'] || '', attempts, webhookSecret,
  );
}
const productionDb: DriverTopupDb = {
  authGetUser: async (token) => {
    const { data, error } = await supabaseAdmin.auth.getUser(token);
    return (error || !data?.user?.id) ? null : { id: data.user.id, email: data.user.email || '' };
  },
  rpc: async (fn, args) => {
    const { data, error } = await supabaseAdmin.rpc(fn, args);
    if (error) throw new PaymentLayerError('RPC_' + fn, error.message);
    return data as any;
  },
  from: (table) => supabaseAdmin.from(table),
};
const productionConfig: DriverTopupConfig = {
  collectionEnabled: async () => process.env['VAYDU_DRIVER_TOPUP_API'] === 'true' && process.env['NODE_ENV'] !== 'production',
  flutterwaveSecret: () => process.env['FLUTTERWAVE_SECRET_KEY'] || '',
  flutterwaveWebhookSecret: () => process.env['FLUTTERWAVE_WEBHOOK_SECRET'] || '',
  flutterwaveMerchant: () => process.env['FLUTTERWAVE_MERCHANT_REF'] || '',
  callbackUrl: () => process.env['VAYDU_TOPUP_CALLBACK_URL'] || '',
};
let _defaultRouter: Router | null = null;
export default function driverWalletTopupRoutes(): Router {
  const outer = Router();
  outer.use(async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!(await productionConfig.collectionEnabled())) return res.status(404).json({code:'DRIVER_TOPUP_UNAVAILABLE'});
    try {
      if (!_defaultRouter) _defaultRouter = createDriverTopupRouter({ supabase: productionDb, config: productionConfig, adapter:(provider,merchant)=>{
        if(provider==='flutterwave')return productionAdapter();
        if(provider==='stripe')return new StripeDriverTopupSandbox(new Stripe(process.env['STRIPE_SECRET_KEY']||'',{apiVersion:'2023-10-16' as any}),process.env['STRIPE_SECRET_KEY']||'',merchant,flutterwaveAttemptStore(productionDb));
        throw new PaymentLayerError('PAYMENT_PROVIDER_NOT_READY','Card adapter has not passed sandbox review');
      } });
      return _defaultRouter(req, res, next);
    } catch {
      return res.status(503).json({code:'DRIVER_TOPUP_UNAVAILABLE'});
    }
  });
  return outer;
}


