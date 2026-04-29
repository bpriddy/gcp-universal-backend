/**
 * drive.router.ts — HTTP surface for Google Drive sync + review.
 *
 * Admin endpoints (currently unauthenticated — KNOWN DEBT):
 *   POST /poll                       — Cloud Scheduler target. Cheap
 *                                      delta call (changes.list); only fires a
 *                                      full sync when changes are in-scope.
 *                                      200 / 202 / 503 depending on outcome.
 *   POST /run-full-sync              — Admin button + bootstrap path. Full
 *                                      discover + scan; on success persists a
 *                                      fresh start page token so subsequent
 *                                      /poll calls have somewhere to start.
 *                                      Returns 202 + syncRunId immediately;
 *                                      run completes in background. 409 if a
 *                                      sync is already running or paused.
 *   POST /run-full-sync/continue     — Self-call continuation when a sync hit
 *                                      its chunk budget. Resumes a paused
 *                                      sync_run from its checkpoint. Body:
 *                                      { syncRunId }.
 *   POST /cron                       — Legacy alias. Same behavior as
 *                                      /run-full-sync. Kept so nothing breaks
 *                                      while Cloud Scheduler is migrated.
 *   POST /notify                     — On-demand notify run. Fires the email
 *                                      fan-out for pending+unnotified
 *                                      proposals. Useful if dispatch failed
 *                                      during the sync itself.
 *   POST /sweep-expired              — Sweep expired proposals (state=pending
 *                                      + expires_at < now) to state='expired'.
 *                                      Cron target. Idempotent.
 *
 *   These endpoints ARE REACHABLE BY ANY INTERNET CALLER. This matches the
 *   pre-existing google-directory/cron pattern so the gub-admin proxy and
 *   Cloud Scheduler can reach them without a token. Running a sync mutates
 *   the DB and spends LLM credits, so this is real debt.
 *
 *   TODO(security): require a Google-signed ID token from a whitelisted
 *   caller SA. Correct pattern: the caller (gub-admin, Cloud Scheduler)
 *   mints an ID token via the metadata server with aud=<GUB URL>, passes
 *   it as `Authorization: Bearer`, and GUB verifies it against Google's
 *   JWKS + an INTERNAL_SA_EMAILS whitelist env var. Do this for Drive +
 *   Directory admin endpoints in one pass.
 *
 * Owner-facing magic-link endpoints (UNAUTHENTICATED — the review token IS
 * the auth):
 *   GET  /review/:token            — Render review session for the token's
 *                                    reviewer: their pending field_changes,
 *                                    new-entity groups, and current-state
 *                                    snapshots for diff rendering.
 *   POST /review/:token/decide     — Apply approve/reject decisions. Body:
 *                                    { decisions: Decision[] }. Cross-owner
 *                                    decisions are rejected; per-item errors
 *                                    do not abort the batch.
 *
 * The magic-link routes are intentionally public: email recipients cannot
 * sign into gub-admin. The random 32-byte token gates access.
 */

import { Router } from 'express';
import { prisma } from '../../../config/database';
import { logger } from '../../../services/logger';
import { notifyReviewers } from './drive.notify';
import {
  applyDecisions,
  resolveReviewSession,
  ReviewTokenError,
  type Decision,
} from './drive.review';
import { runIncrementalPoll } from './drive.poll';
import { reapStaleSyncs } from './drive.reaper';
import {
  NoSuchPausedSyncError,
  SyncAlreadyRunningError,
  continuePausedSync,
  startFullSync,
} from './drive.runner';

/**
 * Sweep pending proposals whose expires_at has passed into state='expired'.
 * Returns { expired: N }. Single SQL update; idempotent.
 */
async function sweepExpiredProposals(): Promise<{ expired: number }> {
  const result = await prisma.driveChangeProposal.updateMany({
    where: { state: 'pending', expiresAt: { lt: new Date() } },
    data: { state: 'expired' },
  });
  if (result.count > 0) {
    logger.info({ expired: result.count }, '[drive.router] swept expired proposals');
  }
  return { expired: result.count };
}

const router = Router();

async function kickoffFullSync(): Promise<{ status: number; body: unknown }> {
  try {
    const { syncRunId, promise } = await startFullSync();
    // Fire-and-forget the run; the promise writes its own terminal state into
    // sync_runs. We only log unhandled rejections here so they don't silently
    // disappear if the runner itself throws before updating the row.
    promise.catch((err: unknown) => {
      logger.error({ err, syncRunId }, '[drive.router] full sync rejected outside runner');
    });
    return { status: 202, body: { status: 'sync_started', syncRunId } };
  } catch (err) {
    if (err instanceof SyncAlreadyRunningError) {
      return {
        status: 409,
        body: {
          code: 'SYNC_ALREADY_RUNNING',
          message: err.message,
          syncRunId: err.existingRunId,
          existingStatus: err.status,
        },
      };
    }
    throw err;
  }
}

router.post('/run-full-sync', async (_req, res, next) => {
  try {
    // Self-heal stuck rows from prior crashes before checking concurrency.
    // See drive.reaper.ts for the threshold rationale.
    await reapStaleSyncs();
    const { status, body } = await kickoffFullSync();
    res.status(status).json(body);
  } catch (err) {
    next(err);
  }
});

/**
 * Continuation endpoint for chunked syncs. Hit by drive.runner.ts when a sync
 * hits its wall-clock budget mid-run; the runner self-POSTs to this URL with
 * { syncRunId } to resume in a fresh Cloud Run request.
 *
 * Returns 202 + the same syncRunId on success. Returns 4xx if the supplied
 * syncRunId doesn't refer to an actual paused google_drive sync_run.
 */
