/**
 * drive.schema.ts — Allowlists + validators for Drive-sync field proposals.
 *
 * This is the single source of truth for:
 *   1. Which entity fields Gemini is allowed to propose changes to.
 *      (These become the `field` enum in the Gemini responseSchema.)
 *   2. How each field's proposed_value must be shaped before we accept it.
 *   3. How to build the `current_state_json` we send to the LLM so it can
 *      decide "is this actually a change?" before emitting an observation.
 *
 * Adding a new Drive-writable field is designed to be cheap:
 *   - add the column via migration
 *   - add the field key to the *_WRITABLE_FIELDS tuple
 *   - add a Zod validator to *_FIELD_VALIDATORS
 *   - extend the *_CURRENT_STATE builder to include it
 * No prompt edits required — the schema carries the structure.
 */

import { z } from 'zod';
import type { Account, Campaign } from '@prisma/client';

// ── Account ─────────────────────────────────────────────────────────────────

export const ACCOUNT_WRITABLE_FIELDS = [
  'status',
  'account_exec_staff_id',
  'industry',
  'primary_contact_name',
  'primary_contact_email',
  'notes',
] as const;
export type AccountWritableField = (typeof ACCOUNT_WRITABLE_FIELDS)[number];

/**
 * Per-field validators. Each validator receives the `proposed_value` the LLM
 * returns (always a string in the responseSchema, since Gemini's structured
 * output doesn't support union types) and decides whether to accept it and
 * what to coerce it to.
 */
export const ACCOUNT_FIELD_VALIDATORS = {
  status: z
    .string()
    .nullable()
    .transform((v) => (v === null || v === '' ? null : v))
    .pipe(z.enum(['active', 'inactive', 'prospect']).nullable()),
  account_exec_staff_id: z
    .string()
    .nullable()
    .transform((v) => (v === null || v === '' ? null : v))
    .pipe(z.string().uuid().nullable()),
  industry: z.string().max(128).nullable(),
  primary_contact_name: z.string().max(256).nullable(),
  primary_contact_email: z
    .string()
    .nullable()
    .transform((v) => (v === null || v === '' ? null : v))
    .pipe(z.string().email().nullable()),
  notes: z.string().max(4000).nullable(),
} as const satisfies Record<AccountWritableField, z.ZodTypeAny>;

/** Fields whose equality check falls back to case-insensitive trimmed equality. */
export const ACCOUNT_FREE_TEXT_FIELDS: ReadonlySet<AccountWritableField> = new Set([
  'industry',
  'primary_contact_name',
  'notes',
]);

export type AccountCurrentState = {
  [K in AccountWritableField]: string | null;
};

export function buildAccountCurrentState(a: Pick<
  Account,
  | 'status'
  | 'accountExecStaffId'
  | 'industry'
  | 'primaryContactName'
  | 'primaryContactEmail'
  | 'notes'
>): AccountCurrentState {
  return {
    status: a.status ?? null,
    account_exec_staff_id: a.accountExecStaffId ?? null,
    industry: a.industry ?? null,
    primary_contact_name: a.primaryContactName ?? null,
    primary_contact_email: a.primaryContactEmail ?? null,
    notes: a.notes ?? null,
  };
}

// ── Campaign ────────────────────────────────────────────────────────────────

export const CAMPAIGN_WRITABLE_FIELDS = [
  'status',
  'budget',
  'awarded_at',
  'live_at',
  'ends_at',
] as const;
export type CampaignWritableField = (typeof CAMPAIGN_WRITABLE_FIELDS)[number];

