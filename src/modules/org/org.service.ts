import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { checkAccess, getGrantedResourceIds, getTemporalCutoff } from './access.service';
import { AccessDeniedError } from './org.types';
import type {
  AccountResponse,
  AccountCurrentState,
  CampaignResponse,
  ChangeLogEntry,
  OfficeResponse,
  StaffResponse,
  TeamResponse,
  UserResponse,
} from './org.types';

// ── Account current state ──────────────────────────────────────────────────
// Accounts use an append-only EAV log (account_changes).
// Current state = latest changedAt per property.
// Resolved at read time — no materialised view needed at this scale.

function resolveCurrentState(
  changes: Array<{
    property: string;
    valueText: string | null;
    valueUuid: string | null;
    valueDate: Date | null;
    changedAt: Date;
  }>,
): AccountCurrentState {
  const latest = new Map<string, typeof changes[0]>();

  for (const change of changes) {
    const existing = latest.get(change.property);
    if (!existing || change.changedAt > existing.changedAt) {
      latest.set(change.property, change);
    }
  }

  const state: AccountCurrentState = {};
  for (const [property, change] of latest) {
    state[property] =
      change.valueText ??
      change.valueUuid ??
      (change.valueDate ? (change.valueDate.toISOString().split('T')[0] ?? null) : null);
  }

  return state;
}

// ── Accounts ───────────────────────────────────────────────────────────────

export async function listAccounts(
  userId: string,
  isAdmin: boolean,
): Promise<AccountResponse[]> {
  const where = isAdmin
    ? {}
    : { id: { in: await getGrantedResourceIds(userId, 'account') } };

  const accounts = await prisma.account.findMany({
    where,
    orderBy: { name: 'asc' },
    include: { changes: { orderBy: { changedAt: 'desc' } } },
  });

  return accounts.map((a) => ({
    id: a.id,
    name: a.name,
    parentId: a.parentId,
    currentState: resolveCurrentState(a.changes),
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  }));
}

