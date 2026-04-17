-- Track when an owner was emailed about a proposal so the weekly cron
-- doesn't re-notify on every run. Nullable — null means "never notified
-- yet" (and is the target of the notify service's scan).

ALTER TABLE "drive_change_proposals"
  ADD COLUMN "notified_at" TIMESTAMPTZ;

-- Covers the notify service's primary query:
--   WHERE reviewer_staff_id IS NOT NULL
--     AND state = 'pending'
--     AND notified_at IS NULL
CREATE INDEX IF NOT EXISTS "drive_change_proposals_reviewer_state_notified_idx"
  ON "drive_change_proposals" ("reviewer_staff_id", "state", "notified_at");
