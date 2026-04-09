/**
 * directory.cron.ts — Full Google Directory → staff sync.
 *
 * Pipeline: fetch → classify → map → apply → log
 *
 * Non-person entries (groups, service accounts, external domains) are
 * filtered out at the classify step and recorded in the sync run log
 * with a human-readable reason.
 *
 * Run on a daily schedule via Cloud Scheduler → POST /integrations/google-directory/cron
 */

import { fetchAllDirectoryPeople } from './directory.client';
import { mapDirectoryPerson } from './directory.mapper';
import { applyDirectoryPerson } from './directory.sync';
import { classifyDirectoryEntry } from './directory.classifier';
import {
  startSyncRun,
  completeSyncRun,
  type SyncRunDetails,
  type SyncRunCounters,
  type SkipEntry,
  type ChangeEntry,
  type ErrorEntry,
} from '../sync-run.service';
import { logger } from '../../../services/logger';

// ── Types ────────────────────────────────────────────────────────────────────

export interface DirectorySyncResult {
  runId: string;
  counters: SyncRunCounters;
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function runDirectoryFullSync(): Promise<DirectorySyncResult> {
  const source = 'google_directory';
  const runId = await startSyncRun(source);
  logger.info({ runId }, 'Google Directory full sync: starting');

  const skipped: SkipEntry[] = [];
  const changes: ChangeEntry[] = [];
  const errors: ErrorEntry[] = [];

  let created = 0;
  let updated = 0;
  let unchanged = 0;

  try {
    const people = await fetchAllDirectoryPeople();
    logger.info({ count: people.length, runId }, 'Google Directory full sync: fetched profiles');

    for (const person of people) {
      const email = person.emailAddresses?.[0]?.value ?? '';
      const name = person.names?.[0]?.displayName ?? '';

      // ── Classify ────────────────────────────────────────────────────────
      const classification = classifyDirectoryEntry(email, name);

      if (classification.type === 'skipped') {
        skipped.push({
          email,
          name,
          reason: classification.reason,
          detail: classification.detail,
        });
        continue;
      }

      // ── Map ─────────────────────────────────────────────────────────────
      const mapped = mapDirectoryPerson(person);

      if (!mapped) {
        skipped.push({
          email,
          name,
          reason: 'unmappable',
          detail: 'mapper returned null (missing required fields)',
        });
        continue;
      }

      // ── Apply ───────────────────────────────────────────────────────────
      try {
        const result = await applyDirectoryPerson(mapped);

        if (result === 'created') {
          created++;
          changes.push({ email: mapped.staff.email, name: mapped.staff.fullName, action: 'created' });
        } else if (result === 'updated') {
          updated++;
          // The change details come from the sync layer — we record the top-level action here.
          // For granular diffs, the sync run details.changes entries get enriched below.
          changes.push({ email: mapped.staff.email, name: mapped.staff.fullName, action: 'updated' });
        } else {
          unchanged++;
        }
      } catch (err) {
        errors.push({
          email: mapped.staff.email,
          name: mapped.staff.fullName,
          error: err instanceof Error ? err.message : String(err),
        });
        logger.error(
          { err, resourceName: mapped.staff.resourceName, email: mapped.staff.email, runId },
          'Google Directory sync: failed to apply person',
        );
      }
    }

    const counters: SyncRunCounters = {
      totalScanned: people.length,
      created,
      updated,
      unchanged,
      skipped: skipped.length,
      errored: errors.length,
    };

    const details: SyncRunDetails = { skipped, changes, errors };
    const status = errors.length > 0 && created + updated + unchanged === 0 ? 'failed' : 'success';

    await completeSyncRun(runId, source, counters, details, status);
    logger.info({ runId, ...counters }, 'Google Directory full sync: complete');

    return { runId, counters };
  } catch (err) {
    // Top-level failure (e.g. API call failed)
    const counters: SyncRunCounters = {
      totalScanned: 0,
      created,
      updated,
      unchanged,
      skipped: skipped.length,
      errored: 1,
    };
    const details: SyncRunDetails = {
      skipped,
      changes,
      errors: [{ email: '', name: '', error: err instanceof Error ? err.message : String(err) }],
    };

    await completeSyncRun(runId, source, counters, details, 'failed');
    logger.error({ err, runId }, 'Google Directory full sync: fatal error');

    return { runId, counters };
  }
}
