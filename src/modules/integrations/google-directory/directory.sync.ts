/**
 * directory.sync.ts — Apply Google Directory data to the staff table.
 *
 * Sync pattern:
 *   1. Look up staff by external ID (system: 'google_directory')
 *   2. If new → create staff + external ID + change rows + metadata
 *   3. If existing → diff core fields, write change rows (with previous values),
 *      update only what changed, sync metadata
 *
 * Metadata (phones, locations, relations, skills, bios, etc.) is managed as
 * a "directory owns it" model: on each sync the set of directory-sourced metadata
 * entries is replaced wholesale. Manually-added metadata (source != google_directory)
 * is never touched.
 */

import { prisma } from '../../../config/database';
import { STAFF_PII_PROPERTIES } from '../../org/staff-pii-properties';
import { logger } from '../../../services/logger';
import type { MappedDirectoryStaff, DirectoryMetadataEntry, MappedDirectoryResult } from './directory.mapper';

// ── Types ────────────────────────────────────────────────────────────────────

export type SyncSource = 'google_directory_sync';

interface ChangeRow {
  staffId: string;
  property: string;
  previousValueText?: string | null;
  previousValueUuid?: string | null;
  previousValueDate?: Date | null;
  valueText?: string | null;
  valueUuid?: string | null;
  valueDate?: Date | null;
  valueIsPii: boolean;
  source: SyncSource;
}

function changeRow(
  staffId: string,
  property: string,
  values: Pick<ChangeRow, 'previousValueText' | 'previousValueUuid' | 'previousValueDate' | 'valueText' | 'valueUuid' | 'valueDate'>,
  source: SyncSource,
): ChangeRow {
  return { staffId, property, ...values, valueIsPii: STAFF_PII_PROPERTIES.has(property), source };
}

/**
 * Metadata tag stored in the JSON `metadata` column of staff_metadata rows
 * created by this sync. Used to identify which rows are "owned" by the sync
 * so we can replace them on each run without touching manually-created entries.
 */
const SYNC_SOURCE_TAG = 'google_directory_sync';

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Apply a single directory person to the staff table.
 * Creates or updates the staff record and syncs metadata.
 */
export async function applyDirectoryPerson(
  mapped: MappedDirectoryResult,
  source: SyncSource = 'google_directory_sync',
): Promise<'created' | 'updated' | 'unchanged'> {
  const { staff: staffData, metadata } = mapped;

  // Look up existing staff via Google Directory external ID
  const extId = await prisma.staffExternalId.findUnique({
    where: {
      system_externalId: {
        system: 'google_directory',
        externalId: staffData.resourceName,
      },
    },
    include: { staff: true },
  });

  if (!extId) {
    // Also check if a staff record with this email already exists (e.g. created by admin).
    // If so, link it via external ID rather than creating a duplicate.
    const existingByEmail = await prisma.staff.findUnique({
      where: { email: staffData.email },
    });

    if (existingByEmail) {
      // Link existing staff to directory and update
      await prisma.staffExternalId.create({
        data: {
          staffId: existingByEmail.id,
          system: 'google_directory',
          externalId: staffData.resourceName,
        },
      });
      const result = await updateStaff(existingByEmail, staffData, source);
      await syncMetadata(existingByEmail.id, metadata);
      return result;
    }

    await createStaff(staffData, metadata, source);
    return 'created';
  }

  const result = await updateStaff(extId.staff, staffData, source);
  await syncMetadata(extId.staff.id, metadata);
  return result;
}

// ── Internal: Create ─────────────────────────────────────────────────────────

async function createStaff(
  mapped: MappedDirectoryStaff,
  metadata: DirectoryMetadataEntry[],
  source: SyncSource,
): Promise<void> {
  const staff = await prisma.staff.create({
    data: {
      fullName: mapped.fullName,
      email: mapped.email,
      title: mapped.title,
      department: mapped.department,
      status: mapped.status,
      startedAt: new Date(), // no start date from directory; default to sync date
      externalIds: {
        create: {
          system: 'google_directory',
          externalId: mapped.resourceName,
        },
      },
    },
  });

  // Write initial change rows for audit trail
  const changeRows: ChangeRow[] = [
    changeRow(staff.id, 'full_name', { valueText: mapped.fullName }, source),
    changeRow(staff.id, 'email', { valueText: mapped.email }, source),
    changeRow(staff.id, 'status', { valueText: mapped.status }, source),
  ];

  if (mapped.title) {
    changeRows.push(changeRow(staff.id, 'title', { valueText: mapped.title }, source));
  }
  if (mapped.department) {
    changeRows.push(changeRow(staff.id, 'department', { valueText: mapped.department }, source));
  }

  await prisma.staffChange.createMany({ data: changeRows });

  // Write metadata entries
  await syncMetadata(staff.id, metadata);
}

