/**
 * groups.sync.ts — Apply Google Groups data to teams + team_members.
 *
 * Pattern (mirrors directory.sync.ts):
 *   1. Look up team via TeamExternalId (system='google_groups'). If found,
 *      diff core fields, write team_changes, update.
 *   2. Else fall back to lookup by name. If found, link via TeamExternalId
 *      (the team was probably created manually before the first sync) and
 *      proceed as in (1).
 *   3. Else create a new team + external ID + initial change rows.
 *   4. Sync members: resolve emails to staff_id where possible; rows that
 *      can't resolve are written as `unlinked=true` with the source email
 *      preserved so the admin UI can surface them.
 *   5. Apply the "managed set" pattern to member deletion: only delete
 *      rows where source='google_groups_sync'. Manually-added rows
 *      (source='manual') stay even if the corresponding member isn't
 *      in the Google Group.
 */

import { prisma } from '../../../config/database';
import { logger } from '../../../services/logger';
import type { DirectoryGroup, DirectoryMember } from './groups.client';

export const SYSTEM = 'google_groups';
export const SYNC_SOURCE = 'google_groups_sync';

// ── Types ────────────────────────────────────────────────────────────────────

export interface MemberSyncCounters {
  /** Members added with a resolved staff_id. */
  linkedAdded: number;
  /** Members added without a resolved staff_id (unlinked rows). */
  unlinkedAdded: number;
  /** Existing rows where the link state changed (e.g., previously unlinked, now resolved). */
  relinked: number;
  /** Sync-sourced rows removed because the member is no longer in the group. */
  removed: number;
  /** Manual rows preserved despite not appearing in the Google response. */
  manualPreserved: number;
}

