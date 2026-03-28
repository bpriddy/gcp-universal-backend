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

// ── Core upsert ───────────────────────────────────────────────────────────
// Prisma cannot upsert on a partial unique index (WHERE revoked_at IS NULL),
// so we use findFirst + update-or-create inside a transaction.
// Safe at this scale — grant calls cover 1 account + N campaigns at most.

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
        revokedAt: null,
        revokedBy: null,
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

// ── Grant ─────────────────────────────────────────────────────────────────

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
    // Grant account access
    await upsertGrant(tx, {
      userId,
      resourceType: 'account',
      resourceId: accountId,
      role,
      grantedBy,
      expiresAt,
    });

    // Grant access to each campaign
    for (const campaignId of campaignIds) {
      await upsertGrant(tx, {
        userId,
        resourceType: 'campaign',
        resourceId: campaignId,
        role,
        grantedBy,
        expiresAt,
      });
    }
  });

  return { account: 1, campaigns: campaignIds.length };
}

// ── Revoke ────────────────────────────────────────────────────────────────

export async function revokeAccess(params: RevokeAccessParams): Promise<void> {
  const { userId, resourceType, resourceId, revokedBy } = params;

  const grant = await prisma.accessGrant.findFirst({
    where: { userId, resourceType, resourceId, revokedAt: null },
  });

  if (!grant) return; // Already revoked or never granted — idempotent

  await prisma.accessGrant.update({
    where: { id: grant.id },
    data: { revokedAt: new Date(), revokedBy },
  });
}

// ── Check ─────────────────────────────────────────────────────────────────

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

// ── List granted resource IDs ─────────────────────────────────────────────
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
