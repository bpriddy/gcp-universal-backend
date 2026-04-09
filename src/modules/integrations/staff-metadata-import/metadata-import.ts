/**
 * metadata-import.ts — Batch import staff metadata from CSV/JSON.
 *
 * Two ingestion paths:
 *   1. Batch file — CSV or JSON array uploaded or read from a known location
 *   2. Google Forms — poll a response sheet on a schedule (future)
 *
 * Metadata rows are matched to staff by email. Duplicates (same staff +
 * type + label) are skipped unless the value has changed.
 */

import { prisma } from '../../../config/database';
import { logger } from '../../../services/logger';

// ── Types ────────────────────────────────────────────────────────────────────

export interface MetadataImportRow {
  /** Staff email — used to match to a staff record */
  email: string;
  /** Metadata category — e.g. "skill", "interest", "certification", "language" */
  type: string;
  /** Specific label — e.g. "React", "Brand Strategy", "PMP" */
  label: string;
  /** Optional value — e.g. proficiency level, issuing body */
  value?: string | null;
  /** Optional notes */
  notes?: string | null;
  /** Whether this entry should be featured on the profile */
  isFeatured?: boolean;
}

export interface MetadataImportResult {
  total: number;
  created: number;
  skipped: number;
  staffNotFound: number;
  errors: number;
}

const IMPORT_SOURCE_TAG = 'metadata_import';

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Import a batch of metadata entries.
 *
 * For each row:
 *   1. Resolve staff by email
 *   2. Check if a matching entry already exists (same staff + type + label)
 *   3. If exists with same value → skip
 *   4. If exists with different value → update
 *   5. If new → create
 */
export async function importMetadataBatch(
  rows: MetadataImportRow[],
): Promise<MetadataImportResult> {
  logger.info({ count: rows.length }, 'Metadata import: starting batch');

  let created = 0;
  let skipped = 0;
  let staffNotFound = 0;
  let errors = 0;

  for (const row of rows) {
    try {
      const staff = await prisma.staff.findUnique({
        where: { email: row.email.toLowerCase().trim() },
        select: { id: true },
      });

      if (!staff) {
        staffNotFound++;
        logger.warn({ email: row.email }, 'Metadata import: staff not found');
        continue;
      }

      // Check for existing entry with same type + label
      const existing = await prisma.staffMetadata.findFirst({
        where: {
          staffId: staff.id,
          type: row.type,
          label: row.label,
        },
      });

      if (existing) {
        const sameValue = existing.value === (row.value ?? null);
        if (sameValue) {
          skipped++;
          continue;
        }

        // Value changed — update
        await prisma.staffMetadata.update({
          where: { id: existing.id },
          data: {
            value: row.value?.slice(0, 256) ?? null,
            notes: row.notes?.slice(0, 4000) ?? null,
            isFeatured: row.isFeatured ?? existing.isFeatured,
            metadata: { source: IMPORT_SOURCE_TAG },
          },
        });
        created++; // count as a write
        continue;
      }

      // New entry
      await prisma.staffMetadata.create({
        data: {
          staffId: staff.id,
          type: row.type,
          label: row.label,
          value: row.value?.slice(0, 256) ?? null,
          notes: row.notes?.slice(0, 4000) ?? null,
          isFeatured: row.isFeatured ?? false,
          metadata: { source: IMPORT_SOURCE_TAG },
        },
      });
      created++;
    } catch (err) {
      errors++;
      logger.error({ err, email: row.email, type: row.type, label: row.label }, 'Metadata import: failed');
    }
  }

  const result: MetadataImportResult = { total: rows.length, created, skipped, staffNotFound, errors };
  logger.info(result, 'Metadata import: complete');
  return result;
}

/**
 * Parse a CSV string into import rows.
 * Expected columns: email, type, label, value, notes, isFeatured
 */
export function parseCsv(csv: string): MetadataImportRow[] {
  const lines = csv.trim().split('\n');
  if (lines.length < 2) return []; // header + at least one row

  const header = lines[0]!.split(',').map((h) => h.trim().toLowerCase());
  const emailIdx = header.indexOf('email');
  const typeIdx = header.indexOf('type');
  const labelIdx = header.indexOf('label');
  const valueIdx = header.indexOf('value');
  const notesIdx = header.indexOf('notes');
  const featuredIdx = header.indexOf('isfeatured');

  if (emailIdx === -1 || typeIdx === -1 || labelIdx === -1) {
    throw new Error('CSV must have columns: email, type, label');
  }

  const rows: MetadataImportRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i]!.split(',').map((c) => c.trim());
    const email = cols[emailIdx];
    const type = cols[typeIdx];
    const label = cols[labelIdx];

    if (!email || !type || !label) continue;

    rows.push({
      email,
      type,
      label,
      value: valueIdx >= 0 ? cols[valueIdx] || null : null,
      notes: notesIdx >= 0 ? cols[notesIdx] || null : null,
      isFeatured: featuredIdx >= 0 ? cols[featuredIdx]?.toLowerCase() === 'true' : false,
    });
  }

  return rows;
}
