/**
 * staff-classifier types.
 *
 * The classifier answers one question: "is this directory entry a real
 * staff member, or a group mailbox / service account / automation identity
 * that should not be synced into the staff table?"
 *
 * Source-agnostic by design. Today the inputs come from Google Workspace
 * Directory; tomorrow they may come from Okta, BambooHR, or anything else
 * that can produce (email, displayName) pairs.
 */

export interface ClassifierInput {
  email: string;
  displayName: string;
}

/**
 * Why an entry was NOT classified as a person.
 *
 * Two deterministic hard rules run before the LLM (unmappable,
 * external_domain). Everything else that gets skipped goes through the
 * 'service_account' channel with an LLM reason string — including things
 * that used to be hardcoded like noreply@ / bounce@ / mailer-daemon@.
 */
export type SkipReason =
  | 'unmappable'      // no email OR no displayName — can't build a staff record
  | 'external_domain' // email not on primary domain — not ours to sync
  | 'service_account' // LLM-determined: group mailbox, bot, automation, no-reply
  | 'sync_rule';      // explicit override from the (future) sync_rules table

export interface PersonClassification {
  kind: 'person';
  input: ClassifierInput;
  /** LLM confidence (0–1) in the 'person' classification. Omitted for hard-rule keeps. */
  confidence?: number;
  /** LLM reason (short phrase) when available. Omitted for hard-rule keeps. */
  reason?: string;
  /** Which layer produced this decision. */
  source: 'hard_filter' | 'llm' | 'sync_rule';
}

export interface SkipClassification {
  kind: 'skip';
  input: ClassifierInput;
  reason: SkipReason;
  /** Human-readable detail — used in sync_runs.details.skipped.detail. */
  detail: string;
  /** LLM confidence (0–1) when the skip came from the LLM. */
  confidence?: number;
  /** Which layer produced the decision. */
  source: 'hard_filter' | 'llm' | 'sync_rule';
}

export type Classification = PersonClassification | SkipClassification;
