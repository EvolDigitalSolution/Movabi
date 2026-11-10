import { Router, Request, Response } from 'express';
import { MarketplaceConfigService } from '../services/marketplace-config.service';

const router = Router();

router.get('/effective-status', async (req: Request, res: Response) => {
  try {
    const service = String(req.query.service || '').trim();
    const tenantId = typeof req.query.tenantId === 'string' && req.query.tenantId.trim()
      ? req.query.tenantId.trim()
      : null;

    const status = await MarketplaceConfigService.getEffectiveHybridStatus(service, tenantId);
    res.json(status);
  } catch (error: any) {
    console.warn('[Marketplace] effective-status failed:', error?.message || error);
    res.status(500).json({
      enabled: false,
      reason: 'config load failed',
      marketplaceEnabled: false,
      hybridEnabled: false,
      serviceMarketplaceEnabled: false,
      serviceNegotiationEnabled: false,
      emergencyDisabled: false,
      canonicalServiceSlug: String(req.query.service || '').trim()
    });
  }
});

export default router;
