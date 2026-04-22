/**
 * sync-run.service.ts — Shared service for recording sync run results.
 *
 * Every sync engine (google_directory, workfront, google_drive, etc.)
 * calls startRun() at the beginning and completeRun() at the end.
 * The structured details + human-readable summary are written to sync_runs.
 */

import { prisma } from '../../config/database';

// ── Types ────────────────────────────────────────────────────────────────────

export interface SkipEntry {
  email: string;
  name: string;
  reason: string;
  detail: string;
  /**
   * Which layer produced the skip. Helpful for triage when something
   * unexpected is in this bucket — a spike in 'llm' skips means the
   * prompt or model may have drifted; a spike in 'hard_filter' means
   * data upstream changed (new domain, missing fields, etc.).
   */
  source?: 'hard_filter' | 'llm' | 'sync_rule';
  /** LLM confidence 0–1 when source='llm'. Undefined otherwise. */
  confidence?: number;
}

export interface ChangeEntry {
  email: string;
  name: string;
  action: 'created' | 'updated';
  changes?: { property: string; from: string | null; to: string | null }[];
}

export interface ErrorEntry {
  email: string;
  name: string;
  error: string;
}

export interface SyncRunDetails {
  skipped: SkipEntry[];
  changes: ChangeEntry[];
  errors: ErrorEntry[];
  /**
   * Optional — classifier metrics and samples for syncs that route
   * through the staff-classifier module (Directory today). Lets the
   * summary answer "what did the LLM actually do?" without a DB dive.
   */
  classifier?: ClassifierAudit;
}

/**
 * Shape aligned with staff-classifier's ClassifierStats, but kept
 * separately so sync-run.service doesn't import from a consumer module.
 */
export interface ClassifierAudit {
  totalInput: number;
  syncRuleHits: number;
  hardFilterSkips: number;
  llmInputs: number;
  llmBatches: number;
  llmRetries: number;
  llmFallbacks: number;
  llmDurationMs: number;
  llmKeptAsPerson: number;
  llmSkippedAsService: number;
  /** Every LLM 'person' decision (email, reason, confidence). */
  llmKept: Array<{ email: string; reason: string; confidence: number }>;
}

export interface SyncRunCounters {
  totalScanned: number;
  created: number;
  updated: number;
  unchanged: number;
  skipped: number;
  errored: number;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Create a sync_runs row in 'running' status. Returns the ID.
 *
 * Sweeps stale 'running' rows from prior crashes before starting — see
 * sweepStaleSyncRuns below. Cheap (single UPDATE) and keeps the dashboard
 * honest without needing a separate cron.
 */
export async function startSyncRun(source: string): Promise<string> {
  await sweepStaleSyncRuns().catch(() => {
    // Non-fatal; the sweep is opportunistic housekeeping.
  });
  const run = await prisma.syncRun.create({
    data: { source, status: 'running' },
  });
  return run.id;
}

/**
 * Mark a sync run as complete, writing counters, details, and summary.
 */
export async function completeSyncRun(
  runId: string,
  source: string,
  counters: SyncRunCounters,
  details: SyncRunDetails,
  status: 'success' | 'failed' = 'success',
): Promise<void> {
  const now = new Date();

  // Fetch started_at to compute duration
  const run = await prisma.syncRun.findUnique({ where: { id: runId }, select: { startedAt: true } });
  const durationMs = run ? now.getTime() - run.startedAt.getTime() : null;

  const summary = generateSummary(source, counters, details, durationMs);

  await prisma.syncRun.update({
    where: { id: runId },
    data: {
      status,
      completedAt: now,
      durationMs,
      totalScanned: counters.totalScanned,
      created: counters.created,
      updated: counters.updated,
      unchanged: counters.unchanged,
      skipped: counters.skipped,
      errored: counters.errored,
      details: details as unknown as Record<string, unknown>,
      summary,
    },
  });

  // Update the data source's last sync timestamp + status
  await prisma.dataSource.updateMany({
    where: { key: source },
    data: { lastSyncAt: now, lastStatus: status },
  });
}

// ── Summary generator ────────────────────────────────────────────────────────

const SOURCE_LABELS: Record<string, string> = {
  google_directory: 'Google Directory Sync',
  workfront: 'Workfront Sync',
  google_drive: 'Google Drive Sync',
};

function generateSummary(
  source: string,
  counters: SyncRunCounters,
  details: SyncRunDetails,
  durationMs: number | null,
): string {
  const label = SOURCE_LABELS[source] ?? source;
  const timestamp = new Date().toLocaleString('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'America/New_York',
  });
  const duration = durationMs ? formatDuration(durationMs) : 'unknown';

  const lines: string[] = [];

  // Header
  lines.push(`${label} — ${timestamp}`);
  lines.push(`Scanned ${counters.totalScanned} entries in ${duration}`);
  lines.push('');

