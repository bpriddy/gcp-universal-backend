-- Drive incremental poll
-- Replaces the full-folder-scan-only architecture with incremental polling
-- via Drive's changes.list API. New single-row drive_sync_state table holds
-- the page token + last-poll metadata. New chunk_phase / chunk_index columns
-- on sync_runs let the runner checkpoint a long bootstrap and self-call to
-- continue, so a multi-thousand-file folder doesn't have to fit in a single
-- Cloud Run instance lifetime.

-- ─── sync_runs: chunking checkpoint ──────────────────────────────────────────
-- chunk_phase  — 1=discovery, 2=accounts, 3=campaigns, 4=notify (drive-specific
--                today; generic int so other sources can adopt later)
-- chunk_index  — index within the phase's entity list (phases 2,3 only)
-- status='paused' is a new value meaning "checkpointed, waiting for the next
-- chunk to fire". The runner clears these when status flips to success/failed.
ALTER TABLE "sync_runs"
  ADD COLUMN "chunk_phase" INTEGER NULL,
  ADD COLUMN "chunk_index" INTEGER NULL;

-- ─── drive_sync_state ────────────────────────────────────────────────────────
-- Single-row table. id is hardcoded to 1; the polling code upserts on that id.
-- A pageToken of NULL means "no token, run /run-full-sync to bootstrap".
CREATE TABLE "drive_sync_state" (
  "id"                    INTEGER     PRIMARY KEY DEFAULT 1,
  "page_token"            TEXT        NULL,
  "last_polled_at"        TIMESTAMPTZ NULL,
  "last_outcome"          TEXT        NULL,
  "last_full_sync_run_id" UUID        NULL,
  "updated_at"            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "drive_sync_state_id_singleton" CHECK ("id" = 1)
);

-- Seed the singleton row in 'bootstrap_required' state so the polling endpoint
-- can return its 503 surface immediately. /run-full-sync overwrites pageToken
-- on its first successful completion.
INSERT INTO "drive_sync_state" ("id", "page_token", "last_outcome")
VALUES (1, NULL, 'bootstrap_required')
ON CONFLICT ("id") DO NOTHING;
