import { prisma } from '../../config/database';

export type ResourceType = 'account' | 'campaign';
export type Role = 'viewer' | 'contributor' | 'manager' | 'admin';

export interface GrantAccountAccessParams {
  userId: string;
  accountId: string;
  /** Explicit campaign IDs, or 'all' to grant access to every campaign under the account */
  campaignIds: string[] | 'all';
  role: Role;
  /** staff.id of the person granting access */
  grantedBy: string;
  expiresAt?: Date;
}

export interface GrantSummary {
  account: number;
  campaigns: number;
}

export interface RevokeAccessParams {
  userId: string;
  resourceType: ResourceType;
  resourceId: string;
  /** staff.id of the person revoking access */
  revokedBy: string;
}

// ── Audit helper ──────────────────────────────────────────────────────────────
// Shared shape for the JSON columns — keeps the audit entries consistent
// regardless of which call path produced them.

interface GrantAuditSnapshot {
  userId: string;
  resourceType: string;
  resourceId: string;
  role: string;
  expiresAt: Date | null | undefined;
  grantedBy?: string;
  grantedAt?: Date;
  revokedAt?: Date;
  revokedBy?: string;
}

// ── Core upsert ───────────────────────────────────────────────────────────────
// Prisma cannot upsert on a partial unique index (WHERE revoked_at IS NULL),
// so we use findFirst + update-or-create inside a transaction.
// Safe at this scale — grant calls cover 1 account + N campaigns at most.
//
// Returns enough state for the caller to write a meaningful audit log entry
// without a second SELECT.

interface UpsertResult {
  id: string;
  isNew: boolean;
  previousRole: string | null;
  previousExpiresAt: Date | null;
}

async function upsertGrant(
  tx: Omit<typeof prisma, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>,
  params: {
    userId: string;
    resourceType: ResourceType;
    resourceId: string;
    role: Role;
    grantedBy: string;
    expiresAt?: Date;
  },
): Promise<UpsertResult> {
  const existing = await tx.accessGrant.findFirst({
    where: {
      userId: params.userId,
      resourceType: params.resourceType,
      resourceId: params.resourceId,
      revokedAt: null,
    },
  });

  if (existing) {
    await tx.accessGrant.update({
      where: { id: existing.id },
      data: {
        role: params.role,
        grantedBy: params.grantedBy,
        grantedAt: new Date(),
        expiresAt: params.expiresAt ?? null,
        revokedAt: null,
        revokedBy: null,
      },
    });
    return {
      id: existing.id,
      isNew: false,
      previousRole: existing.role,
      previousExpiresAt: existing.expiresAt,
    };
  } else {
    const created = await tx.accessGrant.create({
      data: {
        userId: params.userId,
        resourceType: params.resourceType,
        resourceId: params.resourceId,
        role: params.role,
        grantedBy: params.grantedBy,
        expiresAt: params.expiresAt ?? null,
      },
    });
    return { id: created.id, isNew: true, previousRole: null, previousExpiresAt: null };
  }
}

// ── Grant ─────────────────────────────────────────────────────────────────────

export async function grantAccountAccess(
  params: GrantAccountAccessParams,
): Promise<GrantSummary> {
  const { userId, accountId, role, grantedBy, expiresAt } = params;

  // Resolve campaign IDs if 'all' requested
  let campaignIds: string[];
  if (params.campaignIds === 'all') {
    const campaigns = await prisma.campaign.findMany({
      where: { accountId },
      select: { id: true },
    });
    campaignIds = campaigns.map((c) => c.id);
  } else {
    campaignIds = params.campaignIds;
  }

  await prisma.$transaction(async (tx) => {
    // ── Account grant ──────────────────────────────────────────────────────────
    const accountResult = await upsertGrant(tx, {
      userId,
      resourceType: 'account',
      resourceId: accountId,
      role,
      grantedBy,
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    });

    const accountAfter: GrantAuditSnapshot = { userId, resourceType: 'account', resourceId: accountId, role, expiresAt };
    await tx.auditLog.create({
      data: {
        action: accountResult.isNew ? 'grant_created' : 'grant_updated',
        entityType: 'access_grant',
        entityId: accountResult.id,
        actorId: grantedBy,
        ...(accountResult.isNew ? {} : {
          before: { role: accountResult.previousRole, expiresAt: accountResult.previousExpiresAt },
        }),
        after: accountAfter as unknown as GrantAuditSnapshot,
      },
    });

    // ── Campaign grants ────────────────────────────────────────────────────────
    for (const campaignId of campaignIds) {
      const campaignResult = await upsertGrant(tx, {
        userId,
        resourceType: 'campaign',
        resourceId: campaignId,
        role,
        grantedBy,
        ...(expiresAt !== undefined ? { expiresAt } : {}),
      });

      const campaignAfter: GrantAuditSnapshot = { userId, resourceType: 'campaign', resourceId: campaignId, role, expiresAt };
      await tx.auditLog.create({
        data: {
          action: campaignResult.isNew ? 'grant_created' : 'grant_updated',
          entityType: 'access_grant',
          entityId: campaignResult.id,
          actorId: grantedBy,
          ...(campaignResult.isNew ? {} : {
            before: { role: campaignResult.previousRole, expiresAt: campaignResult.previousExpiresAt },
          }),
          after: campaignAfter as unknown as GrantAuditSnapshot,
        },
      });
    }
  });

  return { account: 1, campaigns: campaignIds.length };
}

