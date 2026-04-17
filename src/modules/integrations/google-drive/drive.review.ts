/**
 * drive.review.ts — Magic-link review session + decision application.
 *
 * Two public entrypoints:
 *
 *   resolveReviewSession(urlToken)
 *     Token → { reviewer, fieldChanges[], newEntityGroups[], entitySnapshots }
 *     Used by GET /review/:token to render the owner-facing review page.
 *     The token authenticates the bearer as a specific reviewer; we return
 *     ALL of that reviewer's pending proposals (not just the one whose
 *     token was used). Entity snapshots are provided so the UI can render
 *     char-level diffs without needing a second round-trip.
 *
 *   applyDecisions(urlToken, decisions)
 *     Decisions arrive as one of:
 *       - { proposalId, decision: 'approve' | 'reject', overrideValue? }
 *       - { proposalGroupId, decision: 'approve' | 'reject', fieldOverrides? }
 *     Each decision is validated against the URL-token's reviewerStaffId —
 *     cross-owner edits are rejected. Already-decided / expired proposals
 *     yield per-item errors rather than aborting the whole batch.
 *
 * Approval semantics:
 *   field_change + approve
 *     - Insert account_changes/campaign_changes row (previous + new value).
 *     - UPDATE the entity's column to the new value.
 *     - Mark proposal state='applied', applied_change_id=<change row id>.
 *   field_change + reject
 *     - Mark proposal state='rejected'. No entity mutation.
 *   new_entity + approve
 *     - Create a new Account or Campaign row from the group's proposals
 *       (name required; other fields optional).
 *     - Mark all group rows state='applied', applied_change_id=<new entity id>.
 *     - account.owner_staff_id defaults to the reviewer (they just claimed it).
 *     - campaign.created_by = reviewer.
 *   new_entity + reject
 *     - Mark all group rows state='rejected'.
 *
 * Mutations for a single decision run inside a transaction so either every
 * row applies or none does. Different decisions in the same batch are NOT
 * cross-transactional — each is independently committed.
 */

import { Prisma } from '@prisma/client';
import { prisma } from '../../../config/database';
import { logger } from '../../../services/logger';
import {
  ACCOUNT_FIELD_WRITE,
  ACCOUNT_WRITABLE_FIELDS,
  CAMPAIGN_FIELD_WRITE,
  CAMPAIGN_WRITABLE_FIELDS,
  buildAccountCurrentState,
  buildCampaignCurrentState,
  validateProposedValue,
  type AccountWritableField,
  type CampaignWritableField,
  type ChangeValueKind,
  type FieldWriteSpec,
} from './drive.schema';

// ── Errors ──────────────────────────────────────────────────────────────────

export class ReviewTokenError extends Error {
  constructor(public readonly httpStatus: number, message: string) {
    super(message);
    this.name = 'ReviewTokenError';
  }
}

// ── Session resolution ──────────────────────────────────────────────────────

export interface ReviewSession {
  reviewer: { id: string; email: string; fullName: string };
  fieldChanges: FieldChangeItem[];
  newEntityGroups: NewEntityGroup[];
  /** Snapshots keyed by `${entityType}:${entityId}` for char-level diffs. */
  entitySnapshots: Record<string, Record<string, string | null>>;
  proposalTtlDays: number | null;
}

export interface FieldChangeItem {
  proposalId: string;
  entityType: 'account' | 'campaign';
  entityId: string;
  entityName: string;
  property: string;
  currentValue: unknown;
  proposedValue: unknown;
  reasoning: string | null;
  confidence: number | null;
  sourceFileIds: string[];
  expiresAt: string;
  createdAt: string;
}

export interface NewEntityGroup {
  proposalGroupId: string;
  entityType: 'account' | 'campaign';
  parentAccountId: string | null;
  parentAccountName: string | null;
  sourceDriveFolderId: string;
  fields: Array<{ proposalId: string; property: string; proposedValue: unknown }>;
  reasoning: string | null;
  confidence: number | null;
  sourceFileIds: string[];
  expiresAt: string;
  createdAt: string;
}

