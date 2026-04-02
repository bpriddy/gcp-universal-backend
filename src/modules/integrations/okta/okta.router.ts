import { Router } from 'express';
import { handleOktaChallenge, handleOktaWebhook } from './okta.webhook';
import { runOktaFullSync } from './okta.cron';
import { logger } from '../../../services/logger';

const router = Router();

// ── Event Hook endpoints ──────────────────────────────────────────────────────

// GET — one-time Okta verification challenge
router.get('/webhook', handleOktaChallenge);

// POST — live event delivery from Okta Event Hooks
router.post('/webhook', handleOktaWebhook);

// ── Cron / Cloud Run Job endpoint ─────────────────────────────────────────────

/**
 * POST /integrations/okta/cron
 *
 * Trigger a full Okta sync. Intended to be called by Cloud Scheduler or a
 * Cloud Run Job on a daily schedule. Protect this endpoint with network policy
 * or a shared secret header in production.
 */
router.post('/cron', (_req, res) => {
  // Fire and forget — respond immediately so Cloud Run doesn't mark the job as timed out
  res.status(202).json({ status: 'sync_started' });

  runOktaFullSync()
    .then((result) => {
      logger.info(result, 'Okta cron sync completed');
    })
    .catch((err: unknown) => {
      logger.error({ err }, 'Okta cron sync failed');
    });
});

export default router;