  // Changes section
  lines.push('CHANGES:');
  if (counters.created === 0 && counters.updated === 0) {
    lines.push('  No changes detected');
  } else {
    if (counters.created > 0) {
      lines.push(`  ${counters.created} new staff created`);
      for (const c of details.changes.filter((c) => c.action === 'created').slice(0, 10)) {
        lines.push(`    + ${c.name} <${c.email}>`);
      }
      if (counters.created > 10) {
        lines.push(`    ... and ${counters.created - 10} more`);
      }
    }
    if (counters.updated > 0) {
      lines.push(`  ${counters.updated} staff updated`);
      for (const c of details.changes.filter((c) => c.action === 'updated').slice(0, 10)) {
        const diffs = (c.changes ?? [])
          .map((d) => `${d.property}: ${d.from ?? '(empty)'} -> ${d.to ?? '(empty)'}`)
          .join(', ');
        lines.push(`    ~ ${c.name}: ${diffs}`);
      }
      if (counters.updated > 10) {
        lines.push(`    ... and ${counters.updated - 10} more`);
      }
    }
  }
  if (counters.unchanged > 0) {
    lines.push(`  ${counters.unchanged} unchanged`);
  }
  lines.push('');

  // Classifier audit — only for syncs that routed through staff-classifier.
  if (details.classifier) {
    const c = details.classifier;
    lines.push('CLASSIFIER:');
    lines.push(
      `  Input: ${c.totalInput}  |  sync-rules: ${c.syncRuleHits}  |  hard-filter: ${c.hardFilterSkips}  |  to LLM: ${c.llmInputs}`,
    );
    if (c.llmInputs > 0) {
      lines.push(
        `  LLM: ${c.llmBatches} batches in ${formatDuration(c.llmDurationMs)}, ${c.llmRetries} retries, ${c.llmFallbacks} fallbacks`,
      );
      lines.push(
        `  LLM decisions: ${c.llmKeptAsPerson} person, ${c.llmSkippedAsService} service_account`,
      );
    }
    lines.push('');
  }

  // Skipped section — counts per reason only. Per-email detail (with LLM
  // reason + confidence) lives in details.skipped[] and is rendered in
  // the scrollable "Skipped" panel on the run detail page. The text
  // summary was getting 600+ lines long for a full directory sync;
  // callers who want the enumeration open the detail page.
  lines.push(`SKIPPED: ${counters.skipped} entries`);
  if (counters.skipped > 0) {
    const byReason = groupBy(details.skipped, (s) => s.reason);
    for (const [reason, entries] of Object.entries(byReason).sort(
      (a, b) => b[1].length - a[1].length,
    )) {
      lines.push(`  ${entries.length} ${formatSkipReason(reason)}`);
    }
  }
  lines.push('');

  // Errors section
  if (counters.errored > 0) {
    lines.push(`ERRORS: ${counters.errored}`);
    for (const e of details.errors.slice(0, 5)) {
      lines.push(`  ! ${e.name} <${e.email}>: ${e.error}`);
    }
    if (counters.errored > 5) {
      lines.push(`  ... and ${counters.errored - 5} more`);
    }
  } else {
    lines.push('ERRORS: none');
  }

  return lines.join('\n');
}

function formatSkipReason(reason: string): string {
  switch (reason) {
    case 'service_account': return 'service accounts (LLM)';
    case 'external_domain': return 'external domain';
    case 'no_reply': return 'no-reply addresses';   // legacy — no longer emitted
    case 'newsletter': return 'newsletter/automated senders'; // legacy
    case 'unmappable': return 'unmappable (missing name or email)';
    case 'sync_rule': return 'admin sync rule';
    default: return reason;
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.round(ms / 100) / 10;
  return `${secs}s`;
}

function groupBy<T>(items: T[], keyFn: (item: T) => string): Record<string, T[]> {
  const result: Record<string, T[]> = {};
  for (const item of items) {
    const key = keyFn(item);
    (result[key] ??= []).push(item);
  }
  return result;
}

// ── Stale-run sweeper ───────────────────────────────────────────────────────

/**
 * Mark as 'failed' any sync_runs stuck in 'running' longer than `maxAgeMs`.
 * Runs are left in 'running' when the runtime dies mid-flight (Cloud Run
 * CPU throttling on fire-and-forget background work, pod OOM, etc.) —
 * without this sweep, they'd pin that state forever and block reporting.
 *
 * Idempotent. Call on boot and before each new run starts.
 */
export async function sweepStaleSyncRuns(maxAgeMs: number = 15 * 60 * 1000): Promise<number> {
  const cutoff = new Date(Date.now() - maxAgeMs);
  const result = await prisma.syncRun.updateMany({
    where: { status: 'running', startedAt: { lt: cutoff } },
    data: {
      status: 'failed',
      completedAt: new Date(),
      summary:
        'Run abandoned — runtime was terminated before the sync completed. Auto-resolved by the stale-run sweeper.',
    },
  });
  return result.count;
}