router.post('/run-full-sync/continue', async (req, res, next) => {
  try {
    // Self-heal stuck rows. Note: if THIS sync's row got reaped (e.g.
    // continuation arrived 65 minutes after pause), continuePausedSync
    // will fail with NoSuchPausedSyncError → 404, which is the correct
    // outcome — operator must manually re-trigger /run-full-sync.
    await reapStaleSyncs();
    const body = req.body as { syncRunId?: unknown } | undefined;
    if (!body || typeof body.syncRunId !== 'string') {
      res.status(400).json({ error: 'body must be { syncRunId: string }' });
      return;
    }
    const { syncRunId, promise } = await continuePausedSync(body.syncRunId);
    promise.catch((err: unknown) => {
      logger.error(
        { err, syncRunId },
        '[drive.router] continuation rejected outside runner',
      );
    });
    res.status(202).json({ status: 'sync_resumed', syncRunId });
  } catch (err) {
    if (err instanceof NoSuchPausedSyncError) {
      res.status(404).json({ error: err.message });
      return;
    }
    next(err);
  }
});

/**
 * Cloud Scheduler target. Cheap delta call: ask Drive what's changed since
 * the last saved page token, dispatch a full sync only when there are
 * in-scope changes. See drive.poll.ts for the outcome enum.
 *
 *   no_changes / changes_pending_existing_run         → 200
 *   changes_dispatched                                → 202 + syncRunId
 *   bootstrap_required                                → 503
 *   errored (re-thrown)                               → next(err) → 500
 */
router.post('/poll', async (_req, res, next) => {
  try {
    // Self-heal stuck rows before polling. If a stuck sync was blocking
    // dispatch (concurrency guard), this clears it so the poll can fire
    // a new sync if needed.
    await reapStaleSyncs();
    const result = await runIncrementalPoll();
    if (result.outcome === 'bootstrap_required') {
      res.status(503).json({ ...result, code: 'BOOTSTRAP_REQUIRED' });
      return;
    }
    if (result.outcome === 'changes_dispatched') {
      res.status(202).json(result);
      return;
    }
    // 'no_changes' or 'changes_pending_existing_run' — both 200.
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

// Legacy alias — kept so existing callers (e.g. earlier stub cron) keep working.
router.post('/cron', async (_req, res, next) => {
  try {
    const { status, body } = await kickoffFullSync();
    res.status(status).json(body);
  } catch (err) {
    next(err);
  }
});

// On-demand notify fan-out — normally called implicitly at the end of a sync.
router.post('/notify', async (_req, res, next) => {
  try {
    const result = await notifyReviewers();
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

// Cron target: flip expired proposals from 'pending' → 'expired' so they
// stop appearing in review sessions and stop generating notify emails.
// Idempotent: running it on an empty queue is a no-op. Safe to run hourly.
router.post('/sweep-expired', async (_req, res, next) => {
  try {
    const result = await sweepExpiredProposals();
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

// ── Magic-link review (public; token-authenticated) ────────────────────────

router.get('/review/:token', async (req, res, next) => {
  try {
    const session = await resolveReviewSession(req.params.token);
    res.status(200).json(session);
  } catch (err) {
    if (err instanceof ReviewTokenError) {
      res.status(err.httpStatus).json({ error: err.message });
      return;
    }
    next(err);
  }
});

router.post('/review/:token/decide', async (req, res, next) => {
  try {
    const decisions = parseDecisionsBody(req.body);
    const result = await applyDecisions(req.params.token, decisions);
    // 200 even if some per-item errors — caller reads result.errors. A fully
    // empty decisions[] is legal (treat as a no-op ping) for robustness.
    res.status(200).json(result);
  } catch (err) {
    if (err instanceof ReviewTokenError) {
      res.status(err.httpStatus).json({ error: err.message });
      return;
    }
    if (err instanceof BadDecisionsBodyError) {
      res.status(400).json({ error: err.message });
      return;
    }
    next(err);
  }
});

class BadDecisionsBodyError extends Error {}

function parseDecisionsBody(body: unknown): Decision[] {
  if (!body || typeof body !== 'object') {
    throw new BadDecisionsBodyError('body must be an object with `decisions: Decision[]`');
  }
  const decisions = (body as { decisions?: unknown }).decisions;
  if (!Array.isArray(decisions)) {
    throw new BadDecisionsBodyError('`decisions` must be an array');
  }
  return decisions.map((d, i) => {
    if (!d || typeof d !== 'object') {
      throw new BadDecisionsBodyError(`decisions[${i}] must be an object`);
    }
    const o = d as Record<string, unknown>;
    if (o.decision !== 'approve' && o.decision !== 'reject') {
      throw new BadDecisionsBodyError(
        `decisions[${i}].decision must be "approve" or "reject"`,
      );
    }
    const hasId = typeof o.proposalId === 'string';
    const hasGroup = typeof o.proposalGroupId === 'string';
    if (hasId === hasGroup) {
      throw new BadDecisionsBodyError(
        `decisions[${i}] must specify exactly one of proposalId or proposalGroupId`,
      );
    }
    if (hasId) {
      return {
        proposalId: o.proposalId as string,
        decision: o.decision,
        ...(typeof o.overrideValue === 'string' || o.overrideValue === null
          ? { overrideValue: o.overrideValue as string | null }
          : {}),
      };
    }
    return {
      proposalGroupId: o.proposalGroupId as string,
      decision: o.decision,
      ...(o.fieldOverrides && typeof o.fieldOverrides === 'object'
        ? { fieldOverrides: o.fieldOverrides as Record<string, string | null> }
        : {}),
    };
  });
}

export default router;