const dateString = z
  .string()
  .nullable()
  .transform((v) => (v === null || v === '' ? null : v))
  .pipe(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD').nullable());

export const CAMPAIGN_FIELD_VALIDATORS = {
  status: z
    .string()
    .nullable()
    .transform((v) => (v === null || v === '' ? null : v))
    .pipe(z.enum(['pitch', 'awarded', 'live', 'ended', 'lost']).nullable()),
  budget: z
    .union([z.string(), z.number(), z.null()])
    .transform((v) => {
      if (v === null || v === '') return null;
      const n = typeof v === 'number' ? v : Number(v);
      return Number.isFinite(n) ? n : null;
    })
    .pipe(z.number().positive().nullable()),
  awarded_at: dateString,
  live_at: dateString,
  ends_at: dateString,
} as const satisfies Record<CampaignWritableField, z.ZodTypeAny>;

export const CAMPAIGN_FREE_TEXT_FIELDS: ReadonlySet<CampaignWritableField> = new Set();

export type CampaignCurrentState = {
  [K in CampaignWritableField]: string | null;
};

export function buildCampaignCurrentState(c: Pick<
  Campaign,
  'status' | 'budget' | 'awardedAt' | 'liveAt' | 'endsAt'
>): CampaignCurrentState {
  return {
    status: c.status ?? null,
    budget: c.budget ? c.budget.toString() : null,
    awarded_at: c.awardedAt ? c.awardedAt.toISOString().slice(0, 10) : null,
    live_at: c.liveAt ? c.liveAt.toISOString().slice(0, 10) : null,
    ends_at: c.endsAt ? c.endsAt.toISOString().slice(0, 10) : null,
  };
}

// ── Apply/write specs (used by drive.review on approval) ───────────────────
//
// Each writable field tells the approval code:
//   - entityColumn: the Prisma model property to update on the entity
//   - changeKind:   which value_* column on *_changes receives the value
//                   ('text' covers free text + enums + decimals serialized as
//                    strings; 'uuid' maps to value_uuid; 'date' to value_date)
//
// Keeping this alongside the validators so adding a new writable field remains
// a one-file edit.

export type ChangeValueKind = 'text' | 'uuid' | 'date';

export interface FieldWriteSpec {
  entityColumn: string;
  changeKind: ChangeValueKind;
}

export const ACCOUNT_FIELD_WRITE: Record<AccountWritableField, FieldWriteSpec> = {
  status: { entityColumn: 'status', changeKind: 'text' },
  account_exec_staff_id: { entityColumn: 'accountExecStaffId', changeKind: 'uuid' },
  industry: { entityColumn: 'industry', changeKind: 'text' },
  primary_contact_name: { entityColumn: 'primaryContactName', changeKind: 'text' },
  primary_contact_email: { entityColumn: 'primaryContactEmail', changeKind: 'text' },
  notes: { entityColumn: 'notes', changeKind: 'text' },
};

export const CAMPAIGN_FIELD_WRITE: Record<CampaignWritableField, FieldWriteSpec> = {
  status: { entityColumn: 'status', changeKind: 'text' },
  budget: { entityColumn: 'budget', changeKind: 'text' }, // decimal audit as string
  awarded_at: { entityColumn: 'awardedAt', changeKind: 'date' },
  live_at: { entityColumn: 'liveAt', changeKind: 'date' },
  ends_at: { entityColumn: 'endsAt', changeKind: 'date' },
};

// ── Utilities shared by interpret/distill ───────────────────────────────────

/**
 * Validate a proposed_value for a given (entity, field). Returns either a
 * normalized value or a reason the proposal should be rejected (logged as
 * ambiguous, not emitted as a proposal).
 */
export type ValidationResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: string };

export function validateProposedValue(
  entity: 'account' | 'campaign',
  field: string,
  raw: unknown,
): ValidationResult {
  const validators = entity === 'account' ? ACCOUNT_FIELD_VALIDATORS : CAMPAIGN_FIELD_VALIDATORS;
  const validator = (validators as Record<string, z.ZodTypeAny>)[field];
  if (!validator) {
    return { ok: false, reason: `field "${field}" is not in the ${entity} writable allowlist` };
  }
  const result = validator.safeParse(raw);
  if (!result.success) {
    return { ok: false, reason: result.error.issues.map((i) => i.message).join('; ') };
  }
  return { ok: true, value: result.data };
}

/**
 * Case-insensitive, whitespace-trim equality — the fallback comparator for
 * free-text fields so the LLM can't re-propose a semantically-identical
 * value by tweaking punctuation. Not a substitute for real similarity;
 * good enough for the v0 no-op filter.
 */
export function looseEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a == null && b == null;
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function isFreeTextField(entity: 'account' | 'campaign', field: string): boolean {
  return entity === 'account'
    ? ACCOUNT_FREE_TEXT_FIELDS.has(field as AccountWritableField)
    : CAMPAIGN_FREE_TEXT_FIELDS.has(field as CampaignWritableField);
}

/**
 * Decide whether a proposed value is a no-op against current state.
 * Strict equality for enums/IDs/dates/numbers; case-insensitive trimmed
 * equality for free-text fields.
 */
export function isNoOpChange(
  entity: 'account' | 'campaign',
  field: string,
  current: unknown,
  proposed: unknown,
): boolean {
  if (isFreeTextField(entity, field)) return looseEquals(current, proposed);
  // Normalize null-ish for strict comparison.
  const c = current === undefined ? null : current;
  const p = proposed === undefined ? null : proposed;
  if (c === null && p === null) return true;
  if (c === null || p === null) return false;
  return c === p;
}
