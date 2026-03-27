import { prisma } from '../../config/database';
import type {
  AccountResponse,
  AccountCurrentState,
  CampaignResponse,
  StaffResponse,
} from './org.types';

// ── Account current state ──────────────────────────────────────────────────
// Accounts use an append-only EAV log (account_changes).
// Current state = latest changedAt per property.
// This is resolved at read time — no materialised view needed at this scale.

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
    // Coerce whichever value column is populated to a string
    state[property] =
      change.valueText ??
      change.valueUuid ??
      (change.valueDate ? change.valueDate.toISOString().split('T')[0] : null);
  }

  return state;
}

// ── Accounts ───────────────────────────────────────────────────────────────

export async function listAccounts(): Promise<AccountResponse[]> {
  const accounts = await prisma.account.findMany({
    orderBy: { name: 'asc' },
    include: {
      changes: {
        orderBy: { changedAt: 'desc' },
      },
    },
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

export async function getAccount(id: string): Promise<AccountResponse | null> {
  const account = await prisma.account.findUnique({
    where: { id },
    include: {
      changes: {
        orderBy: { changedAt: 'desc' },
      },
    },
  });

  if (!account) return null;

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
): Promise<CampaignResponse[]> {
  const campaigns = await prisma.campaign.findMany({
    where: { accountId },
    orderBy: { createdAt: 'desc' },
  });

  return campaigns.map(campaignToResponse);
}

export async function getCampaign(
  id: string,
): Promise<CampaignResponse | null> {
  const campaign = await prisma.campaign.findUnique({ where: { id } });
  if (!campaign) return null;
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

export async function listStaff(activeOnly = true): Promise<StaffResponse[]> {
  const staff = await prisma.staff.findMany({
    where: activeOnly ? { status: { in: ['active', 'on_leave'] } } : undefined,
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
