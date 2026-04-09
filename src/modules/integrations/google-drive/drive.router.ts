import { Router } from 'express';
import { runDriveSync } from './drive.sync';
import { logger } from '../../../services/logger';

const router = Router();

/**
 * POST /integrations/google-drive/cron
 *
 * Trigger a Google Drive → campaign state extraction.
 * Stub until folder conventions are defined.
 */
router.post('/cron', (_req, res) => {
  res.status(202).json({ status: 'sync_started' });

  runDriveSync()
    .then((result) => { logger.info(result, 'Google Drive sync completed'); })
    .catch((err: unknown) => { logger.error({ err }, 'Google Drive sync failed'); });
});

export default router;
