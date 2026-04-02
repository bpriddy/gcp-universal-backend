import { fetchAllOktaUsers } from './okta.client';
import { applyOktaUser } from './okta.sync';
import { logger } from '../../../services/logger';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SyncResult {
  processed: number;
  skipped: number;
  errors: number;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Full Okta → staff sync.
 *
 * Fetches all relevant Okta users (ACTIVE / SUSPENDED / DEPROVISIONED) and runs
 * applyOktaUser for each one. Records are created or diffed individually; only
 * actual changes produce change-log rows.
 *
 * Run this on a schedule (e.g. Cloud Scheduler → Cloud Run Job, once per day).
 * For real-time updates, the webhook handler in okta.webhook.ts complements this.
 */
export async function runOktaFullSync(): Promise<SyncResult> {
  logger.info('Okta full sync: starting');

  const users = await fetchAllOktaUsers();
  logger.info({ count: users.length }, 'Okta full sync: fetched users from Okta');

  let processed = 0;
  let skipped = 0;
  let errors = 0;

  for (const user of users) {
    // STAGED / PROVISIONED are skipped inside applyOktaUser, but count them here for visibility
    if (user.status === 'STAGED' || user.status === 'PROVISIONED') {
      skipped++;
      continue;
    }

    try {
      await applyOktaUser(user, 'okta_sync');
      processed++;
    } catch (err) {
      errors++;
      logger.error({ err, oktaId: user.id, status: user.status }, 'Okta sync: failed to apply user');
    }
  }

  logger.info({ processed, skipped, errors }, 'Okta full sync: complete');
  return { processed, skipped, errors };
}
