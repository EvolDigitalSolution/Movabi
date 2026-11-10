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
      if (process.env.VAYDU_SAVED_CARDS_V23 !== 'true') return res.status(404).json({error: 'Saved cards are unavailable.'});
      res.locals.cardWalletUserId = userId;
      next();
    } catch { return res.status(503).json({error: 'Payment methods are temporarily unavailable.'}); }
  });
  async function canAdd(userId: string): Promise<boolean> {
    if (process.env.VAYDU_CARD_SETUP_V23 !== 'true') return false;
    const {data, error} = await supabaseAdmin.from('profiles')
      .select('country_code,registration_market_city').eq('id', userId).single();
    if (error || !data) throw Error('Profile unavailable');
    // The request body never supplies country, city, provider or account.
    if (data.country_code !== 'GB') return false;
    try {
      const market = await MarketAvailabilityService.requireCapability({countryCode: data.country_code,
        marketCity: data.registration_market_city, capability: 'payment'});
      return cardWalletSetupAllowed({cardsEnabled: true, setupEnabled: true,
        country: market.countryCode, currency: market.currency, paymentEnabled: market.capabilities.payment,
        routes: JSON.stringify(await loadDatabasePaymentPolicies(supabaseAdmin,{country:String(market.countryCode),currency:String(market.currency),method:'card'}))});
    } catch { return false; }
  }
  router.get('/', async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const userId = String(res.locals.cardWalletUserId);
      const [saved, allowed] = await Promise.all([cards.list(userId), canAdd(userId)]);
      return res.json({cards: saved, canAdd: allowed, consentVersion: CARD_SETUP_CONSENT_VERSION});
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
      if (!await canAdd(userId)) return res.status(409).json({error: 'Adding cards is not available for your market.'});
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