// ── Revoke ────────────────────────────────────────────────────────────────────

export async function revokeAccess(params: RevokeAccessParams): Promise<void> {
  const { userId, resourceType, resourceId, revokedBy } = params;

  const grant = await prisma.accessGrant.findFirst({
    where: { userId, resourceType, resourceId, revokedAt: null },
  });

  if (!grant) return; // Already revoked or never granted — idempotent

  const now = new Date();

  await prisma.$transaction(async (tx) => {
    await tx.accessGrant.update({
      where: { id: grant.id },
      data: { revokedAt: now, revokedBy },
    });

    await tx.auditLog.create({
      data: {
        action: 'grant_revoked',
        entityType: 'access_grant',
        entityId: grant.id,
        actorId: revokedBy,
        before: {
          userId,
          resourceType,
          resourceId,
          role: grant.role,
          expiresAt: grant.expiresAt,
          grantedAt: grant.grantedAt,
        } as unknown as GrantAuditSnapshot,
        after: { revokedAt: now, revokedBy } as unknown as GrantAuditSnapshot,
      },
    });
  });
}

// ── Check ─────────────────────────────────────────────────────────────────────

export async function checkAccess(
  userId: string,
  resourceType: ResourceType,
  resourceId: string,
  isAdmin: boolean,
): Promise<boolean> {
  // Admins bypass all grant checks
  if (isAdmin) return true;

  const now = new Date();
  const grant = await prisma.accessGrant.findFirst({
    where: {
      userId,
      resourceType,
      resourceId,
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
  });

  return grant !== null;
}

// ── Temporal access ───────────────────────────────────────────────────────────
// Controls how far back a user can query change-log / historical data.
//
// Roles (stored in access_grants.role where resource_type = 'func:temporal'):
//   current_only  – default when no grant exists; point-in-time queries blocked
//   rolling_1yr   – may query data changed within the last 1 year
//   rolling_2yr   – last 2 years
//   rolling_5yr   – last 5 years
//   all_time      – no restriction
//
// Usage: call getTemporalCutoff() and, if it returns a Date, add a
//   changedAt: { gte: cutoff } filter to any change-log query.
//   If it returns null the caller should block historical access entirely.

export type TemporalRole = 'current_only' | 'rolling_1yr' | 'rolling_2yr' | 'rolling_5yr' | 'all_time';

/**
 * Returns the earliest date a user may query, or null if they cannot see
 * any historical data beyond the current state.
 *
 * Admins always get all_time access.
 */
export async function getTemporalCutoff(
  userId: string,
  isAdmin: boolean,
): Promise<Date | null> {
  if (isAdmin) return new Date(0); // epoch — unrestricted

  const now = new Date();
  const grant = await prisma.accessGrant.findFirst({
    where: {
      userId,
      resourceType: 'func:temporal',
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    select: { role: true },
  });

  const role = (grant?.role ?? 'current_only') as TemporalRole;

  if (role === 'all_time') return new Date(0);
  if (role === 'rolling_5yr') return new Date(Date.now() - 5 * 365.25 * 24 * 60 * 60 * 1000);
  if (role === 'rolling_2yr') return new Date(Date.now() - 2 * 365.25 * 24 * 60 * 60 * 1000);
  if (role === 'rolling_1yr') return new Date(Date.now() - 365.25 * 24 * 60 * 60 * 1000);
  return null; // current_only — caller should not return historical data
}

// ── List granted resource IDs ─────────────────────────────────────────────────
// Used by org.service.ts to build scoped queries.

export async function getGrantedResourceIds(
  userId: string,
  resourceType: ResourceType,
): Promise<string[]> {
  const now = new Date();
  const grants = await prisma.accessGrant.findMany({
    where: {
      userId,
      resourceType,
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    select: { resourceId: true },
  });

  return grants.map((g) => g.resourceId);
}