export async function getAccount(
  id: string,
  userId: string,
  isAdmin: boolean,
): Promise<AccountResponse | null> {
  const account = await prisma.account.findUnique({
    where: { id },
    include: { changes: { orderBy: { changedAt: 'desc' } } },
  });

  if (!account) return null;

  const hasAccess = await checkAccess(userId, 'account', id, isAdmin);
  if (!hasAccess) throw new AccessDeniedError();

  return {
    id: account.id,
    name: account.name,
    parentId: account.parentId,
    currentState: resolveCurrentState(account.changes),
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}

// ── Campaigns ──────────────────────────────────────────────────────────────

/**
 * List all campaigns the user can see — across all accounts. Mirrors
 * listAccounts: admins see everything; non-admins see campaigns they have
 * a direct access_grant for.
 *
 * Optionally filter by status via the `status` arg. No other filtering for
 * now; consumers that need account-scoped results should use
 * GET /accounts/:accountId/campaigns instead.
 *
 * Note on cascading: account-level "full access" grants materialize
 * per-campaign rows at grant time (see cascading-access.service.ts), so
 * the direct-grant lookup here is sufficient — cascades aren't a
 * second-class citizen, they're just eagerly expanded.
 */
export async function listCampaigns(
  userId: string,
  isAdmin: boolean,
  status?: string,
): Promise<CampaignResponse[]> {
  const grantedCampaignIds = isAdmin
    ? null
    : await getGrantedResourceIds(userId, 'campaign');

  const campaigns = await prisma.campaign.findMany({
    where: {
      ...(grantedCampaignIds !== null && { id: { in: grantedCampaignIds } }),
      ...(status ? { status } : {}),
    },
    orderBy: { createdAt: 'desc' },
  });

  return campaigns.map(campaignToResponse);
}

export async function listCampaignsByAccount(
  accountId: string,
  userId: string,
  isAdmin: boolean,
): Promise<CampaignResponse[]> {
  // Verify account access first — throws AccessDeniedError if no grant
  await getAccount(accountId, userId, isAdmin);

  const grantedCampaignIds = isAdmin
    ? null // null signals "no filter needed"
    : await getGrantedResourceIds(userId, 'campaign');

  const campaigns = await prisma.campaign.findMany({
    where: {
      accountId,
      ...(grantedCampaignIds !== null && {
        id: { in: grantedCampaignIds },
      }),
    },
    orderBy: { createdAt: 'desc' },
  });

  return campaigns.map(campaignToResponse);
}

export async function getCampaign(
  id: string,
  userId: string,
  isAdmin: boolean,
): Promise<CampaignResponse | null> {
  const campaign = await prisma.campaign.findUnique({ where: { id } });
  if (!campaign) return null;

  const hasAccess = await checkAccess(userId, 'campaign', id, isAdmin);
  if (!hasAccess) throw new AccessDeniedError();

  return campaignToResponse(campaign);
}

function campaignToResponse(c: {
  id: string;
  accountId: string;
  name: string;
  status: string;
  budget: { toString(): string } | null;
  assetsUrl: string | null;
  awardedAt: Date | null;
  liveAt: Date | null;
  endsAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): CampaignResponse {
  return {
    id: c.id,
    accountId: c.accountId,
    name: c.name,
    status: c.status,
    // Prisma returns Decimal as an object — serialize to string to avoid
    // precision loss. Consumers should parse with a decimal library.
    budget: c.budget ? c.budget.toString() : null,
    assetsUrl: c.assetsUrl,
    awardedAt: c.awardedAt,
    liveAt: c.liveAt,
    endsAt: c.endsAt,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

// ── Staff ──────────────────────────────────────────────────────────────────
// Access is governed by staff-scoped grants on the requesting user.
//
// Grant resourceTypes and their meaning:
//   staff_all     → all staff (resourceId ignored — use nil UUID as sentinel)
//   staff_current → all staff with status in ['active','on_leave']
//   staff_office  → all staff whose officeId === resourceId
//   staff_team    → all staff who are members of the team with id === resourceId
//
// Admins bypass all grant checks and receive all staff.
// Users with no staff grants receive an empty list.

const CURRENT_STATUSES = ['active', 'on_leave'];

export async function listStaff(
  userId: string,
  isAdmin: boolean,
  activeOnly = true,
): Promise<StaffResponse[]> {
  // Admins get everything — no grant check needed
  if (isAdmin) {
    const staff = await prisma.staff.findMany({
      ...(activeOnly ? { where: { status: { in: CURRENT_STATUSES } } } : {}),
      orderBy: { fullName: 'asc' },
    });
    return staff.map(staffToResponse);
  }

  // Fetch all active staff grants for this user
  const grants = await prisma.accessGrant.findMany({
    where: {
      userId,
      resourceType: { in: ['staff_all', 'staff_current', 'staff_office', 'staff_team'] },
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
  });

  if (grants.length === 0) return [];

  // Short-circuit: if any grant is staff_all, return everything
  if (grants.some((g) => g.resourceType === 'staff_all')) {
    const staff = await prisma.staff.findMany({
      ...(activeOnly ? { where: { status: { in: CURRENT_STATUSES } } } : {}),
      orderBy: { fullName: 'asc' },
    });
    return staff.map(staffToResponse);
  }

  // Build up a set of staff IDs from each grant scope
  const staffIdSet = new Set<string>();

  for (const grant of grants) {
    if (grant.resourceType === 'staff_current') {
      const current = await prisma.staff.findMany({
        where: { status: { in: CURRENT_STATUSES } },
        select: { id: true },
      });
      current.forEach((s) => staffIdSet.add(s.id));
    }

    if (grant.resourceType === 'staff_office') {
      const officeStaff = await prisma.staff.findMany({
        where: {
          officeId: grant.resourceId,
          ...(activeOnly ? { status: { in: CURRENT_STATUSES } } : {}),
        },
        select: { id: true },
      });
      officeStaff.forEach((s) => staffIdSet.add(s.id));
    }

    if (grant.resourceType === 'staff_team') {
      // staffId is nullable on team_members (unlinked rows from the
      // Groups sync have staffId=null + sourceEmail set). Filter to
      // linked rows only — unlinked members don't grant org-data access.
      const members = await prisma.teamMember.findMany({
        where: { teamId: grant.resourceId, staffId: { not: null } },
        select: { staffId: true },
      });
      // For team grants respect activeOnly by filtering after gathering IDs
      const teamStaff = await prisma.staff.findMany({
        where: {
          id: { in: members.map((m) => m.staffId).filter((id): id is string => id !== null) },
          ...(activeOnly ? { status: { in: CURRENT_STATUSES } } : {}),
        },
        select: { id: true },
      });
      teamStaff.forEach((s) => staffIdSet.add(s.id));
    }
  }

  if (staffIdSet.size === 0) return [];

  const staff = await prisma.staff.findMany({
    where: { id: { in: Array.from(staffIdSet) } },
    orderBy: { fullName: 'asc' },
  });

  return staff.map(staffToResponse);
}

export async function getStaffMember(
  id: string,
): Promise<StaffResponse | null> {
  const member = await prisma.staff.findUnique({ where: { id } });
  if (!member) return null;
  return staffToResponse(member);
}

// ── History ────────────────────────────────────────────────────────────────
// Change-log endpoints gated by func:temporal grant.
// Callers without a rolling or all_time grant receive 403.

export async function getAccountHistory(
  accountId: string,
  userId: string,
  isAdmin: boolean,
): Promise<ChangeLogEntry[]> {
  // Resource access check first
  const hasAccess = await checkAccess(userId, 'account', accountId, isAdmin);
  if (!hasAccess) throw new AccessDeniedError();

  const cutoff = await getTemporalCutoff(userId, isAdmin);
  if (cutoff === null) throw new AccessDeniedError();

  const changes = await prisma.accountChange.findMany({
    where: {
      accountId,
      changedAt: { gte: cutoff },
    },
    orderBy: { changedAt: 'desc' },
  });

  return changes.map((c) => ({
    id: c.id,
    property: c.property,
    valueText: c.valueText,
    valueUuid: c.valueUuid,
    valueDate: c.valueDate ? c.valueDate.toISOString().split('T')[0] ?? null : null,
    changedBy: c.changedBy,
    changedAt: c.changedAt,
  }));
}

export async function getCampaignHistory(
  campaignId: string,
  userId: string,
  isAdmin: boolean,
): Promise<ChangeLogEntry[]> {
  const hasAccess = await checkAccess(userId, 'campaign', campaignId, isAdmin);
  if (!hasAccess) throw new AccessDeniedError();

  const cutoff = await getTemporalCutoff(userId, isAdmin);
  if (cutoff === null) throw new AccessDeniedError();

  const changes = await prisma.campaignChange.findMany({
    where: {
      campaignId,
      changedAt: { gte: cutoff },
    },
    orderBy: { changedAt: 'desc' },
  });

  return changes.map((c) => ({
    id: c.id,
    property: c.property,
    valueText: c.valueText,
    valueUuid: c.valueUuid,
    valueDate: c.valueDate ? c.valueDate.toISOString().split('T')[0] ?? null : null,
    changedBy: c.changedBy,
    changedAt: c.changedAt,
  }));
}

function staffToResponse(s: {
  id: string;
  fullName: string;
  email: string;
  title: string | null;
  department: string | null;
  status: string;
  startedAt: Date;
  endedAt: Date | null;
}): StaffResponse {
  return {
    id: s.id,
    fullName: s.fullName,
    email: s.email,
    title: s.title,
    department: s.department,
    status: s.status,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
  };
}

// ── Access requests ────────────────────────────────────────────────────────

export const CreateAccessRequestSchema = z.object({
  // Same domain as AccessGrant.resourceType
  resourceType: z.string().min(1),
  // Null for functional / scope grants (func:*, staff:*)
  resourceId: z.string().uuid().nullable().optional(),
  // Role or capability level being requested
  requestedRole: z.string().min(1),
  // Free-text reason from the requester
  reason: z.string().max(2000).nullable().optional(),
});

export type CreateAccessRequestInput = z.infer<typeof CreateAccessRequestSchema>;

export interface AccessRequestResponse {
  id: string;
  userId: string;
  resourceType: string;
  resourceId: string | null;
  requestedRole: string;
  reason: string | null;
  status: string;
  reviewedAt: Date | null;
  reviewNote: string | null;
  grantId: string | null;
  createdAt: Date;
}

/**
 * Submit an access request. Any authenticated user can call this.
 * Duplicate detection: if the user already has a pending request for the
 * same resource + role, we return the existing one rather than creating
 * a duplicate.
 */
export async function createAccessRequest(
  userId: string,
  input: CreateAccessRequestInput,
): Promise<AccessRequestResponse> {
  const existing = await prisma.accessRequest.findFirst({
    where: {
      userId,
      resourceType: input.resourceType,
      resourceId: input.resourceId ?? null,
      requestedRole: input.requestedRole,
      status: 'pending',
    },
  });

  if (existing) return toAccessRequestResponse(existing);

  const request = await prisma.accessRequest.create({
    data: {
      userId,
      resourceType: input.resourceType,
      resourceId: input.resourceId ?? null,
      requestedRole: input.requestedRole,
      reason: input.reason ?? null,
    },
  });

  return toAccessRequestResponse(request);
}

/**
 * List all access requests for the calling user.
 * Most recent first.
 */
export async function listMyAccessRequests(
  userId: string,
): Promise<AccessRequestResponse[]> {
  const requests = await prisma.accessRequest.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
  });

  return requests.map(toAccessRequestResponse);
}

function toAccessRequestResponse(r: {
  id: string;
  userId: string;
  resourceType: string;
  resourceId: string | null;
  requestedRole: string;
  reason: string | null;
  status: string;
  reviewedAt: Date | null;
  reviewNote: string | null;
  grantId: string | null;
  createdAt: Date;
}): AccessRequestResponse {
  return {
    id: r.id,
    userId: r.userId,
    resourceType: r.resourceType,
    resourceId: r.resourceId,
    requestedRole: r.requestedRole,
    reason: r.reason,
    status: r.status,
    reviewedAt: r.reviewedAt,
    reviewNote: r.reviewNote,
    grantId: r.grantId,
    createdAt: r.createdAt,
  };
}

// ── App access requests ────────────────────────────────────────────────────
// These are app-level gate requests (distinct from resource-level AccessRequest).
// A user who hits a gated app with no UserAppPermission submits one of these.

export const CreateAppAccessRequestSchema = z.object({
  appId: z.string().min(1),
  reason: z.string().max(2000).nullable().optional(),
});

export type CreateAppAccessRequestInput = z.infer<typeof CreateAppAccessRequestSchema>;

export interface AppAccessRequestResponse {
  id: string;
  userId: string;
  appId: string;
  reason: string | null;
  status: string;
  reviewedAt: Date | null;
  reviewNote: string | null;
  createdAt: Date;
}

/**
 * Submit an app access request.
 * Idempotent: returns existing pending request if one already exists.
 * Rejects if user already has an approved permission for the app.
 */
export async function createAppAccessRequest(
  userId: string,
  input: CreateAppAccessRequestInput,
): Promise<AppAccessRequestResponse> {
  // Check if user already has access
  const existing = await prisma.userAppPermission.findUnique({
    where: { userId_appId: { userId, appId: input.appId } },
  });
  if (existing) {
    throw Object.assign(new Error('You already have access to this app'), { code: 'ALREADY_GRANTED', status: 409 });
  }

  // Idempotency — return existing pending request if present
  const pending = await prisma.appAccessRequest.findFirst({
    where: { userId, appId: input.appId, status: 'pending' },
  });
  if (pending) return toAppAccessRequestResponse(pending);

  const request = await prisma.appAccessRequest.create({
    data: {
      userId,
      appId: input.appId,
      reason: input.reason ?? null,
    },
  });

  return toAppAccessRequestResponse(request);
}

/**
 * List all app access requests for the calling user (most recent first).
 */
export async function listMyAppAccessRequests(
  userId: string,
): Promise<AppAccessRequestResponse[]> {
  const requests = await prisma.appAccessRequest.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
  });

  return requests.map(toAppAccessRequestResponse);
}

function toAppAccessRequestResponse(r: {
  id: string;
  userId: string;
  appId: string;
  reason: string | null;
  status: string;
  reviewedAt: Date | null;
  reviewNote: string | null;
  createdAt: Date;
}): AppAccessRequestResponse {
  return {
    id: r.id,
    userId: r.userId,
    appId: r.appId,
    reason: r.reason,
    status: r.status,
    reviewedAt: r.reviewedAt,
    reviewNote: r.reviewNote,
    createdAt: r.createdAt,
  };
}

// ── Staff metadata ─────────────────────────────────────────────────────────
// Flexible per-staff traits: skills, interests, work highlights, etc.
// type is a free string; valid types are documented convention, not DB enum.
// source/provenance is intentionally omitted — inferrable from audit_log.

export const CreateStaffMetadataSchema = z.object({
  type:       z.string().min(1).max(64),
  label:      z.string().min(1).max(256),
  value:      z.string().max(256).nullable().optional(),
  notes:      z.string().max(4000).nullable().optional(),
  metadata:   z.record(z.unknown()).nullable().optional(),
  isFeatured: z.boolean().optional(),
});

export const UpdateStaffMetadataSchema = CreateStaffMetadataSchema.partial();

export type CreateStaffMetadataInput = z.infer<typeof CreateStaffMetadataSchema>;
export type UpdateStaffMetadataInput = z.infer<typeof UpdateStaffMetadataSchema>;

export interface StaffMetadataResponse {
  id:         string;
  staffId:    string;
  type:       string;
  label:      string;
  value:      string | null;
  notes:      string | null;
  metadata:   Record<string, unknown> | null;
  isFeatured: boolean;
  createdAt:  Date;
  updatedAt:  Date;
}

function toMetadataResponse(r: {
  id: string;
  staffId: string;
  type: string;
  label: string;
  value: string | null;
  notes: string | null;
  metadata: unknown;
  isFeatured: boolean;
  createdAt: Date;
  updatedAt: Date;
}): StaffMetadataResponse {
  return {
    id:         r.id,
    staffId:    r.staffId,
    type:       r.type,
    label:      r.label,
    value:      r.value,
    notes:      r.notes,
    metadata:   (r.metadata as Record<string, unknown> | null) ?? null,
    isFeatured: r.isFeatured,
    createdAt:  r.createdAt,
    updatedAt:  r.updatedAt,
  };
}

/**
 * List all metadata for a staff member, optionally filtered by type.
 */
export async function listStaffMetadata(
  staffId: string,
  type?: string,
): Promise<StaffMetadataResponse[]> {
  const rows = await prisma.staffMetadata.findMany({
    where: { staffId, ...(type ? { type } : {}) },
    orderBy: [{ type: 'asc' }, { label: 'asc' }],
  });
  return rows.map(toMetadataResponse);
}

/**
 * Resolve a Staff ID from a User ID for audit log writes.
 * Returns null if the user has no linked staff record (non-staff admin).
 */
async function resolveActorStaffId(userId: string): Promise<string | null> {
  const staff = await prisma.staff.findFirst({ where: { userId }, select: { id: true } });
  return staff?.id ?? null;
}

/**
 * Create a metadata entry for a staff member.
 * Writes an audit_log entry crediting the acting user (if they have a staff record).
 */
export async function createStaffMetadata(
  staffId: string,
  input: CreateStaffMetadataInput,
  actorUserId: string,
): Promise<StaffMetadataResponse> {
  const actorStaffId = await resolveActorStaffId(actorUserId);

  const row = await prisma.$transaction(async (tx) => {
    const created = await tx.staffMetadata.create({
      data: {
        staffId,
        type:       input.type,
        label:      input.label,
        value:      input.value ?? null,
        notes:      input.notes ?? null,
        isFeatured: input.isFeatured ?? false,
        ...(input.metadata != null ? { metadata: input.metadata } : {}),
      },
    });

    if (actorStaffId) {
      await tx.auditLog.create({
        data: {
          actorId:    actorStaffId,
          action:     'staff_metadata_created',
          entityType: 'staff_metadata',
          entityId:   created.id,
          after: { staffId, type: input.type, label: input.label, value: input.value ?? null } as object,
        },
      });
    }

    return created;
  });

  return toMetadataResponse(row);
}

/**
 * Update a metadata entry. Only the owner staff or an admin should call this.
 */
export async function updateStaffMetadata(
  id: string,
  staffId: string,
  input: UpdateStaffMetadataInput,
  actorUserId: string,
): Promise<StaffMetadataResponse | null> {
  const existing = await prisma.staffMetadata.findFirst({ where: { id, staffId } });
  if (!existing) return null;

  const actorStaffId = await resolveActorStaffId(actorUserId);

  const row = await prisma.$transaction(async (tx) => {
    const updated = await tx.staffMetadata.update({
      where: { id },
      data: {
        ...(input.type       !== undefined ? { type: input.type }           : {}),
        ...(input.label      !== undefined ? { label: input.label }         : {}),
        ...(input.value      !== undefined ? { value: input.value ?? null } : {}),
        ...(input.notes      !== undefined ? { notes: input.notes ?? null } : {}),
        ...(input.isFeatured !== undefined ? { isFeatured: input.isFeatured } : {}),
        ...(input.metadata   !== undefined
          ? { metadata: input.metadata != null ? input.metadata : Prisma.JsonNull }
          : {}),
      },
    });

    if (actorStaffId) {
      await tx.auditLog.create({
        data: {
          actorId:    actorStaffId,
          action:     'staff_metadata_updated',
          entityType: 'staff_metadata',
          entityId:   id,
          before: { type: existing.type, label: existing.label, value: existing.value } as object,
          after:  { type: updated.type,  label: updated.label,  value: updated.value  } as object,
        },
      });
    }

    return updated;
  });

  return toMetadataResponse(row);
}

/**
 * Delete a metadata entry. Hard delete is intentional — this is not
 * compliance-sensitive data, and the audit_log records the deletion.
 */
export async function deleteStaffMetadata(
  id: string,
  staffId: string,
  actorUserId: string,
): Promise<boolean> {
  const existing = await prisma.staffMetadata.findFirst({ where: { id, staffId } });
  if (!existing) return false;

  const actorStaffId = await resolveActorStaffId(actorUserId);

  await prisma.$transaction(async (tx) => {
    await tx.staffMetadata.delete({ where: { id } });

    if (actorStaffId) {
      await tx.auditLog.create({
        data: {
          actorId:    actorStaffId,
          action:     'staff_metadata_deleted',
          entityType: 'staff_metadata',
          entityId:   id,
          before: { type: existing.type, label: existing.label, value: existing.value } as object,
        },
      });
    }
  });

  return true;
}

/**
 * Cross-staff resourcing search.
 * Find all staff who have a metadata entry matching type + optional filters.
 * Returns staff with their matching metadata rows.
 */
export interface ResourcingResult {
  staffId:   string;
  fullName:  string;
  email:     string;
  title:     string | null;
  status:    string;
  entries:   StaffMetadataResponse[];
}

export async function searchByMetadata(params: {
  type:        string;
  label?:      string;   // partial match
  value?:      string;   // exact match (e.g. 'expert')
  isFeatured?: boolean;
}): Promise<ResourcingResult[]> {
  const rows = await prisma.staffMetadata.findMany({
    where: {
      type: params.type,
      ...(params.label      ? { label: { contains: params.label, mode: 'insensitive' } } : {}),
      ...(params.value      ? { value: params.value }      : {}),
      ...(params.isFeatured !== undefined ? { isFeatured: params.isFeatured } : {}),
    },
    include: {
      staff: { select: { id: true, fullName: true, email: true, title: true, status: true } },
    },
    orderBy: [{ staff: { fullName: 'asc' } }, { label: 'asc' }],
  });

  // Group by staff member
  const byStaff = new Map<string, ResourcingResult>();
  for (const row of rows) {
    if (!byStaff.has(row.staffId)) {
      byStaff.set(row.staffId, {
        staffId:  row.staff.id,
        fullName: row.staff.fullName,
        email:    row.staff.email,
        title:    row.staff.title,
        status:   row.staff.status,
        entries:  [],
      });
    }
    byStaff.get(row.staffId)!.entries.push(toMetadataResponse(row));
  }

  return Array.from(byStaff.values());
}

// ── Offices ────────────────────────────────────────────────────────────────
// Offices are gated by access_grants. Grant types (mirrors staff_*):
//   office_all      — every office (resourceId ignored)
//   office_active   — offices where isActive = true (default broad grant)
//   office          — a specific office (resourceId = offices.id)
//
// Admins bypass all grant checks. Users with zero office grants get [].
// This means, by design, a user with only `office_active` won't see an
// office that opened and closed within a year (isActive flips to false
// when it closes, revoking visibility automatically).
//
// currentState is resolved from office_changes (property, text|date) and
// exposes any audit-log-driven overrides of the base Office row.

function resolveSimpleCurrentState(
  changes: Array<{
    property: string;
    valueText: string | null;
    valueDate: Date | null;
    changedAt: Date;
  }>,
): Record<string, string | null> {
  const latest = new Map<string, (typeof changes)[0]>();
  for (const change of changes) {
    const existing = latest.get(change.property);
    if (!existing || change.changedAt > existing.changedAt) {
      latest.set(change.property, change);
    }
  }
  const state: Record<string, string | null> = {};
  for (const [property, change] of latest) {
    state[property] =
      change.valueText ??
      (change.valueDate ? (change.valueDate.toISOString().split('T')[0] ?? null) : null);
  }
  return state;
}

function officeToResponse(o: {
  id: string;
  name: string;
  syncCity: string | null;
  isActive: boolean;
  startedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  changes: Array<{
    property: string;
    valueText: string | null;
    valueDate: Date | null;
    changedAt: Date;
  }>;
}): OfficeResponse {
  return {
    id: o.id,
    name: o.name,
    syncCity: o.syncCity,
    isActive: o.isActive,
    startedAt: o.startedAt,
    currentState: resolveSimpleCurrentState(o.changes),
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
  };
}

/**
 * Fetch the office-scoped grants for a user and return a filter describing
 * what the user may see. Returns `null` when the user has NO office grants
 * (caller should return an empty list). Admins resolve to `{ allVisible: true }`
 * and skip this path entirely.
 */
async function resolveOfficeVisibility(userId: string): Promise<
  | { allVisible: true }
  | { allVisible: false; activeOnly: boolean; ids: string[] }
  | null
> {
  const grants = await prisma.accessGrant.findMany({
    where: {
      userId,
      resourceType: { in: ['office_all', 'office_active', 'office'] },
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    select: { resourceType: true, resourceId: true },
  });

  if (grants.length === 0) return null;

  if (grants.some((g) => g.resourceType === 'office_all')) {
    return { allVisible: true };
  }

  const activeOnly = grants.some((g) => g.resourceType === 'office_active');
  const ids = grants
    .filter((g) => g.resourceType === 'office')
    .map((g) => g.resourceId);

  return { allVisible: false, activeOnly, ids };
}

export async function listOffices(
  userId: string,
  isAdmin: boolean,
  activeOnly = false,
): Promise<OfficeResponse[]> {
  let where: Prisma.OfficeWhereInput = {};

  if (!isAdmin) {
    const visibility = await resolveOfficeVisibility(userId);
    if (!visibility) return [];
    if (!visibility.allVisible) {
      // Either isActive=true (cohort grant) OR id in the per-office set.
      const orClauses: Prisma.OfficeWhereInput[] = [];
      if (visibility.activeOnly) orClauses.push({ isActive: true });
      if (visibility.ids.length > 0) orClauses.push({ id: { in: visibility.ids } });
      if (orClauses.length === 0) return [];
      where = { OR: orClauses };
    }
  }

  // Caller's extra activeOnly query param layers on top of whatever grants allow.
  if (activeOnly) {
    where = { AND: [where, { isActive: true }] };
  }

  const offices = await prisma.office.findMany({
    where,
    orderBy: { name: 'asc' },
    include: { changes: { orderBy: { changedAt: 'desc' } } },
  });
  return offices.map(officeToResponse);
}

export async function getOffice(
  id: string,
  userId: string,
  isAdmin: boolean,
): Promise<OfficeResponse | null> {
  const office = await prisma.office.findUnique({
    where: { id },
    include: { changes: { orderBy: { changedAt: 'desc' } } },
  });
  if (!office) return null;

  if (!isAdmin) {
    const visibility = await resolveOfficeVisibility(userId);
    if (!visibility) throw new AccessDeniedError();
    if (!visibility.allVisible) {
      const grantedById = visibility.ids.includes(id);
      const grantedByActive = visibility.activeOnly && office.isActive;
      if (!grantedById && !grantedByActive) throw new AccessDeniedError();
    }
  }

  return officeToResponse(office);
}

// ── Teams ──────────────────────────────────────────────────────────────────
// Same access posture as offices (access_grant gated):
//   team_all      — every team (resourceId ignored)
//   team_active   — teams where isActive = true (default broad grant)
//   team          — a specific team (resourceId = teams.id)
//
// Admins bypass; zero grants → []. Member rosters piggyback on team
// visibility — if you can see the team, you see who's on it. For tighter
// member-level hiding, gate members via /org/staff grants instead.

function teamToResponse(t: {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
  startedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  // staffId nullable + staff nullable on the schema — but the callers
  // include with `where: { staffId: { not: null } }`, so unlinked rows
  // never reach this function. We narrow defensively below.
  members: Array<{
    staffId: string | null;
    staff: { id: string; fullName: string; email: string; title: string | null } | null;
  }>;
  changes: Array<{
    property: string;
    valueText: string | null;
    valueDate: Date | null;
    changedAt: Date;
  }>;
}): TeamResponse {
  return {
    id: t.id,
    name: t.name,
    description: t.description,
    isActive: t.isActive,
    startedAt: t.startedAt,
    members: t.members
      .filter((m): m is typeof m & { staff: NonNullable<typeof m.staff> } => m.staff !== null)
      .map((m) => ({
        staffId: m.staff.id,
        fullName: m.staff.fullName,
        email: m.staff.email,
        title: m.staff.title,
      })),
    currentState: resolveSimpleCurrentState(t.changes),
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

async function resolveTeamVisibility(userId: string): Promise<
  | { allVisible: true }
  | { allVisible: false; activeOnly: boolean; ids: string[] }
  | null
> {
  const grants = await prisma.accessGrant.findMany({
    where: {
      userId,
      resourceType: { in: ['team_all', 'team_active', 'team'] },
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    select: { resourceType: true, resourceId: true },
  });

  if (grants.length === 0) return null;
  if (grants.some((g) => g.resourceType === 'team_all')) return { allVisible: true };

  const activeOnly = grants.some((g) => g.resourceType === 'team_active');
  const ids = grants
    .filter((g) => g.resourceType === 'team')
    .map((g) => g.resourceId);

  return { allVisible: false, activeOnly, ids };
}

const TEAM_INCLUDE = {
  members: {
    include: {
      staff: { select: { id: true, fullName: true, email: true, title: true } },
    },
  },
  changes: { orderBy: { changedAt: 'desc' } },
} as const;

export async function listTeams(
  userId: string,
  isAdmin: boolean,
  activeOnly = false,
): Promise<TeamResponse[]> {
  let where: Prisma.TeamWhereInput = {};

  if (!isAdmin) {
    const visibility = await resolveTeamVisibility(userId);
    if (!visibility) return [];
    if (!visibility.allVisible) {
      const orClauses: Prisma.TeamWhereInput[] = [];
      if (visibility.activeOnly) orClauses.push({ isActive: true });
      if (visibility.ids.length > 0) orClauses.push({ id: { in: visibility.ids } });
      if (orClauses.length === 0) return [];
      where = { OR: orClauses };
    }
  }

  if (activeOnly) {
    where = { AND: [where, { isActive: true }] };
  }

  const teams = await prisma.team.findMany({
    where,
    orderBy: { name: 'asc' },
    include: {
      // Filter out unlinked members (sourced from the Groups sync, no
      // matching staff record yet). The org-data API surface only exposes
      // linked memberships; unlinked rows are an admin-UI-only concept.
      members: {
        where: { staffId: { not: null } },
        include: {
          staff: { select: { id: true, fullName: true, email: true, title: true } },
        },
      },
      changes: { orderBy: { changedAt: 'desc' } },
    },
  });
  return teams.map(teamToResponse);
}

export async function getTeam(
  id: string,
  userId: string,
  isAdmin: boolean,
): Promise<TeamResponse | null> {
  const team = await prisma.team.findUnique({
    where: { id },
    include: {
      // Filter out unlinked members (sourced from the Groups sync, no
      // matching staff record yet). The org-data API surface only exposes
      // linked memberships; unlinked rows are an admin-UI-only concept.
      members: {
        where: { staffId: { not: null } },
        include: {
          staff: { select: { id: true, fullName: true, email: true, title: true } },
        },
      },
      changes: { orderBy: { changedAt: 'desc' } },
    },
  });
  if (!team) return null;

  if (!isAdmin) {
    const visibility = await resolveTeamVisibility(userId);
    if (!visibility) throw new AccessDeniedError();
    if (!visibility.allVisible) {
      const grantedById = visibility.ids.includes(id);
      const grantedByActive = visibility.activeOnly && team.isActive;
      if (!grantedById && !grantedByActive) throw new AccessDeniedError();
    }
  }

  return teamToResponse(team);
}

// ── Users ──────────────────────────────────────────────────────────────────
// Users are Google OAuth identities, not employees (that's Staff). Access
// posture is stricter:
//   list   → admin only (throws AccessDeniedError for non-admins)
//   get    → admin OR self (a user may always fetch their own record)
//
// Sensitive fields (googleSub, refresh tokens, external ids) are NOT
// included in UserResponse. Consumers that need identity mappings should
// go through dedicated endpoints.

function userToResponse(u: {
  id: string;
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
  role: string;
  isAdmin: boolean;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}): UserResponse {
  return {
    id: u.id,
    email: u.email,
    displayName: u.displayName,
    avatarUrl: u.avatarUrl,
    role: u.role,
    isAdmin: u.isAdmin,
    isActive: u.isActive,
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
  };
}

export async function listUsers(
  _userId: string,
  isAdmin: boolean,
  activeOnly = false,
): Promise<UserResponse[]> {
  if (!isAdmin) throw new AccessDeniedError();
  const users = await prisma.user.findMany({
    ...(activeOnly ? { where: { isActive: true } } : {}),
    orderBy: { email: 'asc' },
    select: {
      id: true,
      email: true,
      displayName: true,
      avatarUrl: true,
      role: true,
      isAdmin: true,
      isActive: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  return users.map(userToResponse);
}

export async function getUser(
  id: string,
  callerUserId: string,
  isAdmin: boolean,
): Promise<UserResponse | null> {
  // Admins can read any user; everyone else can only read themselves.
  if (!isAdmin && id !== callerUserId) throw new AccessDeniedError();
  const user = await prisma.user.findUnique({
    where: { id },
    select: {
      id: true,
      email: true,
      displayName: true,
      avatarUrl: true,
      role: true,
      isAdmin: true,
      isActive: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  if (!user) return null;
  return userToResponse(user);
}
