/**
 * drive.router.ts — Admin HTTP surface for Google Drive sync.
 *
 * Endpoints:
 *   POST /run-full-sync  — Admin button. Kicks off discover + scan every
 *                          linked account + scan every linked campaign.
 *                          Returns 202 + syncRunId immediately; full run
 *                          completes in the background. Refuses with 409
 *                          if a sync is already running.
 *   POST /cron           — Legacy alias kept for backwards compat; same
 *                          behavior as /run-full-sync. Will be retired
 *                          once the cron (Phase 5) calls /run-full-sync.
 */

import { Router } from 'express';
import { authenticate, requireAdmin } from '../../../middleware/authenticate';
import { logger } from '../../../services/logger';
import { SyncAlreadyRunningError, startFullSync } from './drive.runner';

const router = Router();

async function kickoffFullSync(): Promise<{ status: number; body: unknown }> {
  try {
    const { syncRunId, promise } = await startFullSync();
    // Fire-and-forget the run; the promise writes its own terminal state into
    // sync_runs. We only log unhandled rejections here so they don't silently
    // disappear if the runner itself throws before updating the row.
    promise.catch((err: unknown) => {
      logger.error({ err, syncRunId }, '[drive.router] full sync rejected outside runner');
    });
    return { status: 202, body: { status: 'sync_started', syncRunId } };
  } catch (err) {
    if (err instanceof SyncAlreadyRunningError) {
      return {
        status: 409,
        body: {
          code: 'SYNC_ALREADY_RUNNING',
          message: err.message,
          syncRunId: err.existingRunId,
        },
      };
    }
    throw err;
  }
}

router.post('/run-full-sync', authenticate, requireAdmin, async (_req, res, next) => {
  try {
    const { status, body } = await kickoffFullSync();
    res.status(status).json(body);
  } catch (err) {
    next(err);
  }
});

// Legacy alias — kept so existing callers (e.g. earlier stub cron) keep working.
router.post('/cron', authenticate, requireAdmin, async (_req, res, next) => {
  try {
    const { status, body } = await kickoffFullSync();
    res.status(status).json(body);
  } catch (err) {
    next(err);
  }
});

export default router;
