/**
 * cleanup.ts — Data retention enforcement script
 *
 * Run as a Cloud Run Job on a nightly schedule via Cloud Scheduler.
 * Deletes rows that have exceeded their retention window across three tables.
 *
 * Retention policy:
 *   refresh_tokens   expired > 30 days ago, OR revoked > 7 days ago
 *   access_grants    revoked > 90 days ago, OR expired > 90 days ago
 *   access_requests  resolved (approved/denied) > 365 days ago
 *
 * The *_changes tables and audit_log are intentional long-term storage.
 * They are NOT cleaned up here — retention policy for those tables is
 * documented as: retain for the life of the related entity + 7 years.
 *
 * Exit codes:
 *   0 — success (Cloud Run Job marks execution as succeeded)
 *   1 — failure (Cloud Run Job marks execution as failed, triggers alert)
 */

import { PrismaClient } from '@prisma/client';
import { logger } from '../services/logger';

const prisma = new PrismaClient();

interface CleanupResult {
  table: string;
  rule: string;
  deleted: number;
}

async function run(): Promise<void> {
  logger.info('Data retention cleanup: starting');

  const results: CleanupResult[] = [];
  const now = new Date();

  // ── refresh_tokens ──────────────────────────────────────────────────────────
  // Expired tokens older than 30 days: token is invalid, hash serves no purpose.
  // Revoked tokens older than 7 days: family is dead, reuse detection window closed.

  const expiredTokenCutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const revokedTokenCutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const expiredTokens = await prisma.refreshToken.deleteMany({
    where: { expiresAt: { lt: expiredTokenCutoff }, revokedAt: null },
  });
  results.push({ table: 'refresh_tokens', rule: 'expired > 30d', deleted: expiredTokens.count });

  const revokedTokens = await prisma.refreshToken.deleteMany({
    where: { revokedAt: { lt: revokedTokenCutoff } },
  });
  results.push({ table: 'refresh_tokens', rule: 'revoked > 7d', deleted: revokedTokens.count });

  // ── access_grants ───────────────────────────────────────────────────────────
  // Revoked or expired grants older than 90 days.
  // By this point, audit_log will record the grant/revoke events (once that
  // work is complete), making the dead grant rows redundant.

  const grantCutoff = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);

  const revokedGrants = await prisma.accessGrant.deleteMany({
    where: { revokedAt: { lt: grantCutoff } },
  });
  results.push({ table: 'access_grants', rule: 'revoked > 90d', deleted: revokedGrants.count });

  const expiredGrants = await prisma.accessGrant.deleteMany({
    where: {
      revokedAt: null,
      expiresAt: { lt: grantCutoff },
    },
  });
  results.push({ table: 'access_grants', rule: 'expired > 90d', deleted: expiredGrants.count });

  // ── access_requests ─────────────────────────────────────────────────────────
  // Resolved requests older than 365 days. These are audit-relevant so we
  // keep them for a full year before purging.

  const requestCutoff = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);

  const resolvedRequests = await prisma.accessRequest.deleteMany({
    where: {
      status: { in: ['approved', 'denied'] },
      reviewedAt: { lt: requestCutoff },
    },
  });
  results.push({ table: 'access_requests', rule: 'resolved > 365d', deleted: resolvedRequests.count });

  // ── Summary ─────────────────────────────────────────────────────────────────

  const totalDeleted = results.reduce((sum, r) => sum + r.deleted, 0);

  for (const r of results) {
    logger.info({ table: r.table, rule: r.rule, deleted: r.deleted }, 'Cleanup rule complete');
  }

  logger.info({ totalDeleted, rules: results.length }, 'Data retention cleanup: complete');
}

run()
  .catch((err: unknown) => {
    logger.error({ err }, 'Data retention cleanup: fatal error');
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
