/**
 * staff-classifier module — Is this directory entry a person or a service account?
 *
 * Three-layer decision pipeline:
 *
 *   1. Hard filters (src/modules/staff-classifier/hard-filters.ts)
 *      Deterministic, source-of-truth bright-line skips: missing data,
 *      external domain, RFC no-reply addresses.
 *
 *   2. Sync rules (src/modules/staff-classifier/sync-rules.service.ts)
 *      Per-email overrides from an admin-managed table. Stubbed today;
 *      future DB table lets admins force-skip or force-keep a specific
 *      email without touching prompts or code.
 *
 *   3. LLM classifier (src/modules/staff-classifier/llm-classifier.ts)
 *      Batched Gemini call with structured output. Greedy-keep bias —
 *      the prompt (prompt_presets.staff.classify_v1) explicitly prefers
 *      false positives ("service account let through") over false
 *      negatives ("real staff dropped"). On any LLM failure the entry
 *      falls through as 'person'.
 *
 * Source-agnostic: accepts any { email, displayName } pairs. Google
 * Directory is today's source but the classifier has no dependency on it.
 *
 * Usage:
 *   const classifications = await classifyEntries(entries);
 *   // classifications[i] corresponds to entries[i]
 */

import { applyHardFilters } from './hard-filters';
import { classifyWithLlm } from './llm-classifier';
import { findSyncRule } from './sync-rules.service';
import type { ClassifierInput, Classification } from './types';

export type { ClassifierInput, Classification, SkipReason } from './types';

/**
 * Classify a batch of directory entries.
 * Order of output matches order of input (1:1).
 */
export async function classifyEntries(
  entries: ClassifierInput[],
): Promise<Classification[]> {
  if (entries.length === 0) return [];

  // Track results by the index of the ORIGINAL entry so we can rebuild
  // the output in the right order after running each layer.
  const results: Array<Classification | null> = entries.map(() => null);

  // ── Layer 2 first: sync rule overrides take precedence over every
  // other layer. They're how admins correct the LLM without editing it.
  const survivors: Array<{ entry: ClassifierInput; index: number }> = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    const rule = await findSyncRule(entry.email);
    if (!rule) {
      survivors.push({ entry, index: i });
      continue;
    }
    if (rule.decision === 'always_skip') {
      results[i] = {
        kind: 'skip',
        input: entry,
        reason: 'sync_rule',
        detail: rule.reason ? `sync rule: ${rule.reason}` : 'sync rule: always_skip',
        source: 'sync_rule',
      };
    } else {
      results[i] = {
        kind: 'person',
        input: entry,
        source: 'sync_rule',
        reason: rule.reason ?? 'sync rule: always_keep',
      };
    }
  }

  // ── Layer 1: hard filters on survivors.
  const hardInput = survivors.map((s) => s.entry);
  const { kept, skipped } = applyHardFilters(hardInput);

  // Map hard-filter skips back to their original indexes.
  // hard-filter results come back interleaved; we match by identity.
  const skippedByRef = new Map<ClassifierInput, Classification>();
  for (const s of skipped) skippedByRef.set(s.input, s);

  const llmInputs: Array<{ entry: ClassifierInput; index: number }> = [];
  for (const { entry, index } of survivors) {
    const skip = skippedByRef.get(entry);
    if (skip) {
      results[index] = skip;
    } else {
      llmInputs.push({ entry, index });
    }
  }

  // ── Layer 3: LLM classifies what's left.
  if (llmInputs.length > 0) {
    const llmResults = await classifyWithLlm(llmInputs.map((x) => x.entry));
    for (let i = 0; i < llmInputs.length; i++) {
      const { index } = llmInputs[i]!;
      results[index] = llmResults[i]!;
    }
  }

  // Double-check: every slot filled. Defensive against bugs in the
  // routing above — any null left here is a developer error.
  for (let i = 0; i < results.length; i++) {
    if (results[i] === null) {
      // Safest thing to do is greedy-keep. This path should never fire.
      results[i] = {
        kind: 'person',
        input: entries[i]!,
        source: 'llm',
        reason: 'greedy fallback (classifier routing bug)',
      };
    }
  }

  return results as Classification[];
}
