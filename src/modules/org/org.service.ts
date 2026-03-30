import { prisma } from '../../config/database';
import { checkAccess, getGrantedResourceIds } from './access.service';
import { AccessDeniedError } from './org.types';
import type {
  AccountResponse,
  AccountCurrentState,
  CampaignResponse,
  StaffResponse,
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
// Staff is a directory — any authenticated user can read it.
// No access_grants check applied.

export async function listStaff(activeOnly = true): Promise<StaffResponse[]> {
  const staff = await prisma.staff.findMany({
    ...(activeOnly ? { where: { status: { in: ['active', 'on_leave'] } } } : {}),
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
