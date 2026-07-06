import { Router, Request, Response } from 'express';
import {
  AppVersionService,
  compareSemanticVersions,
  normalisePlatform,
  versionFieldsForPlatform
} from '../services/app-version.service';

const router = Router();

router.get('/version', async (req: Request, res: Response) => {
  try {
    const config = await AppVersionService.getConfig();
    const platform = normalisePlatform(req.query.platform);
    const clientVersion = String(req.query.version || '').trim();
    const fields = versionFieldsForPlatform(config, platform);
    const belowMinimum = clientVersion
      ? compareSemanticVersions(clientVersion, fields.minimumVersion) < 0
      : false;
    const severityBlocks = config.update_severity === 'required' || config.update_severity === 'critical';
    const updateRequired = belowMinimum || config.update_required || config.update_severity === 'critical';

    res.json({
      ok: true,
      currentVersion: fields.currentVersion,
      minimumVersion: fields.minimumVersion,
      updateRequired,
      severity: config.update_severity,
      title: config.update_title,
      message: config.update_message,
      releaseNotes: config.release_notes,
      platform,
      role: String(req.query.role || '').trim() || null,
      updateUrl: fields.updateUrl,
      webReloadRequired: config.web_reload_required,
      canDismiss: !updateRequired && !severityBlocks,
      belowMinimum
    });
  } catch (error: any) {
    res.status(500).json({ ok: false, error: error?.message || 'Unable to check app version.' });
  }
});

export default router;
