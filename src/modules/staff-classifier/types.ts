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

/**
 * Aggregate stats for a single classifyEntries() call. Surfaced in the
 * sync run log so operators can answer "what did the LLM actually do?"
 * without tailing application logs.
 */
export interface ClassifierStats {
  /** Total inputs received by classifyEntries. */
  totalInput: number;
  /** Eliminated by sync-rule overrides. Zero until the table exists. */
  syncRuleHits: number;
  /** Eliminated by hard filters (unmappable + external_domain). */
  hardFilterSkips: number;
  /** Inputs that reached the LLM. */
  llmInputs: number;
  /** Batches sent to Gemini. */
  llmBatches: number;
  /** Retry calls (diff-and-rerequest for items missing from first pass). */
  llmRetries: number;
  /** Entries where the LLM call errored or dropped the item — greedy-kept as person. */
  llmFallbacks: number;
  /** Total wall-clock time inside classifyWithLlm, ms. */
  llmDurationMs: number;
  /** LLM persons: how many came back as 'person' from the model. */
  llmKeptAsPerson: number;
  /** LLM skips: how many came back as 'service_account'. */
  llmSkippedAsService: number;
  /**
   * A few LLM 'person' decisions with their reason + confidence — so the
   * sync log shows the model's judgment on KEPT staff, not just skips.
   */
  sampleKept: Array<{ email: string; reason: string; confidence: number }>;
}
