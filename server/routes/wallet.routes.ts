import {CustomerWalletSandbox,WalletSandboxError} from '../services/payments/customer-wallet-sandbox';
import {customerWalletTopupReadiness,WalletTopupReadinessError} from '../services/customer-wallet-topup-readiness';
import {ensureCustomerWallet,customerWalletSetupError} from '../services/customer-wallet-setup';
import {rateLimit} from 'express-rate-limit';
import { dispatchService } from '../services/dispatch.service';
import { Router, Request, Response } from 'express';
import { supabaseAdmin } from '../services/supabase.service';
import { PaymentAuthorityService } from '../services/payment-authority.service';
import { IssuingCapacityService } from '../services/issuing-capacity.service';
import { MarketAvailabilityError, MarketAvailabilityService } from '../services/market-availability.service';

const router = Router();

router.post('/setup',rateLimit({windowMs:60000,limit:12,standardHeaders:true,legacyHeaders:false}),async(req:Request,res:Response)=>{
 res.setHeader('Cache-Control','private, no-store');
 try{
  const header=String(req.headers.authorization||'');
  if(!/^Bearer\s+\S+$/i.test(header))return res.status(401).json({code:'AUTH_REQUIRED',error:'Please sign in again.'});
  const {data,error}=await supabaseAdmin.auth.getUser(header.replace(/^Bearer\s+/i,''));
  if(error||!data?.user)return res.status(401).json({code:'AUTH_REQUIRED',error:'Please sign in again.'});
  if(req.body!=null&&(Array.isArray(req.body)||typeof req.body!=='object'||Object.keys(req.body).length))
   return res.status(400).json({code:'WALLET_SETUP_INPUT_NOT_ALLOWED',error:'Wallet setup uses the registered account market.'});
  return res.json(await ensureCustomerWallet(supabaseAdmin,data.user.id));
 }catch(error:unknown){
  const failure=customerWalletSetupError(error);
  if(failure)return res.status(failure.status).json({code:failure.code,error:failure.error});
  return res.status(503).json({code:'CUSTOMER_WALLET_SETUP_UNAVAILABLE',error:'Wallet setup could not be verified. Please retry.'});
 }
});



router.get('/topup-readiness',rateLimit({windowMs:60000,limit:30,standardHeaders:true,legacyHeaders:false}),async(req:Request,res:Response)=>{
 res.setHeader('Cache-Control','private, no-store');
 res.setHeader('Vary','Authorization');
 try{
  const header=String(req.headers.authorization||'');
  if(!/^Bearer\s+\S+$/i.test(header))return res.status(401).json({code:'AUTH_REQUIRED',error:'Please sign in again.'});
  const {data,error}=await supabaseAdmin.auth.getUser(header.replace(/^Bearer\s+/i,''));
  if(error||!data?.user)return res.status(401).json({code:'AUTH_REQUIRED',error:'Please sign in again.'});
  if(Object.keys(req.query||{}).length||req.body!=null&&(typeof req.body!=='object'||Array.isArray(req.body)||Object.keys(req.body).length))
   return res.status(400).json({code:'WALLET_TOPUP_INPUT_NOT_ALLOWED',error:'Readiness uses the registered account market.'});
  return res.json(await customerWalletTopupReadiness(supabaseAdmin,data.user.id));
 }catch(error:unknown){
  if(error instanceof WalletTopupReadinessError)return res.status(error.status).json({code:error.code,error:'Wallet top-up readiness could not be verified.'});
  return res.status(503).json({code:'WALLET_TOPUP_READINESS_UNAVAILABLE',error:'Wallet top-up readiness could not be verified. Please retry.'});
 }
});