export async function resolveReviewSession(urlToken: string): Promise<ReviewSession> {
  const entry = await prisma.driveChangeProposal.findUnique({
    where: { reviewToken: urlToken },
    select: { id: true, reviewerStaffId: true, expiresAt: true, state: true },
  });
  if (!entry) throw new ReviewTokenError(404, 'review token not found');
  if (!entry.reviewerStaffId) {
    throw new ReviewTokenError(410, 'proposal has no reviewer — contact an admin');
  }
  if (entry.expiresAt < new Date()) {
    throw new ReviewTokenError(410, 'review link expired');
  }

  const reviewer = await prisma.staff.findUnique({
    where: { id: entry.reviewerStaffId },
    select: { id: true, email: true, fullName: true, status: true },
  });
  if (!reviewer || reviewer.status !== 'active') {
    throw new ReviewTokenError(403, 'reviewer is not active');
  }

  // Load every pending proposal for this reviewer. Field_change rows render
  // individually; new_entity rows collapse into proposal groups.
  const rows = await prisma.driveChangeProposal.findMany({
    where: {
      reviewerStaffId: reviewer.id,
      state: 'pending',
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: 'asc' },
  });

  const fieldChanges: FieldChangeItem[] = [];
  const groupBuckets = new Map<string, typeof rows>();

  for (const row of rows) {
    if (row.kind === 'new_entity') {
      if (!row.proposalGroupId) continue; // defensive
      const bucket = groupBuckets.get(row.proposalGroupId) ?? [];
      bucket.push(row);
      groupBuckets.set(row.proposalGroupId, bucket);
      continue;
    }
    // field_change — needs an entity reference to render the diff
    const entityType = row.entityType as 'account' | 'campaign';
    const entityId = entityType === 'account' ? row.accountId : row.campaignId;
    if (!entityId) continue;
    fieldChanges.push({
      proposalId: row.id,
      entityType,
      entityId,
      entityName: '(unknown)', // filled in below
      property: row.property,
      currentValue: row.currentValue,
      proposedValue: row.proposedValue,
      reasoning: row.reasoning,
      confidence: row.confidence ? Number(row.confidence) : null,
      sourceFileIds: row.sourceFileIds,
      expiresAt: row.expiresAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
    });
  }

  // ── Entity snapshots (for diff rendering) ────────────────────────────────
  const accountIds = Array.from(
    new Set(fieldChanges.filter((c) => c.entityType === 'account').map((c) => c.entityId)),
  );
  const campaignIds = Array.from(
    new Set(fieldChanges.filter((c) => c.entityType === 'campaign').map((c) => c.entityId)),
  );

  const accounts = accountIds.length
    ? await prisma.account.findMany({ where: { id: { in: accountIds } } })
    : [];
  const campaigns = campaignIds.length
    ? await prisma.campaign.findMany({ where: { id: { in: campaignIds } } })
    : [];

  const snapshots: ReviewSession['entitySnapshots'] = {};
  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const campaignById = new Map(campaigns.map((c) => [c.id, c]));
  for (const a of accounts) {
    snapshots[`account:${a.id}`] = buildAccountCurrentState(a);
  }
  for (const c of campaigns) {
    snapshots[`campaign:${c.id}`] = buildCampaignCurrentState(c);
  }

  // Fill in entity names on field_change items now that we have them loaded.
  for (const item of fieldChanges) {
    if (item.entityType === 'account') {
      item.entityName = accountById.get(item.entityId)?.name ?? '(unknown account)';
    } else {
      item.entityName = campaignById.get(item.entityId)?.name ?? '(unknown campaign)';
    }
  }

  // ── New-entity groups ────────────────────────────────────────────────────
  const parentAccountIds = Array.from(
    new Set(
      Array.from(groupBuckets.values())
        .flat()
        .filter((r) => r.entityType === 'campaign' && r.accountId)
        .map((r) => r.accountId as string),
    ),
  );
  const parentAccounts = parentAccountIds.length
    ? await prisma.account.findMany({
        where: { id: { in: parentAccountIds } },
        select: { id: true, name: true },
      })
    : [];
  const parentAccountById = new Map(parentAccounts.map((a) => [a.id, a]));

  const newEntityGroups: NewEntityGroup[] = [];
  for (const [groupId, bucket] of groupBuckets.entries()) {
    const first = bucket[0]!;
    const entityType = first.entityType as 'account' | 'campaign';
    newEntityGroups.push({
      proposalGroupId: groupId,
      entityType,
      parentAccountId: first.accountId ?? null,
      parentAccountName:
        first.accountId ? parentAccountById.get(first.accountId)?.name ?? null : null,
      sourceDriveFolderId: first.sourceDriveFolderId ?? '',
      fields: bucket.map((r) => ({
        proposalId: r.id,
        property: r.property,
        proposedValue: r.proposedValue,
      })),
      reasoning: first.reasoning,
      confidence: first.confidence ? Number(first.confidence) : null,
      sourceFileIds: first.sourceFileIds,
      expiresAt: first.expiresAt.toISOString(),
      createdAt: first.createdAt.toISOString(),
    });
  }

  return {
    reviewer: { id: reviewer.id, email: reviewer.email, fullName: reviewer.fullName },
    fieldChanges,
    newEntityGroups,
    entitySnapshots: snapshots,
    proposalTtlDays: null,
  };
}

