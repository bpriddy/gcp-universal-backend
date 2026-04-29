-- Drive sync stale-run reaper
-- Adds an updated_at heartbeat column to sync_runs so the reaper can
-- detect genuinely-stuck rows (no progress in N minutes) rather than
-- relying on started_at (which would falsely reap a long-but-progressing
-- bootstrap as soon as it crosses the threshold).
--
-- The reaper itself is application-side (drive.reaper.ts); see that file
-- for the run-time logic. Thresholds live in code as constants:
--   paused  > 60 min  → reap
--   running > 24 hr   → reap
-- Both compare against updated_at, not started_at.

ALTER TABLE "sync_runs"
  ADD COLUMN "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now();

-- Backfill: existing rows haven't had heartbeats; seed updated_at to
-- started_at so anything historical that happens to still be 'running'
-- is immediately reapable on the next request (which is the right
-- outcome — those rows are stuck and should be cleared).
UPDATE "sync_runs" SET "updated_at" = "started_at";

-- Trigger: keep updated_at fresh on every UPDATE. Prisma's @updatedAt
-- decorator handles this at the application level too, but a DB-level
-- trigger means raw SQL updates (migrations, manual ops, the reaper
-- itself) also bump the heartbeat.
CREATE OR REPLACE FUNCTION sync_runs_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER sync_runs_updated_at_trigger
  BEFORE UPDATE ON "sync_runs"
  FOR EACH ROW
  EXECUTE FUNCTION sync_runs_set_updated_at();
