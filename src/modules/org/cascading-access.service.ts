/**
 * cascading-access.service.ts — High-level access operations that cascade
 * across related resources.
 *
 * These functions translate semantic commands like "give full access to
 * the Budweiser account" into the correct set of granular access grants.
 *
 * Cascading logic:
 *   "Full access to an account" means:
 *     - Grant on the account itself
 *     - Grant on every campaign under the account
 *     - Grant on the team associated with the account (if any)
 *     - Functional grants (e.g. temporal access for history)
 *
 *   "Remove from an account" means:
 *     - Revoke the account grant
 *     - Revoke all campaign grants under the account
 *     - Revoke the team grant (if any)
 *     - Revoke associated functional grants
 *
 * All operations are atomic (single transaction) and fully audit-logged.
 */

import { prisma } from '../../config/database';
import { logger } from '../../services/logger';

// ── Types ────────────────────────────────────────────────────────────────────

export type CascadeRole = 'viewer' | 'contributor' | 'manager' | 'admin';

export interface CascadeGrantParams {
  /** The user receiving access */
  userId: string;
  /** Account ID to grant access to */
  accountId: string;
  /** Role to assign across all resources */
  role: CascadeRole;
  /** Staff ID of the person granting access (for audit) */
  grantedBy: string;
  /** Optional expiration */
  expiresAt?: Date;
  /** Also grant temporal (history) access? Defaults to rolling_1yr for viewers, all_time for managers+ */
  includeTemporalAccess?: boolean;
}

export interface CascadeGrantResult {
  accountGrants: number;
  campaignGrants: number;
  teamGrants: number;
  functionalGrants: number;
  totalGrants: number;
}

export interface CascadeRevokeParams {
  /** The user losing access */
  userId: string;
  /** Account ID to revoke access from */
  accountId: string;
  /** Staff ID of the person revoking access (for audit) */
  revokedBy: string;
}

export interface CascadeRevokeResult {
  grantsRevoked: number;
}

// ── Grant ────────────────────────────────────────────────────────────────────

/**
 * Grant cascading access to an account and all its related resources.
 */
export async function grantFullAccountAccess(
  params: CascadeGrantParams,
): Promise<CascadeGrantResult> {
  const { userId, accountId, role, grantedBy, expiresAt } = params;
  const includeTemporalAccess = params.includeTemporalAccess ?? true;

  // Resolve all related resources
  const [campaigns, account] = await Promise.all([
    prisma.campaign.findMany({
      where: { accountId },
      select: { id: true },
    }),
    prisma.account.findUnique({
      where: { id: accountId },
      select: { id: true, name: true },
    }),
  ]);

  if (!account) {
    throw new Error(`Account not found: ${accountId}`);
  }

  // TODO: Resolve team associated with account.
  // This requires a convention for linking accounts to teams.
  // Options: a join table, a metadata entry, or a naming convention.
  // For now, team grants are skipped.

  const now = new Date();
  let totalGrants = 0;
  let campaignGrants = 0;
  let teamGrants = 0;
  let functionalGrants = 0;

  await prisma.$transaction(async (tx) => {
    // 1. Account grant
    await upsertGrant(tx, { userId, resourceType: 'account', resourceId: accountId, role, grantedBy, expiresAt });
    totalGrants++;

    // 2. Campaign grants
    for (const campaign of campaigns) {
      await upsertGrant(tx, { userId, resourceType: 'campaign', resourceId: campaign.id, role, grantedBy, expiresAt });
      campaignGrants++;
      totalGrants++;
    }

    // 3. Functional: temporal access
    if (includeTemporalAccess) {
      const temporalRole = (role === 'viewer' || role === 'contributor') ? 'rolling_1yr' : 'all_time';
      await upsertGrant(tx, {
        userId,
        resourceType: 'func:temporal' as string,
        resourceId: accountId, // scoped to this account
        role: temporalRole,
        grantedBy,
        expiresAt,
      });
      functionalGrants++;
      totalGrants++;
    }

    // 4. Audit log
    await tx.auditLog.create({
      data: {
        action: 'cascade_grant',
        entityType: 'account',
        entityId: accountId,
        actorId: grantedBy,
        after: {
          userId,
          accountId,
          accountName: account.name,
          role,
          campaignCount: campaigns.length,
          includeTemporalAccess,
        } as Record<string, unknown>,
      },
    });
  });

  logger.info(
    { userId, accountId, accountName: account.name, role, totalGrants },
    'Cascading access granted',
  );

  return {
    accountGrants: 1,
    campaignGrants,
    teamGrants,
    functionalGrants,
    totalGrants,
  };
}

// ── Revoke ───────────────────────────────────────────────────────────────────

/**
 * Revoke all access a user has to an account and its related resources.
 */
export async function revokeFullAccountAccess(
  params: CascadeRevokeParams,
): Promise<CascadeRevokeResult> {
  const { userId, accountId, revokedBy } = params;

  // Find all campaigns under this account
  const campaigns = await prisma.campaign.findMany({
    where: { accountId },
    select: { id: true },
  });

  const resourceIds = [accountId, ...campaigns.map((c) => c.id)];
  const now = new Date();

  // Find all active grants for these resources
  const activeGrants = await prisma.accessGrant.findMany({
    where: {
      userId,
      resourceId: { in: resourceIds },
      revokedAt: null,
    },
  });

  // Also find functional grants scoped to this account
  const functionalGrants = await prisma.accessGrant.findMany({
    where: {
      userId,
      resourceType: { startsWith: 'func:' },
      resourceId: accountId,
      revokedAt: null,
    },
  });

  const allGrants = [...activeGrants, ...functionalGrants];

  if (allGrants.length === 0) {
    return { grantsRevoked: 0 };
  }

  await prisma.$transaction(async (tx) => {
    // Revoke all grants
    await tx.accessGrant.updateMany({
      where: {
        id: { in: allGrants.map((g) => g.id) },
      },
      data: {
        revokedAt: now,
        revokedBy,
      },
    });

    // Audit log
    await tx.auditLog.create({
      data: {
        action: 'cascade_revoke',
        entityType: 'account',
        entityId: accountId,
        actorId: revokedBy,
        before: {
          userId,
          accountId,
          grantsRevoked: allGrants.length,
          grantIds: allGrants.map((g) => g.id),
        } as Record<string, unknown>,
      },
    });
  });

  logger.info(
    { userId, accountId, grantsRevoked: allGrants.length },
    'Cascading access revoked',
  );

  return { grantsRevoked: allGrants.length };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function upsertGrant(
  tx: Omit<typeof prisma, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>,
  params: {
    userId: string;
    resourceType: string;
    resourceId: string;
    role: string;
    grantedBy: string;
    expiresAt?: Date | undefined;
  },
): Promise<void> {
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
      },
    });
  } else {
    await tx.accessGrant.create({
      data: {
        userId: params.userId,
        resourceType: params.resourceType,
        resourceId: params.resourceId,
        role: params.role,
        grantedBy: params.grantedBy,
        expiresAt: params.expiresAt ?? null,
      },
    });
  }
}