// ── Decision application ────────────────────────────────────────────────────

export type Decision =
  | {
      proposalId: string;
      decision: 'approve' | 'reject';
      overrideValue?: string | null;
    }
  | {
      proposalGroupId: string;
      decision: 'approve' | 'reject';
      fieldOverrides?: Record<string, string | null>;
    };

export interface ApplyDecisionsResult {
  approved: number;
  rejected: number;
  errors: Array<{ target: string; reason: string }>;
}

export async function applyDecisions(
  urlToken: string,
  decisions: Decision[],
): Promise<ApplyDecisionsResult> {
  const entry = await prisma.driveChangeProposal.findUnique({
    where: { reviewToken: urlToken },
    select: { reviewerStaffId: true, expiresAt: true },
  });
  if (!entry) throw new ReviewTokenError(404, 'review token not found');
  if (!entry.reviewerStaffId) {
    throw new ReviewTokenError(410, 'proposal has no reviewer — contact an admin');
  }
  if (entry.expiresAt < new Date()) {
    throw new ReviewTokenError(410, 'review link expired');
  }

  const reviewer = await prisma.staff.findUnique({
    where: { id: entry.reviewerStaffId },
    select: { id: true, status: true },
  });
  if (!reviewer || reviewer.status !== 'active') {
    throw new ReviewTokenError(403, 'reviewer is not active');
  }

  const result: ApplyDecisionsResult = { approved: 0, rejected: 0, errors: [] };

  for (const d of decisions) {
    try {
      if ('proposalGroupId' in d) {
        await applyGroupDecision(reviewer.id, d);
      } else {
        await applySingleDecision(reviewer.id, d);
      }
      if (d.decision === 'approve') result.approved++;
      else result.rejected++;
    } catch (err) {
      const target = 'proposalGroupId' in d ? d.proposalGroupId : d.proposalId;
      const reason = err instanceof Error ? err.message : String(err);
      result.errors.push({ target, reason });
      logger.warn({ target, reason }, '[drive.review] decision failed');
    }
  }

  return result;
}

// ── Single field_change decision ────────────────────────────────────────────

