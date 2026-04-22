/**
 * llm-classifier.ts — Batched Gemini classification of directory entries.
 *
 * Contract with the rest of the system:
 *   - Input: array of { email, displayName } that has already passed the
 *     hard-filter layer (unmappable / external / no-reply removed).
 *   - Output: one Classification per input, in the same order.
 *   - Greedy-keep bias: if the LLM cannot answer, the default is 'person'.
 *     Losing a real staff member is much worse than letting a group
 *     mailbox through — the sync_rules override handles those.
 *
 * Batching:
 *   - BATCH_SIZE entries per Gemini call. 50 balances latency, token cost,
 *     and the model's attention span.
 *
 * Diff-and-rerequest:
 *   - Gemini occasionally drops or duplicates items in structured output.
 *     After each batch we check which input emails weren't covered and
 *     retry ONE TIME with just the missing set. If they're still missing
 *     after the retry, we keep them as 'person' — greedy fallback.
 *
 * Failure modes:
 *   - Gemini error (network, rate limit, config) — every entry in that
 *     batch falls through as 'person' with source='llm' and a reason
 *     noting the failure. The sync does NOT abort.
 *   - MockLlmDriver (GEMINI_API_KEY unset in dev) returns an empty array,
 *     which takes the same fallback path — every entry becomes 'person'.
 *     This keeps local pipelines running without a key.
 */

import { SchemaType, type Schema } from '@google/generative-ai';
import { parseLlmJson, runPreset } from '../ai';
import { logger } from '../../services/logger';
import type { ClassifierInput, Classification } from './types';

const BATCH_SIZE = 50;
const PROMPT_KEY = 'staff.classify_v1';

/** Collected metrics for this run. Returned alongside classifications. */
export interface LlmClassifierMetrics {
  batches: number;
  retries: number;
  fallbacks: number;
  durationMs: number;
}

/** Shape Gemini returns — validated lightly, not zod-ed for speed. */
interface LlmItem {
  email: string;
  classification: 'person' | 'service_account';
  confidence: number;
  reason: string;
}

interface LlmResponse {
  items: LlmItem[];
}

function responseSchema(): Schema {
  return {
    type: SchemaType.OBJECT,
    properties: {
      items: {
        type: SchemaType.ARRAY,
        description:
          'One item per input entry, in any order. Must contain exactly one entry per input email — do not drop or invent.',
        items: {
          type: SchemaType.OBJECT,
          properties: {
            email: {
              type: SchemaType.STRING,
              description: 'Echo the input email verbatim.',
            },
            classification: {
              type: SchemaType.STRING,
              format: 'enum',
              enum: ['person', 'service_account'],
              description:
                'person = a real human staff member; service_account = group mailbox, bot, automation, or placeholder.',
            },
            confidence: {
              type: SchemaType.NUMBER,
              description: '0.0–1.0, your certainty in the classification.',
            },
            reason: {
              type: SchemaType.STRING,
              description: 'Short phrase (≤ 8 words) justifying the classification.',
            },
          },
          required: ['email', 'classification', 'confidence', 'reason'],
        },
      },
    },
    required: ['items'],
  };
}

/**
 * Classify a list of entries. Greedy fallback: entries the LLM doesn't
 * cover get classified as 'person'. Never throws — failures degrade to
 * greedy-keep.
 *
 * Returns the classifications alongside run-level metrics so the caller
 * can surface "what did the LLM do?" in the sync log without scraping
 * application logs.
 */
export async function classifyWithLlm(
  entries: ClassifierInput[],
): Promise<{ classifications: Classification[]; metrics: LlmClassifierMetrics }> {
  const metrics: LlmClassifierMetrics = {
    batches: 0,
    retries: 0,
    fallbacks: 0,
    durationMs: 0,
  };
  if (entries.length === 0) return { classifications: [], metrics };

  const start = Date.now();
  const out: Classification[] = [];
  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    const batch = entries.slice(i, i + BATCH_SIZE);
    const batchResults = await classifyBatch(batch, metrics);
    out.push(...batchResults);
  }
  metrics.durationMs = Date.now() - start;
  return { classifications: out, metrics };
}