// ── Internal: Update ─────────────────────────────────────────────────────────

async function updateStaff(
  existing: {
    id: string;
    fullName: string;
    email: string;
    title: string | null;
    department: string | null;
    status: string;
  },
  mapped: MappedDirectoryStaff,
  source: SyncSource,
): Promise<'updated' | 'unchanged'> {
  const changes: ChangeRow[] = [];
  const update: Record<string, unknown> = {};

  if (mapped.fullName !== existing.fullName) {
    changes.push(changeRow(existing.id, 'full_name', { previousValueText: existing.fullName, valueText: mapped.fullName }, source));
    update.fullName = mapped.fullName;
  }

  if (mapped.email !== existing.email) {
    changes.push(changeRow(existing.id, 'email', { previousValueText: existing.email, valueText: mapped.email }, source));
    update.email = mapped.email;
  }

  if ((mapped.title ?? null) !== existing.title) {
    changes.push(changeRow(existing.id, 'title', { previousValueText: existing.title, valueText: mapped.title }, source));
    update.title = mapped.title;
  }

  if ((mapped.department ?? null) !== existing.department) {
    changes.push(changeRow(existing.id, 'department', { previousValueText: existing.department, valueText: mapped.department }, source));
    update.department = mapped.department;
  }

  if (mapped.status !== existing.status) {
    changes.push(changeRow(existing.id, 'status', { previousValueText: existing.status, valueText: mapped.status }, source));
    update.status = mapped.status;
  }

  if (changes.length === 0) return 'unchanged';

  await prisma.$transaction([
    prisma.staff.update({ where: { id: existing.id }, data: update }),
    prisma.staffChange.createMany({ data: changes }),
  ]);

  return 'updated';
}

// ── Internal: Metadata sync ──────────────────────────────────────────────────

/**
 * Replace all directory-sourced metadata for a staff member.
 *
 * Strategy: delete all existing metadata where metadata JSON contains
 * { source: "google_directory_sync" }, then insert the new set.
 * This preserves manually-created metadata entries.
 */
async function syncMetadata(
  staffId: string,
  entries: DirectoryMetadataEntry[],
): Promise<void> {
  if (entries.length === 0) {
    // Still clean up any old directory-sourced entries
    await deleteDirectoryMetadata(staffId);
    return;
  }

  const creates = entries.map((entry) => ({
    staffId,
    type: entry.type,
    label: entry.label,
    value: entry.value?.slice(0, 256) ?? null,
    notes: entry.notes?.slice(0, 4000) ?? null,
    metadata: {
      ...(entry.metadata ?? {}),
      source: SYNC_SOURCE_TAG,
    },
    isFeatured: false,
  }));

  await prisma.$transaction([
    // Delete old directory-sourced metadata
    ...deleteDirectoryMetadataOps(staffId),
    // Insert new
    prisma.staffMetadata.createMany({ data: creates }),
  ]);
}

function deleteDirectoryMetadataOps(staffId: string) {
  // Prisma doesn't support JSON field filtering in deleteMany natively,
  // so we use raw SQL for the WHERE clause on the JSONB metadata column.
  return [
    prisma.$executeRaw`
      DELETE FROM staff_metadata
      WHERE staff_id = ${staffId}::uuid
        AND metadata->>'source' = ${SYNC_SOURCE_TAG}
    `,
  ];
}

async function deleteDirectoryMetadata(staffId: string): Promise<void> {
  await prisma.$executeRaw`
    DELETE FROM staff_metadata
    WHERE staff_id = ${staffId}::uuid
      AND metadata->>'source' = ${SYNC_SOURCE_TAG}
  `;
}