export interface ApplyGroupResult {
  outcome: 'created' | 'updated' | 'unchanged';
  teamId: string;
  members: MemberSyncCounters;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Apply a single Google Group + its members to the teams + team_members tables.
 * Returns the team-level outcome plus per-member counters.
 */
export async function applyGroup(
  group: DirectoryGroup,
  members: DirectoryMember[],
): Promise<ApplyGroupResult> {
  if (!group.id) {
    throw new Error('Google Group missing id field');
  }
  if (!group.name) {
    throw new Error(`Google Group ${group.id} missing name field`);
  }

  const teamData = {
    name: group.name,
    description: group.description?.trim() || null,
  };

  // ── Look up team via external ID first ───────────────────────────────────
  const extId = await prisma.teamExternalId.findUnique({
    where: { system_externalId: { system: SYSTEM, externalId: group.id } },
    include: { team: true },
  });

  let outcome: 'created' | 'updated' | 'unchanged';
  let teamId: string;

  if (extId) {
    teamId = extId.teamId;
    outcome = await updateTeam(extId.team, teamData);
  } else {
    // Fall back to lookup by name (team may have been created manually
    // before the first sync). If found, link via external ID and update.
    const existingByName = await prisma.team.findUnique({
      where: { name: teamData.name },
    });
    if (existingByName) {
      await prisma.teamExternalId.create({
        data: {
          teamId: existingByName.id,
          system: SYSTEM,
          externalId: group.id,
        },
      });
      teamId = existingByName.id;
      outcome = await updateTeam(existingByName, teamData);
    } else {
      teamId = await createTeam(teamData, group.id);
      outcome = 'created';
    }
  }

  // ── Sync members ─────────────────────────────────────────────────────────
  const memberCounters = await syncGroupMembers(teamId, members);

  return { outcome, teamId, members: memberCounters };
}

// ── Team upsert ──────────────────────────────────────────────────────────────

async function createTeam(
  teamData: { name: string; description: string | null },
  externalId: string,
): Promise<string> {
  return prisma.$transaction(async (tx) => {
    const team = await tx.team.create({
      data: {
        name: teamData.name,
        description: teamData.description,
        // Groups sync doesn't set isActive=false on a new team; the group
        // existing IS the signal. Admin can flip isActive=false manually
        // if they want to deactivate without deleting.
      },
    });
    await tx.teamExternalId.create({
      data: { teamId: team.id, system: SYSTEM, externalId },
    });
    // Initial change rows for traceability — mirrors how the Directory
    // sync writes a "created" event into staff_changes for each new field.
    await tx.teamChange.createMany({
      data: [
        {
          teamId: team.id,
          property: 'name',
          valueText: teamData.name,
        },
        ...(teamData.description
          ? [
              {
                teamId: team.id,
                property: 'description',
                valueText: teamData.description,
              },
            ]
          : []),
      ],
    });
    return team.id;
  });
}

async function updateTeam(
  existing: { id: string; name: string; description: string | null },
  next: { name: string; description: string | null },
): Promise<'updated' | 'unchanged'> {
  const changes: { property: string; previousValueText: string | null; valueText: string | null }[] = [];

  if (existing.name !== next.name) {
    changes.push({
      property: 'name',
      previousValueText: existing.name,
      valueText: next.name,
    });
  }
  if ((existing.description ?? null) !== next.description) {
    changes.push({
      property: 'description',
      previousValueText: existing.description ?? null,
      valueText: next.description,
    });
  }

  if (changes.length === 0) return 'unchanged';

  await prisma.$transaction(async (tx) => {
    await tx.team.update({
      where: { id: existing.id },
      data: { name: next.name, description: next.description },
    });
    await tx.teamChange.createMany({
      data: changes.map((c) => ({
        teamId: existing.id,
        property: c.property,
        previousValueText: c.previousValueText,
        valueText: c.valueText,
      })),
    });
  });
  return 'updated';
}

// ── Member sync ──────────────────────────────────────────────────────────────

async function syncGroupMembers(
  teamId: string,
  members: DirectoryMember[],
): Promise<MemberSyncCounters> {
  const counters: MemberSyncCounters = {
    linkedAdded: 0,
    unlinkedAdded: 0,
    relinked: 0,
    removed: 0,
    manualPreserved: 0,
  };

  // Normalize member emails (lower-case, drop empties, dedupe).
  const targetEmails = new Set<string>();
  for (const m of members) {
    if (m.email) targetEmails.add(m.email.toLowerCase());
  }

  // Resolve emails → staff in one batched query so we don't issue N round-trips.
  const targetEmailList = [...targetEmails];
  const matchedStaff = targetEmailList.length
    ? await prisma.staff.findMany({
        where: { email: { in: targetEmailList } },
        select: { id: true, email: true },
      })
    : [];
  const emailToStaffId = new Map<string, string>();
  for (const s of matchedStaff) {
    emailToStaffId.set(s.email.toLowerCase(), s.id);
  }

  // Existing sync-sourced rows we may need to delete or relink.
  const existingSyncRows = await prisma.teamMember.findMany({
    where: { teamId, source: SYNC_SOURCE },
  });

  // Existing rows of any source — used to decide whether to insert
  // (avoid duplicating a manual row if it already covers this email/staff).
  const existingAnyRows = await prisma.teamMember.findMany({
    where: { teamId },
  });
  const existingByStaffId = new Map<string, typeof existingAnyRows[number]>();
  const existingBySourceEmail = new Map<string, typeof existingAnyRows[number]>();
  for (const r of existingAnyRows) {
    if (r.staffId) existingByStaffId.set(r.staffId, r);
    if (r.sourceEmail) existingBySourceEmail.set(r.sourceEmail.toLowerCase(), r);
  }

  // Track which sync-sourced rows we've "kept" so we can delete the rest.
  const keptSyncRowIds = new Set<string>();

  // ── Process each Google member ──────────────────────────────────────────
  for (const email of targetEmails) {
    const staffId = emailToStaffId.get(email);

    if (staffId) {
      // ── Linked path ─────────────────────────────────────────────────
      const existing = existingByStaffId.get(staffId);
      if (existing) {
        // Already present (manual or sync-sourced). Mark sync-sourced ones
        // as kept so we don't delete them in the cleanup pass. If the row
        // was a manual entry, we leave it alone — manual takes precedence.
        if (existing.source === SYNC_SOURCE) {
          keptSyncRowIds.add(existing.id);
          // If it was previously unlinked, mark relinked. (Edge case:
          // would only happen if a row was inserted with staff_id null
          // but somehow had a matching staff_id — shouldn't occur but
          // the index is here.)
          if (existing.unlinked) {
            await prisma.teamMember.update({
              where: { id: existing.id },
              data: { unlinked: false },
            });
            counters.relinked++;
          }
        }
        continue;
      }

      // Was there an unlinked row for this email? If yes, upgrade it
      // (set staffId, clear unlinked) instead of creating a new linked
      // row. This is the "admin provisioned the missing staff record"
      // path described in the PR.
      const unlinkedExisting = existingBySourceEmail.get(email);
      if (unlinkedExisting && !unlinkedExisting.staffId) {
        await prisma.teamMember.update({
          where: { id: unlinkedExisting.id },
          data: { staffId, unlinked: false },
        });
        keptSyncRowIds.add(unlinkedExisting.id);
        counters.relinked++;
        continue;
      }

      const created = await prisma.teamMember.create({
        data: {
          teamId,
          staffId,
          sourceEmail: email,
          source: SYNC_SOURCE,
          unlinked: false,
        },
      });
      keptSyncRowIds.add(created.id);
      counters.linkedAdded++;
    } else {
      // ── Unlinked path ────────────────────────────────────────────────
      const existing = existingBySourceEmail.get(email);
      if (existing) {
        if (existing.source === SYNC_SOURCE) keptSyncRowIds.add(existing.id);
        continue;
      }
      const created = await prisma.teamMember.create({
        data: {
          teamId,
          staffId: null,
          sourceEmail: email,
          source: SYNC_SOURCE,
          unlinked: true,
        },
      });
      keptSyncRowIds.add(created.id);
      counters.unlinkedAdded++;
    }
  }

  // ── Delete sync-sourced rows that were NOT kept ─────────────────────────
  // These are members who were in the group on a previous sync but aren't
  // anymore. Manual rows (source='manual') are never deleted by the sync.
  const toDelete = existingSyncRows.filter((r) => !keptSyncRowIds.has(r.id));
  if (toDelete.length > 0) {
    await prisma.teamMember.deleteMany({
      where: { id: { in: toDelete.map((r) => r.id) } },
    });
    counters.removed = toDelete.length;
  }

  // Count manually-preserved rows for visibility (manual rows whose
  // staff_id email isn't in the Google response — they "would have been
  // deleted" if we treated all rows as managed, but we don't).
  const manualOnlyRows = existingAnyRows.filter((r) => r.source === 'manual');
  for (const r of manualOnlyRows) {
    const matchEmail = r.sourceEmail?.toLowerCase();
    if (matchEmail && !targetEmails.has(matchEmail)) {
      counters.manualPreserved++;
    }
  }

  if (
    counters.linkedAdded + counters.unlinkedAdded + counters.removed + counters.relinked >
    0
  ) {
    logger.info(
      { teamId, ...counters },
      '[groups.sync] member changes',
    );
  }

  return counters;
}
