import { Router, Request, Response } from 'express';
import { dispatchService } from '../services/dispatch.service';
import { CityService } from '../services/city.service';
import { GlobalAiPricingService } from '../services/global-ai-pricing.service';
import { randomUUID } from 'node:crypto';
import { rateLimit } from 'express-rate-limit';
import { MarketAvailabilityError, MarketAvailabilityService } from '../services/market-availability.service';

const router = Router();
const isWithinGbServiceBounds = (lat: number, lng: number) => lat >= 49.8 && lat <= 60.9 && lng >= -8.7 && lng <= 2.1;

const quoteLimiter = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true, legacyHeaders: false });
router.post('/quote', quoteLimiter, async (req: Request, res: Response) => {
  try {
    const lat = Number(req.body.lat ?? req.body.pickupLat);
    const lng = Number(req.body.lng ?? req.body.pickupLng);

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ error: 'lat/lng or pickupLat/pickupLng are required' });
    }
    for (const [name, value, max] of [['distanceKm', req.body.distanceKm, 2000], ['durationMinutes', req.body.durationMinutes, 10080]] as const) {
      const numeric = Number(value);
      if (!Number.isFinite(numeric) || numeric < 0 || numeric > max) return res.status(400).json({ error: `${name} is outside the allowed range` });
    }

    const city = await CityService.findCityForLocation(lat, lng);
    const stats = await dispatchService.getAreaStats(lat, lng);
    // Availability is resolved from the service coordinates. Client/profile
    // country is presentation context only and cannot authorize a market.
    const countryCode = (city as any)?.country_code || (city as any)?.country || (isWithinGbServiceBounds(lat, lng) ? 'GB' : null);
    const cityName = city?.name || null;
    const availability = await MarketAvailabilityService.requireCapability({ countryCode, marketCity: cityName, zoneId: req.body.zoneId, capability: 'quote', endpoint: '/api/pricing/global-ai/quote' });
    const quoteReference = randomUUID();
    const { legacyPricing, quote } = await GlobalAiPricingService.resolveQuote({
      ...req.body,
      lat,
      lng,
      pickupLat: req.body.pickupLat ?? lat,
      pickupLng: req.body.pickupLng ?? lng,
      countryCode: availability.countryCode,
      cityName: availability.marketCity || cityName,
      city: city || null,
      demand: req.body.demand ?? stats.demand,
      supply: req.body.supply ?? stats.supply,
      requestedAt: req.body.requestedAt || new Date().toISOString(),
      quoteReference
    });

    return res.json({
      quoteReference,
      ...quote,
      legacy: {
        totalPrice: legacyPricing.totalPrice,
        currencyCode: legacyPricing.currencyCode,
        source: legacyPricing.source,
        fareBreakdown: legacyPricing.fareBreakdown
      }
    });
  } catch (error: any) {
    console.error('[GlobalAiPricingRoutes] quote failed:', error);
    if (error instanceof MarketAvailabilityError) return res.status(error.httpStatus).json({ error: error.message, code: error.code, ...error.market });
    return res.status(400).json({
      error: error?.message || 'Unable to calculate global AI price'
    });
  }
});

export default router;
