import { Router } from 'express';
import { runDirectoryFullSync } from './directory.cron';
import { logger } from '../../../services/logger';
import { prisma } from '../../../config/database';

const router = Router();

/**
 * POST /integrations/google-directory/cron
 *
 * Trigger a full Google Directory → staff sync.
 * Intended to be called by Cloud Scheduler on a daily schedule.
 * Protect this endpoint with network policy or auth in production.
 */
router.post('/cron', (_req, res) => {
  // Fire and forget — respond immediately so Cloud Run doesn't time out
  res.status(202).json({ status: 'sync_started' });

  runDirectoryFullSync()
    .then((result) => {
      logger.info(result, 'Google Directory cron sync completed');
    })
    .catch((err: unknown) => {
      logger.error({ err }, 'Google Directory cron sync failed');
    });
});

export default router;
