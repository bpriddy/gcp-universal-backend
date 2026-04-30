/**
 * groups.cron.ts — Full Google Groups → teams sync.
 *
 * Pipeline: fetch all groups → for each group, fetch members → apply.
 *
 * Mirrors directory.cron.ts but without an LLM classifier — Workspace
 * Groups are explicit. (No "is this a team?" question to answer; if it's
 * a group in the directory, it's a team in our model.)
 *
 * Greedy: every group becomes a team. No filtering. If certain groups
 * (distribution lists, etc.) shouldn't be teams, an admin can flip
 * isActive=false on the team manually after the first sync.
 *
 * Per-member resolution: emails are matched to existing staff via lookup;
 * unmatched members are recorded as `unlinked=true` rows so the admin UI
 * can surface them for fix. The sync does NOT create staff records — that
 * stays the Directory sync's job.
 *
 * Run on a daily schedule via Cloud Scheduler →
 *   POST /integrations/google-groups/cron
 */

import { config } from '../../../config/env';
import { fetchAllGroups, fetchGroupMembers } from './groups.client';
import { applyGroup } from './groups.sync';
import {
  startSyncRun,
  completeSyncRun,
  type SyncRunCounters,
  type SyncRunDetails,
  type ChangeEntry,
  type ErrorEntry,
} from '../sync-run.service';
import { logger } from '../../../services/logger';

export interface GroupsSyncResult {
  runId: string;
  counters: SyncRunCounters;
}

export async function runGroupsFullSync(): Promise<GroupsSyncResult> {
  const source = 'google_groups';
  const runId = await startSyncRun(source);
  logger.info({ runId }, 'Google Groups full sync: starting');

  const changes: ChangeEntry[] = [];
  const errors: ErrorEntry[] = [];

  let created = 0;
  let updated = 0;
  let unchanged = 0;

  // Aggregate member counters across all groups for the summary block.
  const memberTotals = {
    linkedAdded: 0,
    unlinkedAdded: 0,
    relinked: 0,
    removed: 0,
    manualPreserved: 0,
  };

  let groups: Awaited<ReturnType<typeof fetchAllGroups>>;
  try {
    groups = await fetchAllGroups();
  } catch (err) {
    const counters: SyncRunCounters = {
      totalScanned: 0,
      created: 0,
      updated: 0,
      unchanged: 0,
      skipped: 0,
      errored: 1,
    };
    const details: SyncRunDetails = {
      skipped: [],
      changes: [],
      errors: [
        {
          email: '',
          name: '',
          error: err instanceof Error ? err.message : String(err),
        },
      ],
    };
    await completeSyncRun(runId, source, counters, details, 'failed');
    logger.error({ err, runId }, 'Google Groups full sync: groups.list failed');
    return { runId, counters };
  }

  for (const group of groups) {
    const groupName = group.name ?? group.email ?? group.id ?? '<unknown>';

    let members: Awaited<ReturnType<typeof fetchGroupMembers>>;
    try {
      if (!group.id) throw new Error('group missing id');
      members = await fetchGroupMembers(group.id);
    } catch (err) {
      errors.push({
        email: group.email ?? '',
        name: groupName,
        error: `members.list failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      logger.error({ err, groupId: group.id, runId }, '[groups.cron] members.list failed');
      // Pace + continue — one group's member-list failure shouldn't halt the whole sync.
      await pace(config.GOOGLE_GROUPS_DELAY_BETWEEN_GROUPS_MS);
      continue;
    }

    try {
      const result = await applyGroup(group, members);
      memberTotals.linkedAdded += result.members.linkedAdded;
      memberTotals.unlinkedAdded += result.members.unlinkedAdded;
      memberTotals.relinked += result.members.relinked;
      memberTotals.removed += result.members.removed;
      memberTotals.manualPreserved += result.members.manualPreserved;

      if (result.outcome === 'created') {
        created++;
        changes.push({
          email: group.email ?? '',
          name: groupName,
          action: 'created',
        });
      } else if (result.outcome === 'updated') {
        updated++;
        changes.push({
          email: group.email ?? '',
          name: groupName,
          action: 'updated',
        });
      } else {
        unchanged++;
      }
    } catch (err) {
      errors.push({
        email: group.email ?? '',
        name: groupName,
        error: err instanceof Error ? err.message : String(err),
      });
      logger.error(
        { err, groupId: group.id, name: groupName, runId },
        '[groups.cron] applyGroup failed',
      );
    }

    await pace(config.GOOGLE_GROUPS_DELAY_BETWEEN_GROUPS_MS);
  }

  const counters: SyncRunCounters = {
    totalScanned: groups.length,
    created,
    updated,
    unchanged,
    skipped: 0, // greedy ingest — no skip path today
    errored: errors.length,
  };
  const details: SyncRunDetails = {
    skipped: [],
    changes,
    errors,
    // Stash member-level totals in the existing details JSON. Not part
    // of SyncRunDetails' typed shape but the column is JSON; the admin
    // UI's run detail page reads details freely.
    ...({ memberTotals } as Record<string, unknown>),
  };
  const status =
    errors.length > 0 && created + updated + unchanged === 0 ? 'failed' : 'success';

  await completeSyncRun(runId, source, counters, details, status);
  logger.info(
    { runId, ...counters, ...memberTotals },
    'Google Groups full sync: complete',
  );

  return { runId, counters };
}

function pace(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}
