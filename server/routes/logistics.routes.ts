import { Router, Request, Response } from 'express';
import { LogisticsService } from '../services/logistics.service';
import { dispatchService } from '../services/dispatch.service';
import { MarketplaceConfigService } from '../services/marketplace-config.service';

const router = Router();

/**
 * Calculate distance and price for a potential job
 */
router.post('/calculate-price', async (req: Request, res: Response) => {
  try {
    const { pickup, dropoff } = req.body;
    if (!pickup || !dropoff || !pickup.lat || !pickup.lng || !dropoff.lat || !dropoff.lng) {
      return res.status(400).json({ error: 'Pickup and dropoff coordinates required' });
    }

    const distance = LogisticsService.calculateDistance(
      pickup.lat, pickup.lng,
      dropoff.lat, dropoff.lng
    );
    const price = LogisticsService.calculatePrice(distance);

    res.json({
      estimated_distance: distance,
      estimated_price: price
    });
  } catch (error: any) {
    console.error('Price calculation error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get payout breakdown for a driver
 */
router.post('/payout-breakdown', async (req: Request, res: Response) => {
  try {
    const { totalPrice, driverId } = req.body;
    if (!totalPrice || !driverId) {
      return res.status(400).json({ error: 'totalPrice and driverId required' });
    }

    const { data: profile, error } = await LogisticsService.findDriverProfile(driverId);
    if (error || !profile) throw new Error('Driver profile not found');

    const effectiveCommission = await MarketplaceConfigService.getEffectiveCommissionPercent(
      null,
      null,
      String(profile.tier || '') || null,
      null
    );

    const platformFeeConfig = await MarketplaceConfigService.getEffectivePlatformFeeConfig(null);
    const platformFeeAmount = platformFeeConfig.enabled
      ? platformFeeConfig.type === 'fixed'
        ? Number(platformFeeConfig.fixedAmount || 0)
        : platformFeeConfig.type === 'fixed_plus_percentage'
          ? Number(platformFeeConfig.fixedAmount || 0) + (Number(totalPrice) * (Number(platformFeeConfig.percent || 0) / 100))
          : Number(totalPrice) * (Number(platformFeeConfig.percent || 0) / 100)
      : 0;
    const platformFeePercent = Number(totalPrice) > 0
      ? (platformFeeAmount / Number(totalPrice)) * 100
      : 0;

    const breakdown = LogisticsService.calculatePayout(
      totalPrice,
      profile.pricing_plan || 'starter',
      effectiveCommission,
      platformFeePercent
    );

    res.json(breakdown);
  } catch (error: any) {
    console.error('Payout breakdown error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Suggest nearest drivers for a job
 */
router.post('/suggest-drivers', async (req: Request, res: Response) => {
  try {
    const { lat, lng, tenant_id } = req.body;
    if (!lat || !lng || !tenant_id) {
      return res.status(400).json({ error: 'Location (lat, lng) and tenant_id required' });
    }

    const drivers = await LogisticsService.findNearestDrivers(lat, lng, tenant_id);
    res.json(drivers);
  } catch (error: any) {
    console.error('Suggest drivers error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Enqueue a job for auto-dispatch
 */
router.post('/enqueue', async (req: Request, res: Response) => {
  try {
    const { jobId, tenantId, cityId } = req.body;
    if (!jobId || !tenantId) {
      return res.status(400).json({ error: 'jobId and tenantId required' });
    }

    const { data, error } = await dispatchService.enqueueJob(jobId, tenantId, cityId);
    if (error) {
      console.error('[LogisticsRoutes] enqueue dispatch error:', error);
      return res.status(500).json({
        error: error.message || error.details || 'Failed to enqueue job',
        details: error.details,
        hint: error.hint,
        code: error.code
      });
    }

    res.json({ success: true, data });
  } catch (error: any) {
    console.error('Enqueue job error:', error);
    res.status(500).json({ error: error.message || 'Failed to enqueue job' });
  }
});

/**
 * Complete a job and trigger payout
 */
router.post('/complete', async (req: Request, res: Response) => {
  try {
    const { jobId, completionPin } = req.body;
    if (!jobId) {
      return res.status(400).json({ error: 'jobId required' });
    }

    const data = await LogisticsService.completeJob(jobId, completionPin);
    res.json({ success: true, data });
  } catch (error: any) {
    console.error('Complete job error:', error);
    const message = String(error?.message || 'Failed to complete job');
    const status = /pin|required|incorrect/i.test(message) ? 400 : 500;
    res.status(status).json({ error: message });
  }
});

export default router;