const sandboxLimiter=rateLimit({windowMs:60000,limit:20,standardHeaders:true,legacyHeaders:false});
function sandboxHeaders(res:Response){res.setHeader('Cache-Control','private, no-store');res.setHeader('Vary','Authorization');}
function sandboxFailure(res:Response,e:unknown){if(e instanceof WalletSandboxError)return res.status(e.status).json({code:e.code,error:'Sandbox checkout could not be completed. Check eligibility or reconcile the existing attempt.'});return res.status(503).json({code:'SANDBOX_UNAVAILABLE',error:'Sandbox checkout could not be verified.'});}
async function sandboxOwner(req:Request){const h=String(req.headers.authorization||'');if(!/^Bearer\s+\S+$/i.test(h))throw new WalletSandboxError(401,'AUTH_REQUIRED');const {data,error}=await supabaseAdmin.auth.getUser(h.replace(/^Bearer\s+/i,''));if(error||!data?.user?.id)throw new WalletSandboxError(401,'AUTH_REQUIRED');return data.user;}
router.post('/sandbox-topups',sandboxLimiter,async(req:Request,res:Response)=>{sandboxHeaders(res);try{const user=await sandboxOwner(req);if(Object.keys(req.query||{}).length)throw new WalletSandboxError(400,'INVALID_SANDBOX_INPUT');if(!user.email_confirmed_at)throw new WalletSandboxError(409,'VERIFIED_CUSTOMER_EMAIL_REQUIRED');return res.json(await new CustomerWalletSandbox(supabaseAdmin).begin(user.id,user.email||'',req.body));}catch(e){return sandboxFailure(res,e);}});
router.get('/sandbox-topups/eligibility',sandboxLimiter,async(req:Request,res:Response)=>{sandboxHeaders(res);try{const user=await sandboxOwner(req);if(Object.keys(req.query||{}).length)throw new WalletSandboxError(400,'INVALID_SANDBOX_INPUT');if(!user.email_confirmed_at)return res.json({eligible:false});return res.json(await new CustomerWalletSandbox(supabaseAdmin).eligibility(user.id));}catch(e){return sandboxFailure(res,e);}});
router.get('/sandbox-topups/:id',sandboxLimiter,async(req:Request,res:Response)=>{sandboxHeaders(res);try{const user=await sandboxOwner(req);if(Object.keys(req.query||{}).length)throw new WalletSandboxError(400,'INVALID_SANDBOX_INPUT');return res.json(await new CustomerWalletSandbox(supabaseAdmin).status(user.id,String(req.params.id)));}catch(e){return sandboxFailure(res,e);}});
router.post('/sandbox-topups/:id/reconcile',sandboxLimiter,async(req:Request,res:Response)=>{sandboxHeaders(res);try{const user=await sandboxOwner(req);if(Object.keys(req.query||{}).length||req.body!=null&&(typeof req.body!=='object'||Array.isArray(req.body)||Object.keys(req.body).length))throw new WalletSandboxError(400,'INVALID_SANDBOX_INPUT');return res.json(await new CustomerWalletSandbox(supabaseAdmin).reconcile(user.id,String(req.params.id)));}catch(e){return sandboxFailure(res,e);}});
router.post('/sandbox-topups/kora/webhook',sandboxLimiter,async(req:Request,res:Response)=>{sandboxHeaders(res);try{return res.json(await new CustomerWalletSandbox(supabaseAdmin).webhook(req.body?.data,req.headers['x-korapay-signature']));}catch(e){return sandboxFailure(res,e);}});

async function getAuthUserId(req: Request): Promise<string | null> {
  const existing = (req as any).user?.id || (req as any).auth?.user?.id;
  if (existing) return String(existing);
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data?.user?.id) return null;
  return data.user.id;
}

/**
 * Get wallet transactions for a user
 */
