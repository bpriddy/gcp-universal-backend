/**
 * groups.router.ts — HTTP surface for the Google Groups → teams sync.
 *
 * Single endpoint, mirroring directory.router.ts:
 *   POST /cron — fire-and-forget. Returns 202 immediately, runs the
 *                full sync in the background, logs terminal state.
 *
 * Reachable by any internet caller (KNOWN DEBT, same as Directory's
 * /cron and Drive's /cron — Item 7b will add OIDC verification at the
 * gateway across all three in one pass).
 */

import { Router } from 'express';
import { runGroupsFullSync } from './groups.cron';
import { logger } from '../../../services/logger';

const router = Router();

router.post('/cron', (_req, res) => {
  res.status(202).json({ status: 'sync_started' });

  runGroupsFullSync()
    .then((result) => {
      logger.info(result, 'Google Groups cron sync completed');
    })
    .catch((err: unknown) => {
      logger.error({ err }, 'Google Groups cron sync failed');
    });
});

export default router;
