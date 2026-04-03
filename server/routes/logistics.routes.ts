import { Router, Request, Response } from 'express';
import { LogisticsService } from '../services/logistics.service';
import { dispatchService } from '../services/dispatch.service';

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
    if (error) throw error;

    res.json({ success: true, data });
  } catch (error: any) {
    console.error('Enqueue job error:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
