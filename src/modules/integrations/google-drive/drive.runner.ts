/**
 * drive.runner.ts — Full Drive sync orchestrator.
 *
 * What a "full sync" does, in order:
 *   1. Create a sync_runs row (source=google_drive, status=running).
 *   2. discoverNewEntities() — scan the shared-drive root for folders that
 *      don't yet map to an account/campaign row; emit new_entity proposals.
 *   3. For every account with drive_folder_id set — scanEntity() on it.
 *      Delta snapshots skip unchanged files automatically.
 *   4. For every campaign with drive_folder_id set — scanEntity() on it.
 *   5. notifyReviewers() — group new proposals by owner, email each a magic
 *      link. Only proposals created in this run (not-yet-notified) get picked
 *      up. Failure here does not fail the run (proposals remain in DB).
 *   6. Finalize the sync_run: status=success/failed, durationMs, summary JSON.
 *
 * Pacing: env-tunable delays between entities so a cold first run doesn't
 * burn a day's Gemini quota in 10 minutes. DRIVE_DELAY_BETWEEN_ACCOUNTS_MS
 * and DRIVE_DELAY_BETWEEN_CAMPAIGNS_MS — defaults 5s / 2s.
 *
 * Concurrency guard: we refuse to start a new full sync if one is already
 * running. `sync_runs` table is the source of truth.
 */

import { config } from '../../../config/env';
import { prisma } from '../../../config/database';
import { logger } from '../../../services/logger';
import { discoverNewEntities } from './drive.discover';
import { notifyReviewers } from './drive.notify';
import { scanEntity, type ScanEntityResult } from './drive.orchestrator';

export interface RunFullSyncResult {
  syncRunId: string;
  discover: {
    accountsProposed: number;
    campaignsProposed: number;
    foldersSkipped: number;
  };
  accountsScanned: number;
  campaignsScanned: number;
  proposalsCreated: number;
  notesWritten: number;
  ambiguousWritten: number;
  notify: {
    ownersEmailed: number;
    proposalsNotified: number;
    orphansLogged: number;
  };
  errors: number;
  durationMs: number;
}

export class SyncAlreadyRunningError extends Error {
  constructor(public readonly existingRunId: string) {
    super(`A Drive sync is already running (id=${existingRunId})`);
    this.name = 'SyncAlreadyRunningError';
  }
}

/**
 * Start a full sync. Creates the sync_runs row synchronously (so the caller
 * can return the id immediately) then returns a promise that resolves when
 * the full run finishes. Endpoint handlers typically await only the id
 * creation and let the promise run in the background.
 */
export async function startFullSync(): Promise<{
  syncRunId: string;
  promise: Promise<RunFullSyncResult>;
}> {
  // Refuse if one is already in flight.
  const inFlight = await prisma.syncRun.findFirst({
    where: { source: 'google_drive', status: 'running' },
    orderBy: { startedAt: 'desc' },
  });
  if (inFlight) {
    throw new SyncAlreadyRunningError(inFlight.id);
  }

  const run = await prisma.syncRun.create({
    data: { source: 'google_drive', status: 'running' },
  });
  logger.info({ syncRunId: run.id }, '[drive.runner] full sync started');

  const promise = executeFullSync(run.id);
  return { syncRunId: run.id, promise };
}

