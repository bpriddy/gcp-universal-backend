/**
 * sync-rules.service.ts — Per-email overrides (STUB).
 *
 * Design seam for a future `sync_rules` table that will let admins
 * force-skip or force-keep specific emails without changing code or
 * prompts. Until that table exists, every call returns null and the
 * upstream decision (hard filter → LLM → person-by-default) stands.
 *
 * The shape is intentionally dead simple: one function, returns one of
 * three things per email. Nothing else. When we introduce the table
 * we can add list / upsert / revoke helpers alongside but keep the
 * read path a single lookup.
 *
 * Future table (rough):
 *   sync_rules(
 *     email           text primary key,
 *     decision        text not null,       -- 'always_skip' | 'always_keep'
 *     reason          text,                -- admin-provided note
 *     created_by      uuid references staff(id),
 *     created_at      timestamptz default now()
 *   )
 *
 * Then this function becomes:
 *   const row = await prisma.syncRule.findUnique({ where: { email } });
 *   if (!row) return null;
 *   return { decision: row.decision, reason: row.reason };
 */

export type SyncRuleDecision = 'always_skip' | 'always_keep';

export interface SyncRuleHit {
  decision: SyncRuleDecision;
  /** Admin-provided note — flows into sync_runs.details for auditability. */
  reason: string | null;
}

/**
 * Look up a sync rule for the given email.
 * Returns null when no rule exists (the only return today).
 */
export async function findSyncRule(_email: string): Promise<SyncRuleHit | null> {
  // TODO(sync-rules-table): replace with a DB lookup once the table exists.
  return null;
}
