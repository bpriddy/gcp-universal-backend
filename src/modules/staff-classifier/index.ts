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
import type { ClassifierInput, Classification, ClassifierStats } from './types';

export type { ClassifierInput, Classification, ClassifierStats, SkipReason } from './types';

export interface ClassifyEntriesResult {
  classifications: Classification[];
  stats: ClassifierStats;
}

/**
 * Classify a batch of directory entries.
 * Order of `classifications` matches order of input (1:1).
 * `stats` describes what each layer did — surface it in the sync log.
 */
export async function classifyEntries(
  entries: ClassifierInput[],
): Promise<ClassifyEntriesResult> {
  const baseStats: ClassifierStats = {
    totalInput: entries.length,
    syncRuleHits: 0,
    hardFilterSkips: 0,
    llmInputs: 0,
    llmBatches: 0,
    llmRetries: 0,
    llmFallbacks: 0,
    llmDurationMs: 0,
    llmKeptAsPerson: 0,
    llmSkippedAsService: 0,
    llmKept: [],
  };

  if (entries.length === 0) return { classifications: [], stats: baseStats };

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
    baseStats.syncRuleHits++;
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
  baseStats.hardFilterSkips = skipped.length;

  // Map hard-filter skips back to their original indexes.
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
  baseStats.llmInputs = llmInputs.length;
  void kept; // already enumerated through llmInputs

  // ── Layer 3: LLM classifies what's left.
  if (llmInputs.length > 0) {
    const { classifications: llmResults, metrics } = await classifyWithLlm(
      llmInputs.map((x) => x.entry),
    );
    baseStats.llmBatches = metrics.batches;
    baseStats.llmRetries = metrics.retries;
    baseStats.llmFallbacks = metrics.fallbacks;
    baseStats.llmDurationMs = metrics.durationMs;

    for (let i = 0; i < llmInputs.length; i++) {
      const { index } = llmInputs[i]!;
      const r = llmResults[i]!;
      results[index] = r;
      if (r.kind === 'person' && r.source === 'llm') {
        baseStats.llmKeptAsPerson++;
        // Capture every real LLM 'person' decision. Skip greedy-fallback
        // entries — those aren't real LLM opinions, just "LLM was down".
        if (
          typeof r.confidence === 'number' &&
          r.reason &&
          !r.reason.startsWith('greedy fallback')
        ) {
          baseStats.llmKept.push({
            email: r.input.email,
            reason: r.reason,
            confidence: r.confidence,
          });
        }
      } else if (r.kind === 'skip' && r.source === 'llm') {
        baseStats.llmSkippedAsService++;
      }
    }
  }

  // Double-check: every slot filled. Defensive against bugs in the
  // routing above — any null left here is a developer error.
  for (let i = 0; i < results.length; i++) {
    if (results[i] === null) {
      results[i] = {
        kind: 'person',
        input: entries[i]!,
        source: 'llm',
        reason: 'greedy fallback (classifier routing bug)',
      };
    }
  }

  return { classifications: results as Classification[], stats: baseStats };
}