async function executeFullSync(syncRunId: string): Promise<RunFullSyncResult> {
  const startedAt = Date.now();
  const totals = {
    accountsProposed: 0,
    campaignsProposed: 0,
    foldersSkipped: 0,
    accountsScanned: 0,
    campaignsScanned: 0,
    proposalsCreated: 0,
    notesWritten: 0,
    ambiguousWritten: 0,
    ownersEmailed: 0,
    proposalsNotified: 0,
    orphansLogged: 0,
    errors: 0,
  };

  try {
    // ── Phase 1: Discovery ────────────────────────────────────────────────
    const discover = await discoverNewEntities({ syncRunId });
    totals.accountsProposed = discover.accountsProposed;
    totals.campaignsProposed = discover.campaignsProposed;
    totals.foldersSkipped = discover.foldersSkipped;

    // ── Phase 2: Linked accounts ──────────────────────────────────────────
    const accounts = await prisma.account.findMany({
      where: { driveFolderId: { not: null } },
      select: { id: true, name: true },
    });
    for (const account of accounts) {
      try {
        const res = await scanEntity({
          entityType: 'account',
          entityId: account.id,
          syncRunId,
        });
        tallyScanResult(totals, res);
        totals.accountsScanned++;
      } catch (err) {
        totals.errors++;
        logger.error({ err, accountId: account.id }, '[drive.runner] scanEntity(account) failed');
      }
      await pace(config.DRIVE_DELAY_BETWEEN_ACCOUNTS_MS);
    }

    // ── Phase 3: Linked campaigns ─────────────────────────────────────────
    const campaigns = await prisma.campaign.findMany({
      where: { driveFolderId: { not: null } },
      select: { id: true, name: true, accountId: true },
    });
    for (const campaign of campaigns) {
      try {
        const res = await scanEntity({
          entityType: 'campaign',
          entityId: campaign.id,
          syncRunId,
          parentAccountId: campaign.accountId,
        });
        tallyScanResult(totals, res);
        totals.campaignsScanned++;
      } catch (err) {
        totals.errors++;
        logger.error({ err, campaignId: campaign.id }, '[drive.runner] scanEntity(campaign) failed');
      }
      await pace(config.DRIVE_DELAY_BETWEEN_CAMPAIGNS_MS);
    }

    // ── Phase 4: Notify reviewers ────────────────────────────────────────
    // Scoped to this run's proposals — proposals from prior runs that still
    // sit unnotified (e.g. after a past dispatch failure) are picked up by
    // POST /notify, not by each run, to avoid unexpected re-notification
    // surges. Failure here is logged and counted but does not fail the run:
    // proposals stay in DB and the admin can retry via POST /notify.
    try {
      const notify = await notifyReviewers({ syncRunId });
      totals.ownersEmailed = notify.ownersEmailed;
      totals.proposalsNotified = notify.proposalsNotified;
      totals.orphansLogged = notify.orphansLogged;
    } catch (err) {
      totals.errors++;
      logger.error({ err, syncRunId }, '[drive.runner] notifyReviewers failed');
    }

    const durationMs = Date.now() - startedAt;
    const summary = {
      discover: {
        accountsProposed: totals.accountsProposed,
        campaignsProposed: totals.campaignsProposed,
        foldersSkipped: totals.foldersSkipped,
      },
      accountsScanned: totals.accountsScanned,
      campaignsScanned: totals.campaignsScanned,
      proposalsCreated: totals.proposalsCreated,
      notesWritten: totals.notesWritten,
      ambiguousWritten: totals.ambiguousWritten,
      notify: {
        ownersEmailed: totals.ownersEmailed,
        proposalsNotified: totals.proposalsNotified,
        orphansLogged: totals.orphansLogged,
      },
      errors: totals.errors,
      durationMs,
    };

    await prisma.syncRun.update({
      where: { id: syncRunId },
      data: {
        // sync_runs.status is 'running' | 'success' | 'failed'. Partial errors
        // are visible via the `errored` counter; we only flip to 'failed' on
        // a hard exception (caught below).
        status: 'success',
        completedAt: new Date(),
        durationMs,
        totalScanned: totals.accountsScanned + totals.campaignsScanned,
        updated: totals.proposalsCreated,
        errored: totals.errors,
        summary: JSON.stringify(summary, null, 2),
      },
    });

    logger.info({ syncRunId, ...summary }, '[drive.runner] full sync complete');

    return {
      syncRunId,
      discover: {
        accountsProposed: totals.accountsProposed,
        campaignsProposed: totals.campaignsProposed,
        foldersSkipped: totals.foldersSkipped,
      },
      accountsScanned: totals.accountsScanned,
      campaignsScanned: totals.campaignsScanned,
      proposalsCreated: totals.proposalsCreated,
      notesWritten: totals.notesWritten,
      ambiguousWritten: totals.ambiguousWritten,
      notify: {
        ownersEmailed: totals.ownersEmailed,
        proposalsNotified: totals.proposalsNotified,
        orphansLogged: totals.orphansLogged,
      },
      errors: totals.errors,
      durationMs,
    };
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    logger.error({ err, syncRunId }, '[drive.runner] full sync failed hard');
    await prisma.syncRun.update({
      where: { id: syncRunId },
      data: {
        status: 'failed',
        completedAt: new Date(),
        durationMs,
        summary: err instanceof Error ? err.message : String(err),
      },
    });
    throw err;
  }
}

function tallyScanResult(
  totals: { proposalsCreated: number; notesWritten: number; ambiguousWritten: number; errors: number },
  res: ScanEntityResult,
): void {
  totals.proposalsCreated += res.proposalsCreated;
  totals.notesWritten += res.notesWritten;
  totals.ambiguousWritten += res.ambiguousWritten;
  totals.errors += res.scan.errors;
}

function pace(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}
