/**
 * drive.router.ts — HTTP surface for Google Drive sync + review.
 *
 * Admin endpoints (authenticated):
 *   POST /run-full-sync    — Admin button. Kicks off discover + scan every
 *                            linked account + scan every linked campaign.
 *                            Returns 202 + syncRunId immediately; the run
 *                            completes in the background. 409 if a sync is
 *                            already running.
 *   POST /cron             — Legacy alias. Same behavior as /run-full-sync.
 *                            Retired once Phase 5 points Cloud Scheduler at
 *                            /run-full-sync directly.
 *   POST /notify           — On-demand notify run. Fires the email fan-out
 *                            for any pending+unnotified proposals. Useful
 *                            if dispatch failed during the sync itself.
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
import { authenticate, requireAdmin } from '../../../middleware/authenticate';
import { logger } from '../../../services/logger';
import { notifyReviewers } from './drive.notify';
import {
  applyDecisions,
  resolveReviewSession,
  ReviewTokenError,
  type Decision,
} from './drive.review';
import { SyncAlreadyRunningError, startFullSync } from './drive.runner';

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
        },
      };
    }
    throw err;
  }
}

router.post('/run-full-sync', authenticate, requireAdmin, async (_req, res, next) => {
  try {
    const { status, body } = await kickoffFullSync();
    res.status(status).json(body);
  } catch (err) {
    next(err);
  }
});

// Legacy alias — kept so existing callers (e.g. earlier stub cron) keep working.
router.post('/cron', authenticate, requireAdmin, async (_req, res, next) => {
  try {
    const { status, body } = await kickoffFullSync();
    res.status(status).json(body);
  } catch (err) {
    next(err);
  }
});

// On-demand notify fan-out — normally called implicitly at the end of a sync.
router.post('/notify', authenticate, requireAdmin, async (_req, res, next) => {
  try {
    const result = await notifyReviewers();
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
