/**
 * trigger-check.ts — Startup check for append-only / immutability triggers.
 *
 * During development these triggers are disabled for flexibility.
 * This check runs at startup and logs a WARN for each missing trigger
 * so we don't forget to re-enable them before production go-live.
 */

import { prisma } from './database';
import { logger } from '../services/logger';

/**
 * Triggers that MUST exist in production. Each entry is [trigger_name, table_name].
 */
const REQUIRED_TRIGGERS: [string, string][] = [
  ['account_changes_immutable', 'account_changes'],
  ['campaign_changes_immutable', 'campaign_changes'],
  ['office_changes_immutable', 'office_changes'],
  ['team_changes_immutable', 'team_changes'],
  ['staff_changes_immutable', 'staff_changes'],
  ['trg_audit_log_immutable', 'audit_log'],
  ['users_no_delete', 'users'],
  ['staff_no_delete', 'staff'],
];

export async function checkImmutabilityTriggers(): Promise<void> {
  try {
    const result = await prisma.$queryRaw<{ trigger_name: string; event_object_table: string }[]>`
      SELECT trigger_name, event_object_table
      FROM information_schema.triggers
      WHERE trigger_schema = 'public'
        AND trigger_name = ANY(${REQUIRED_TRIGGERS.map(([name]) => name)})
    `;

    const existingTriggers = new Set(result.map((r) => r.trigger_name));
    const missing = REQUIRED_TRIGGERS.filter(([name]) => !existingTriggers.has(name));

    if (missing.length > 0) {
      logger.warn(
        {
          missingTriggers: missing.map(([name, table]) => `${name} ON ${table}`),
          count: missing.length,
        },
        '⚠️  IMMUTABILITY TRIGGERS MISSING — These must be re-enabled before production go-live. ' +
        'Change-log tables and audit_log are currently mutable.',
      );
    } else {
      logger.info('All immutability triggers are present');
    }
  } catch (err) {
    // Don't block startup if the check fails (e.g. DB not yet connected)
    logger.warn({ err }, 'Could not verify immutability triggers (DB may not be connected yet)');
  }
}
