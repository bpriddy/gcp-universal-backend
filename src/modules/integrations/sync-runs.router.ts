/**
 * sync-runs.router.ts — Admin endpoint for viewing sync run history.
 *
 * GET /integrations/sync-runs           → latest runs across all sources
 * GET /integrations/sync-runs/:id       → single run with full details
 * GET /integrations/sync-runs/latest/:source → latest run for a source
 */

import { Router } from 'express';
import { prisma } from '../../config/database';

const router = Router();

/**
 * GET /integrations/sync-runs
 *
 * List recent sync runs. Filterable by ?source=google_directory
 * Returns summary + counters (not full details — use /:id for that).
 */
router.get('/', async (req, res) => {
  const source = typeof req.query.source === 'string' ? req.query.source : undefined;
  const limit = Math.min(Number(req.query.limit) || 20, 100);

  const runs = await prisma.syncRun.findMany({
    ...(source ? { where: { source } } : {}),
    orderBy: { startedAt: 'desc' },
    take: limit,
    select: {
      id: true,
      source: true,
      status: true,
      startedAt: true,
      completedAt: true,
      durationMs: true,
      totalScanned: true,
      created: true,
      updated: true,
      unchanged: true,
      skipped: true,
      errored: true,
      summary: true,
      // details omitted — can be large
    },
  });

  res.json({ runs });
});

/**
 * GET /integrations/sync-runs/latest/:source
 *
 * Convenience endpoint: get the most recent run for a given source.
 * Returns full details + summary.
 */
router.get('/latest/:source', async (req, res) => {
  const run = await prisma.syncRun.findFirst({
    where: { source: req.params.source },
    orderBy: { startedAt: 'desc' },
  });

  if (!run) {
    res.status(404).json({ error: `No sync runs found for source: ${req.params.source}` });
    return;
  }

  res.json(run);
});

/**
 * GET /integrations/sync-runs/:id
 *
 * Full sync run with details (skipped entries, changes, errors).
 */
router.get('/:id', async (req, res) => {
  const run = await prisma.syncRun.findUnique({
    where: { id: req.params.id },
  });

  if (!run) {
    res.status(404).json({ error: 'Sync run not found' });
    return;
  }

  res.json(run);
});

export default router;