router.get('/transactions', async (req: Request, res: Response) => {
  try {
    const { userId } = req.query;

    const authUserId = await getAuthUserId(req);
    if (!authUserId) return res.status(401).json({ error: 'Authentication required' });
    if (String(userId || '') !== authUserId) return res.status(403).json({ error: 'Cannot access another user wallet' });

    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    const { data, error } = await supabaseAdmin
      .from('wallet_transactions')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.json(data);
  } catch (error: any) {
    console.error('Error fetching wallet transactions:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get wallet balance for a user
 */
router.get('/balance', async (req: Request, res: Response) => {
  try {
    const { userId } = req.query;

    const authUserId = await getAuthUserId(req);
    if (!authUserId) return res.status(401).json({ error: 'Authentication required' });
    if (String(userId || '') !== authUserId) return res.status(403).json({ error: 'Cannot access another user wallet' });

    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    const { data, error } = await supabaseAdmin
      .from('wallets')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();

    if (error) throw error;

    res.json(data);
  } catch (error: any) {
    console.error('Error fetching wallet balance:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Reserve/pay a job from wallet balance through a trusted database function.
 */
router.post('/pay-job', async (req: Request, res: Response) => {
  try {
    const { userId, jobId, currency, tenantId } = req.body || {};

    const authUserId = await getAuthUserId(req);
    if (!authUserId) return res.status(401).json({ error: 'Authentication required' });
    if (String(userId || '') !== authUserId) return res.status(403).json({ error: 'Cannot pay from another user wallet' });

    if (!userId || !jobId) {
      return res.status(400).json({ error: 'userId and jobId are required' });
    }

    const { data: job, error: jobError } = await supabaseAdmin
      .from('jobs')
      .select('*, service_type:service_types(*)')
      .eq('id', jobId)
      .maybeSingle();
    if (jobError) {
      console.error('[WalletRoutes] job lookup failed:', jobError);
      return res.status(500).json({ error: 'Unable to load booking for wallet payment' });
    }
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (String(job.customer_id || '') !== String(userId)) return res.status(403).json({ error: 'Only the customer can pay for this job' });
    const breakdown = (job.fare_breakdown && typeof job.fare_breakdown === 'object') ? job.fare_breakdown as Record<string, unknown> : {};
    const metadata = (job.metadata && typeof job.metadata === 'object') ? job.metadata as Record<string, unknown> : {};
    try {
      await MarketAvailabilityService.requireCapability({ countryCode: job.country_code || metadata['country_code'], marketCity: job.market_city || metadata['market_city'] || metadata['pickup_city'],
        zoneId: job.zone_id || metadata['zone_id'], capability: 'payment', endpoint: '/api/wallet/pay-job' });
    } catch (availabilityError) {
      if (availabilityError instanceof MarketAvailabilityError) return res.status(availabilityError.httpStatus).json({ error: availabilityError.message, code: availabilityError.code, market: availabilityError.market });
      throw availabilityError;
    }
    const quoteReference = String((job as any).quote_id || metadata['quote_id'] || breakdown['quoteId'] || '').trim();
    const quoteExpiresAt = String(metadata['quote_expires_at'] || breakdown['quoteExpiresAt'] || '').trim();
    const quoteVersion = String(breakdown['calculationVersion'] || breakdown['marketPricingVersion'] || '').trim();
    if (job.payment_status !== 'wallet_funded' && !job.agreed_fare && (!quoteReference || !quoteVersion || !quoteExpiresAt || !Number.isFinite(Date.parse(quoteExpiresAt)) || Date.parse(quoteExpiresAt) <= Date.now())) {
      return res.status(409).json({ error: 'Fare quote is missing or expired', code: 'QUOTE_EXPIRED' });
    }
    // C2: the wallet debit amount is server-derived by the SAME authoritative
    // resolver as card payment; the client never chooses the amount.
    const payable = await PaymentAuthorityService.resolve(job);
    // Existing funded wallet bookings remain idempotent; new reservations need capacity.
    if (job.payment_status !== 'wallet_funded') {
      try {
        await IssuingCapacityService.assertAvailable(payable.itemBudgetMajor, payable.currency, String(job.id));
      } catch (capacityError: any) {
        return res.status(409).json({ error: capacityError.message, code: 'SHOPPING_CAPACITY_UNAVAILABLE' });
      }
    }
    const paymentAmount = payable.totalAuthorisationMajor;
    if (!Number.isFinite(paymentAmount) || paymentAmount <= 0) return res.status(400).json({ error: 'Job has no valid quoted amount' });

    const { data, error } = await supabaseAdmin.rpc('pay_job_from_wallet', {
      p_job_id: jobId,
      p_customer_id: userId,
      p_amount: Math.round((paymentAmount + Number.EPSILON) * 100) / 100,
      p_currency_code: String(job.currency_code || breakdown['currencyCode'] || currency || 'GBP').toUpperCase(),
      p_tenant_id: job.tenant_id || tenantId || null
    });

    if (error) {
      console.error('[WalletRoutes] pay-job RPC failed:', error);
      const status = /insufficient/i.test(error.message) ? 402 : 400;
      return res.status(status).json({
        error: error.message,
        code: error.code,
        details: error.details,
        hint: error.hint
      });
    }

    // Notify only after the transaction committed. Repeated payment calls must
    // not reset dispatch or send another round of notifications.
    if ((data as any)?.status !== 'already_paid') {
      try {
        const { data: activated } = await supabaseAdmin.from('jobs')
          .select('*, service_type:service_types(*)').eq('id', jobId).maybeSingle();
        if (activated?.status === 'searching' && !activated.driver_id) {
          await dispatchService.notifyNearbyDrivers(activated, activated.tenant_id, activated.city_id);
        }
      } catch (notifyError) {
        console.error('[WalletRoutes] driver notification failed after payment:', notifyError);
      }
    }

    res.json({
      success: true,
      paymentMethod: 'wallet',
      amount: paymentAmount,
      data
    });
  } catch (error: any) {
    console.error('Error paying job from wallet:', error);
    res.status(error?.code === 'PAYMENT_TERMS_RECONCILIATION_REQUIRED' ? 409 : 500)
      .json({ error: error.message, code: error?.code });
  }
});

export default router;