async function applySingleDecision(
  reviewerStaffId: string,
  d: { proposalId: string; decision: 'approve' | 'reject'; overrideValue?: string | null },
): Promise<void> {
  const prop = await prisma.driveChangeProposal.findUnique({ where: { id: d.proposalId } });
  if (!prop) throw new Error('proposal not found');
  if (prop.reviewerStaffId !== reviewerStaffId) {
    throw new Error('proposal belongs to a different reviewer');
  }
  if (prop.state !== 'pending') throw new Error(`proposal already ${prop.state}`);
  if (prop.expiresAt < new Date()) throw new Error('proposal expired');
  if (prop.kind !== 'field_change') {
    throw new Error('use proposalGroupId for new_entity decisions');
  }

  if (d.decision === 'reject') {
    await prisma.driveChangeProposal.update({
      where: { id: prop.id },
      data: {
        state: 'rejected',
        decidedAt: new Date(),
        decidedBy: reviewerStaffId,
      },
    });
    return;
  }

  // Approve → figure out the target column + value shape.
  const entityType = prop.entityType as 'account' | 'campaign';
  const writeSpec = getFieldWriteSpec(entityType, prop.property);

  // Re-validate the override (or the stored proposed value) against the
  // schema. We refuse to write values we wouldn't have accepted in the
  // first place — the owner's override still has to obey the allowlist.
  const rawValue =
    d.overrideValue !== undefined ? d.overrideValue : extractProposedString(prop.proposedValue);
  const validation = validateProposedValue(entityType, prop.property, rawValue);
  if (!validation.ok) {
    throw new Error(`approve: value failed validation — ${validation.reason}`);
  }
  const finalValue = validation.value as unknown;

  await prisma.$transaction(async (tx) => {
    // Insert *_changes row + UPDATE the entity column + mark proposal applied.
    const newCols = projectValue(writeSpec.changeKind, finalValue, 'new');
    const oldCols = projectValue(
      writeSpec.changeKind,
      extractCurrentScalar(prop.currentValue),
      'previous',
    );
    const entityCast = castToEntity(writeSpec.changeKind, finalValue);

    let changeRowId: string;
    if (entityType === 'account') {
      if (!prop.accountId) throw new Error('account proposal missing accountId');
      const row = await tx.accountChange.create({
        data: {
          accountId: prop.accountId,
          property: prop.property,
          ...oldCols,
          ...newCols,
          changedBy: reviewerStaffId,
        },
      });
      changeRowId = row.id;
      await tx.account.update({
        where: { id: prop.accountId },
        data: {
          [writeSpec.entityColumn]: entityCast,
        } as Prisma.AccountUpdateInput,
      });
    } else {
      if (!prop.campaignId) throw new Error('campaign proposal missing campaignId');
      const row = await tx.campaignChange.create({
        data: {
          campaignId: prop.campaignId,
          property: prop.property,
          ...oldCols,
          ...newCols,
          changedBy: reviewerStaffId,
        },
      });
      changeRowId = row.id;
      await tx.campaign.update({
        where: { id: prop.campaignId },
        data: {
          [writeSpec.entityColumn]: entityCast,
        } as Prisma.CampaignUpdateInput,
      });
    }

    await tx.driveChangeProposal.update({
      where: { id: prop.id },
      data: {
        state: 'applied',
        decidedAt: new Date(),
        decidedBy: reviewerStaffId,
        appliedChangeId: changeRowId,
      },
    });
  });
}

// ── New-entity group decision ───────────────────────────────────────────────

