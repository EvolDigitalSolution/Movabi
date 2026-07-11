import { Router, Request, Response } from 'express';
import { dispatchService } from '../services/dispatch.service';
import { CityService } from '../services/city.service';
import { GlobalAiPricingService } from '../services/global-ai-pricing.service';

const router = Router();

router.post('/quote', async (req: Request, res: Response) => {
  try {
    const lat = Number(req.body.lat ?? req.body.pickupLat);
    const lng = Number(req.body.lng ?? req.body.pickupLng);

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ error: 'lat/lng or pickupLat/pickupLng are required' });
    }

    const city = await CityService.findCityForLocation(lat, lng);
    const stats = await dispatchService.getAreaStats(lat, lng);
    const { legacyPricing, quote } = await GlobalAiPricingService.resolveQuote({
      ...req.body,
      lat,
      lng,
      pickupLat: req.body.pickupLat ?? lat,
      pickupLng: req.body.pickupLng ?? lng,
      countryCode: req.body.countryCode || (city as any)?.country_code || (city as any)?.country,
      cityName: req.body.cityName || city?.name || null,
      city: city || null,
      demand: req.body.demand ?? stats.demand,
      supply: req.body.supply ?? stats.supply,
      requestedAt: req.body.requestedAt || new Date().toISOString()
    });

    return res.json({
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
    return res.status(400).json({
      error: error?.message || 'Unable to calculate global AI price'
    });
  }
});

export default router;
