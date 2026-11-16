import {loadDatabasePaymentPolicies} from '../services/payments/market-payment-store';
import { Router, Request } from 'express';
import rateLimit from 'express-rate-limit';
import { stripe } from '../services/stripe.service';
import { supabaseAdmin } from '../services/supabase.service';
import { MarketAvailabilityService } from '../services/market-availability.service';
import { cardWalletSetupAllowed } from '../services/payments/card-wallet-policy';
import { StripeSavedCards, CARD_SETUP_CONSENT_VERSION } from '../services/payments/stripe-saved-cards';

export function createCardWalletRouter(authenticate: (req: Request) => Promise<string | null>) {
  const router = Router();
  const cards = new StripeSavedCards(stripe, supabaseAdmin);
  router.use(rateLimit({windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false}));
  router.use(async (req, res, next) => {
    try {
      const userId = await authenticate(req);
      if (!userId) return res.status(401).json({error: 'Please sign in again.'});
      if (process.env.VAYDU_SAVED_CARDS_V23 !== 'true') return res.status(404).json({error: 'Saved-card management is currently disabled.', code: 'SAVED_CARDS_DISABLED'});
      res.locals.cardWalletUserId = userId;
      next();
    } catch { return res.status(503).json({error: 'Payment methods are temporarily unavailable.'}); }
  });
  async function setupAvailability(userId: string): Promise<{canAdd:boolean;reasonCode:string|null}> {
    if (process.env.VAYDU_CARD_SETUP_V23 !== 'true') return {canAdd:false,reasonCode:'CARD_SETUP_DISABLED'};
    const {data, error} = await supabaseAdmin.from('profiles')
      .select('registration_country_code,country_code,registration_market_city').eq('id', userId).single();
    if (error || !data) throw Error('Profile unavailable');
    // The request body never supplies country, city, provider or account.
    const country = String(data.registration_country_code?.trim() || data.country_code?.trim() || '').toUpperCase();
    if (!/^[A-Z]{2}$/.test(country)) return {canAdd:false,reasonCode:'CARD_SETUP_MARKET_UNRESOLVED'};
    if (country !== 'GB') return {canAdd:false,reasonCode:'CARD_SETUP_MARKET_UNSUPPORTED'};
    try {
      const market = await MarketAvailabilityService.requireCapability({countryCode: country,
        marketCity: data.registration_market_city, capability: 'payment'});
      const allowed = cardWalletSetupAllowed({cardsEnabled: true, setupEnabled: true,
        country: market.countryCode, currency: market.currency, paymentEnabled: market.capabilities.payment,
        routes: JSON.stringify(await loadDatabasePaymentPolicies(supabaseAdmin,{country:String(market.countryCode),currency:String(market.currency),method:'card'}))});
      return {canAdd:allowed,reasonCode:allowed?null:'CARD_SETUP_MARKET_UNSUPPORTED'};
    } catch { return {canAdd:false,reasonCode:'CARD_SETUP_MARKET_UNAVAILABLE'}; }
  }
  router.get('/', async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const userId = String(res.locals.cardWalletUserId);
      const [saved, availability] = await Promise.all([cards.list(userId), setupAvailability(userId)]);
      return res.json({cards: saved, ...availability, consentVersion: CARD_SETUP_CONSENT_VERSION});
    } catch { return res.status(503).json({error: 'Could not load payment methods. Please try again.'}); }
  });
  router.post('/setup', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
        Object.keys(body).some(key => !['requestId', 'consentVersion'].includes(key)) ||
        body.consentVersion !== CARD_SETUP_CONSENT_VERSION || typeof body.requestId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.requestId)) {
      return res.status(400).json({error: 'Confirm card-saving permission before continuing.'});
    }
    try {
      const userId = String(res.locals.cardWalletUserId);
      const availability = await setupAvailability(userId);
      if (!availability.canAdd) return res.status(409).json({error: availability.reasonCode==='CARD_SETUP_DISABLED'?'Adding saved cards is currently disabled.':'Adding cards is not available for your market.',code:availability.reasonCode});
      return res.json(await cards.beginSetup(userId, body.requestId, body.consentVersion));
    } catch { return res.status(503).json({error: 'Card setup could not be confirmed. Retry using this same form.'}); }
  });
  // Removal stays available for an owned existing card even after a change of market.
  router.delete('/:methodId', async (req, res) => {
    try {
      await cards.remove(String(res.locals.cardWalletUserId), String(req.params.methodId));
      return res.json({success: true});
    } catch { return res.status(400).json({error: 'Could not remove this card. Refresh your list and try again.'}); }
  });
  return router;
}