async function applyGroupDecision(
  reviewerStaffId: string,
  d: {
    proposalGroupId: string;
    decision: 'approve' | 'reject';
    fieldOverrides?: Record<string, string | null>;
  },
): Promise<void> {
  const rows = await prisma.driveChangeProposal.findMany({
    where: { proposalGroupId: d.proposalGroupId },
  });
  if (rows.length === 0) throw new Error('proposal group not found');
  const first = rows[0]!;
  if (first.reviewerStaffId !== reviewerStaffId) {
    throw new Error('group belongs to a different reviewer');
  }
  if (first.kind !== 'new_entity') {
    throw new Error('group is not a new_entity kind');
  }
  for (const r of rows) {
    if (r.state !== 'pending') throw new Error(`row ${r.id} already ${r.state}`);
    if (r.expiresAt < new Date()) throw new Error('group expired');
  }

  if (d.decision === 'reject') {
    await prisma.driveChangeProposal.updateMany({
      where: { proposalGroupId: d.proposalGroupId },
      data: {
        state: 'rejected',
        decidedAt: new Date(),
        decidedBy: reviewerStaffId,
      },
    });
    return;
  }

  // Approve: create the new entity from rows (+ any field overrides).
  const entityType = first.entityType as 'account' | 'campaign';
  const byProperty = new Map<string, unknown>();
  for (const r of rows) byProperty.set(r.property, extractProposedString(r.proposedValue));
  for (const [k, v] of Object.entries(d.fieldOverrides ?? {})) byProperty.set(k, v);

  const name = byProperty.get('name');
  if (typeof name !== 'string' || !name.trim()) {
    throw new Error('new_entity group missing `name`');
  }

  // Validate every non-name field before write.
  const writableFields: readonly string[] =
    entityType === 'account' ? ACCOUNT_WRITABLE_FIELDS : CAMPAIGN_WRITABLE_FIELDS;
  const writeData: Record<string, unknown> = {};
  for (const field of writableFields) {
    if (!byProperty.has(field)) continue;
    const raw = byProperty.get(field);
    if (raw === null || raw === undefined || raw === '') continue;
    const validation = validateProposedValue(entityType, field, raw);
    if (!validation.ok) {
      throw new Error(`override for ${field} failed validation — ${validation.reason}`);
    }
    const spec = getFieldWriteSpec(entityType, field);
    writeData[spec.entityColumn] = castToEntity(spec.changeKind, validation.value);
  }

  await prisma.$transaction(async (tx) => {
    let newEntityId: string;
    if (entityType === 'account') {
      // Spread first so required identity fields (name, ownerStaffId,
      // driveFolderId) always win over any stray writable-field entries.
      const created = await tx.account.create({
        data: {
          ...(writeData as Prisma.AccountUncheckedCreateInput),
          name: name.trim(),
          ownerStaffId: reviewerStaffId, // reviewer claims ownership
          driveFolderId: first.sourceDriveFolderId,
        },
      });
      newEntityId = created.id;
    } else {
      if (!first.accountId) throw new Error('new_entity campaign group missing parent accountId');
      const created = await tx.campaign.create({
        data: {
          ...(writeData as Partial<Prisma.CampaignUncheckedCreateInput>),
          name: name.trim(),
          accountId: first.accountId,
          createdBy: reviewerStaffId,
          driveFolderId: first.sourceDriveFolderId,
        } as Prisma.CampaignUncheckedCreateInput,
      });
      newEntityId = created.id;
    }

    await tx.driveChangeProposal.updateMany({
      where: { proposalGroupId: d.proposalGroupId },
      data: {
        state: 'applied',
        decidedAt: new Date(),
        decidedBy: reviewerStaffId,
        appliedChangeId: newEntityId,
      },
    });
  });
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function getFieldWriteSpec(entity: 'account' | 'campaign', field: string): FieldWriteSpec {
  const spec =
    entity === 'account'
      ? (ACCOUNT_FIELD_WRITE as Record<string, FieldWriteSpec>)[field]
      : (CAMPAIGN_FIELD_WRITE as Record<string, FieldWriteSpec>)[field];
  if (!spec) throw new Error(`no write spec for ${entity}.${field}`);
  return spec;
}

/**
 * Proposals store proposed_value as JSON. In practice drive.distill writes a
 * scalar (string | number | null). Unwrap to the scalar representation we
 * use elsewhere (strings for everything except numeric budget; null means
 * "clear this field").
 */
function extractProposedString(value: Prisma.JsonValue | null): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null; // arrays/objects are unexpected for field_change proposals
}

function extractCurrentScalar(value: Prisma.JsonValue | null): unknown {
  if (value === null || value === undefined) return null;
  return value;
}

/**
 * Shape a scalar into the right *_changes column for its kind. `side=new`
 * produces value_text/value_uuid/value_date; `side=previous` produces the
 * previous_value_* variants. Entity-column cast is a separate concern handled
 * by castToEntity() below.
 */
function projectValue(
  kind: ChangeValueKind,
  value: unknown,
  side: 'new' | 'previous',
): Record<string, string | Date | null> {
  const keyPrefix = side === 'new' ? 'value' : 'previousValue';
  const suffix = kind === 'text' ? 'Text' : kind === 'uuid' ? 'Uuid' : 'Date';
  const key = `${keyPrefix}${suffix}`;

  if (value === null || value === undefined) {
    return { [key]: null };
  }
  if (kind === 'date') {
    const s = typeof value === 'string' ? value : String(value);
    return { [key]: new Date(`${s}T00:00:00Z`) };
  }
  const s = typeof value === 'string' ? value : String(value);
  return { [key]: s };
}

function castToEntity(kind: ChangeValueKind, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  switch (kind) {
    case 'text':
      return typeof value === 'string' ? value : String(value);
    case 'uuid':
      return typeof value === 'string' ? value : String(value);
    case 'date': {
      const s = typeof value === 'string' ? value : String(value);
      return new Date(`${s}T00:00:00Z`);
    }
  }
}
