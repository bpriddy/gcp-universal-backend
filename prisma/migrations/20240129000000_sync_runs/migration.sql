-- Sync runs table — tracks every execution of every sync engine.
-- One row per run. The admin dashboard queries this for integration health.

CREATE TABLE sync_runs (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source         TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'running',
  started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at   TIMESTAMPTZ,
  duration_ms    INTEGER,
  total_scanned  INTEGER NOT NULL DEFAULT 0,
  created        INTEGER NOT NULL DEFAULT 0,
  updated        INTEGER NOT NULL DEFAULT 0,
  unchanged      INTEGER NOT NULL DEFAULT 0,
  skipped        INTEGER NOT NULL DEFAULT 0,
  errored        INTEGER NOT NULL DEFAULT 0,
  details        JSONB,
  summary        TEXT
);

CREATE INDEX idx_sync_runs_source_started ON sync_runs (source, started_at DESC);
CREATE INDEX idx_sync_runs_status ON sync_runs (status);
