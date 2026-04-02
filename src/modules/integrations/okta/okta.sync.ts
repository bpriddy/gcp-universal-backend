import { prisma } from '../../../config/database';
import { mapOktaUser } from './okta.mapper';
import { STAFF_PII_PROPERTIES } from '../../org/staff-pii-properties';
import type { OktaUser } from './okta.client';
import type { MappedStaff } from './okta.mapper';

// ── Types ─────────────────────────────────────────────────────────────────────

export type SyncSource = 'okta_sync' | 'okta_webhook';

interface ChangeRow {
  staffId: string;
  property: string;
  valueText?: string | null;
  valueUuid?: string | null;
  valueDate?: Date | null;
  valueIsPii: boolean;
  source: SyncSource;
}

/** Builds a change row, automatically setting valueIsPii from STAFF_PII_PROPERTIES. */
function changeRow(
  staffId: string,
  property: string,
  values: Pick<ChangeRow, 'valueText' | 'valueUuid' | 'valueDate'>,
  source: SyncSource,
): ChangeRow {
  return { staffId, property, ...values, valueIsPii: STAFF_PII_PROPERTIES.has(property), source };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Apply a single Okta user to the staff table.
 *
 * - If the staff member does not yet exist: create them + write initial change rows.
 * - If they already exist: diff each tracked property, write change rows only for
 *   what actually changed, then update the staff row atomically.
 *
 * Both cron pull and webhook call this same function; the `source` argument
 * distinguishes the two paths in the change log.
 */
export async function applyOktaUser(user: OktaUser, source: SyncSource): Promise<void> {
  // Skip not-yet-onboarded users — we only care about people who are (or were) real staff
  if (user.status === 'STAGED' || user.status === 'PROVISIONED') return;

  const mapped = mapOktaUser(user);

  // Resolve office by okta_city → officeId
  const officeId = await resolveOfficeId(mapped.oktaCity);

  // Look up existing staff via the okta external ID
  const extId = await prisma.staffExternalId.findUnique({
    where: { system_externalId: { system: 'okta', externalId: mapped.oktaId } },
    include: { staff: true },
  });

  if (!extId) {
    await createStaff(mapped, officeId, source);
  } else {
    await updateStaff(extId.staff, mapped, officeId, source);
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

async function resolveOfficeId(oktaCity: string | null): Promise<string | null> {
  if (!oktaCity) return null;
  const office = await prisma.office.findUnique({ where: { oktaCity } });
  return office?.id ?? null;
}

async function createStaff(
  mapped: MappedStaff,
  officeId: string | null,
  source: SyncSource,
): Promise<void> {
  const staff = await prisma.staff.create({
    data: {
      fullName: mapped.fullName,
      email: mapped.email,
      title: mapped.title,
      department: mapped.department,
      status: mapped.status,
      officeId,
      startedAt: mapped.startedAt ?? new Date(),
      externalIds: {
        create: { system: 'okta', externalId: mapped.oktaId },
      },
    },
  });

  const changeRows: ChangeRow[] = [
    changeRow(staff.id, 'full_name',  { valueText: mapped.fullName }, source),
    changeRow(staff.id, 'email',      { valueText: mapped.email },    source),
    changeRow(staff.id, 'status',     { valueText: mapped.status },   source),
  ];

  if (mapped.title) {
    changeRows.push(changeRow(staff.id, 'title',      { valueText: mapped.title },      source));
  }
  if (mapped.department) {
    changeRows.push(changeRow(staff.id, 'department', { valueText: mapped.department }, source));
  }
  if (officeId) {
    changeRows.push(changeRow(staff.id, 'office_id',  { valueUuid: officeId },          source));
  }
  if (mapped.startedAt) {
    changeRows.push(changeRow(staff.id, 'started_at', { valueDate: mapped.startedAt },  source));
  }

  await prisma.staffChange.createMany({ data: changeRows });
}

async function updateStaff(
  existing: { id: string; fullName: string; email: string; title: string | null; department: string | null; status: string; officeId: string | null; startedAt: Date },
  mapped: MappedStaff,
  officeId: string | null,
  source: SyncSource,
): Promise<void> {
  const changes: ChangeRow[] = [];
  const update: Record<string, unknown> = {};

  if (mapped.fullName !== existing.fullName) {
    changes.push(changeRow(existing.id, 'full_name',  { valueText: mapped.fullName }, source));
    update.fullName = mapped.fullName;
  }

  if (mapped.email !== existing.email) {
    changes.push(changeRow(existing.id, 'email',      { valueText: mapped.email },    source));
    update.email = mapped.email;
  }

  const incomingTitle = mapped.title ?? null;
  if (incomingTitle !== existing.title) {
    changes.push(changeRow(existing.id, 'title',      { valueText: incomingTitle },   source));
    update.title = incomingTitle;
  }

  const incomingDept = mapped.department ?? null;
  if (incomingDept !== existing.department) {
    changes.push(changeRow(existing.id, 'department', { valueText: incomingDept },    source));
    update.department = incomingDept;
  }

  if (mapped.status !== existing.status) {
    changes.push(changeRow(existing.id, 'status',     { valueText: mapped.status },   source));
    update.status = mapped.status;
  }

  if (officeId !== existing.officeId) {
    changes.push(changeRow(existing.id, 'office_id',  { valueUuid: officeId },        source));
    update.officeId = officeId;
  }

  // Only overwrite startedAt if Okta has a value and it differs — don't clobber a manually set date
  if (mapped.startedAt) {
    const incomingTs = mapped.startedAt.toISOString().split('T')[0];
    const existingTs = existing.startedAt?.toISOString().split('T')[0];
    if (incomingTs !== existingTs) {
      changes.push(changeRow(existing.id, 'started_at', { valueDate: mapped.startedAt }, source));
      update.startedAt = mapped.startedAt;
    }
  }

  if (changes.length === 0) return;

  await prisma.$transaction([
    prisma.staff.update({ where: { id: existing.id }, data: update }),
    prisma.staffChange.createMany({ data: changes }),
  ]);
}
