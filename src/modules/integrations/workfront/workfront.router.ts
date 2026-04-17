import { Router } from 'express';
import { runWorkfrontFullSync } from './workfront.cron';
import { logger } from '../../../services/logger';

const router = Router();

/**
 * POST /integrations/workfront/cron
 *
 * Trigger a full Workfront → accounts/campaigns sync.
 * Intended to be called by Cloud Scheduler on a daily schedule.
 */
router.post('/cron', (_req, res) => {
  res.status(202).json({ status: 'sync_started' });

  runWorkfrontFullSync()
    .then((result) => { logger.info(result, 'Workfront cron sync completed'); })
    .catch((err: unknown) => { logger.error({ err }, 'Workfront cron sync failed'); });
});

export default router;
