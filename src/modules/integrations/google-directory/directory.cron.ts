/**
 * directory.cron.ts — Full Google Directory → staff sync.
 *
 * Pipeline: fetch → classify → map → apply → log
 *
 * Classification uses src/modules/staff-classifier (hard-filters + LLM).
 * Non-person entries are recorded in sync_runs.details.skipped with the
 * LLM's reason string when available.
 *
 * Run on a daily schedule via Cloud Scheduler → POST /integrations/google-directory/cron
 */

import { fetchAllDirectoryPeople } from './directory.client';
import { mapDirectoryPerson } from './directory.mapper';
import { applyDirectoryPerson } from './directory.sync';
import { classifyEntries } from '../../staff-classifier';
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

    // ── Classify the whole batch at once ─────────────────────────────────
    // The staff-classifier module handles hard-filters + LLM + sync-rule
    // overrides in one call. We preserve order so we can zip back to the
    // original Google People responses.
    const entries = people.map((p) => ({
      email: p.emailAddresses?.[0]?.value ?? '',
      displayName: p.names?.[0]?.displayName ?? '',
    }));

    const classifications = await classifyEntries(entries);
    logger.info(
      {
        runId,
        total: classifications.length,
        persons: classifications.filter((c) => c.kind === 'person').length,
        skipped: classifications.filter((c) => c.kind === 'skip').length,
      },
      'Google Directory full sync: classified',
    );

    for (let i = 0; i < people.length; i++) {
      const person = people[i]!;
      const classification = classifications[i]!;
      const email = classification.input.email;
      const name = classification.input.displayName;

      if (classification.kind === 'skip') {
        skipped.push({
          email,
          name,
          reason: classification.reason,
          detail: classification.detail,
          source: classification.source,
          ...(classification.confidence !== undefined
            ? { confidence: classification.confidence }
            : {}),
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
          source: 'hard_filter',
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