// ── Internals ───────────────────────────────────────────────────────────────

async function classifyBatch(
  batch: ClassifierInput[],
  metrics: LlmClassifierMetrics,
): Promise<Classification[]> {
  // One call covers the batch; if we get fewer items back than we sent,
  // run a single retry on just the missing ones. Whatever's still missing
  // after the retry falls through as 'person'.
  metrics.batches++;
  const batchStart = Date.now();
  const firstPass = await callLlm(batch);
  const covered = new Set(firstPass.map((i) => i.email.toLowerCase()));
  const missing = batch.filter((e) => !covered.has(e.email.toLowerCase()));

  let secondPass: LlmItem[] = [];
  if (missing.length > 0) {
    metrics.retries++;
    secondPass = await callLlm(missing, /* retry */ true);
  }
  const combined = [...firstPass, ...secondPass];

  logger.info(
    {
      batchSize: batch.length,
      firstPassItems: firstPass.length,
      retries: missing.length,
      retryRecovered: secondPass.length,
      durationMs: Date.now() - batchStart,
    },
    '[staff-classifier] batch classified',
  );

  // Index by email for fast lookup.
  const byEmail = new Map<string, LlmItem>();
  for (const item of combined) byEmail.set(item.email.toLowerCase(), item);

  return batch.map((input) => {
    const item = byEmail.get(input.email.toLowerCase());
    if (!item) metrics.fallbacks++;
    return toClassification(input, item);
  });
}

/**
 * Single Gemini call — parses the response and returns whatever items it
 * extracted. Never throws; failures log + return [] so the caller can
 * fall through to greedy-keep.
 */
async function callLlm(batch: ClassifierInput[], retry = false): Promise<LlmItem[]> {
  const tag = retry ? 'staff.classify_v1.retry' : 'staff.classify_v1';
  try {
    const result = await runPreset({
      key: PROMPT_KEY,
      variables: {
        entries_json: JSON.stringify(
          batch.map((e) => ({ email: e.email, displayName: e.displayName })),
          null,
          2,
        ),
      },
      responseSchema: responseSchema(),
    });

    const parsed = parseLlmJson<LlmResponse>(result.text);
    if (!Array.isArray(parsed.items)) {
      logger.warn({ tag, driver: result.driver }, '[staff-classifier] LLM returned no items array');
      return [];
    }

    // Filter out items that fail the minimal sanity check. Anything
    // suspect gets dropped (→ greedy-keep via the fallback path) rather
    // than injected into the result with a garbage classification.
    const clean: LlmItem[] = [];
    for (const item of parsed.items) {
      if (
        typeof item?.email === 'string' &&
        (item.classification === 'person' || item.classification === 'service_account') &&
        typeof item.confidence === 'number' &&
        typeof item.reason === 'string'
      ) {
        clean.push(item);
      }
    }
    return clean;
  } catch (err) {
    logger.error({ err, tag, batchSize: batch.length }, '[staff-classifier] LLM call failed');
    return [];
  }
}

function toClassification(
  input: ClassifierInput,
  item: LlmItem | undefined,
): Classification {
  // Greedy fallback: no LLM item → keep as person.
  if (!item) {
    return {
      kind: 'person',
      input,
      source: 'llm',
      reason: 'greedy fallback (no llm response)',
    };
  }

  if (item.classification === 'person') {
    return {
      kind: 'person',
      input,
      source: 'llm',
      confidence: item.confidence,
      reason: item.reason,
    };
  }

  return {
    kind: 'skip',
    input,
    reason: 'service_account',
    // Keep detail to just the model's reason — the summary renderer
    // prefixes the confidence separately so we don't double-print it.
    detail: item.reason,
    confidence: item.confidence,
    source: 'llm',
  };
}
