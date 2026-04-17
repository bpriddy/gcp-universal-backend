-- Add previous_value columns to all change-log tables.
--
-- Every change row now captures both the old and new value, making it trivial
-- to answer "what was the value of X at time T?" and to render human-readable
-- diffs like "title: Producer → Senior Producer" in sync summaries.
--
-- All columns are nullable — existing rows and initial-creation rows have no
-- previous value, which is the correct semantic (NULL = "did not exist before").

-- ── staff_changes ───────────────────────────────────────────────────────────
ALTER TABLE staff_changes
  ADD COLUMN previous_value_text TEXT,
  ADD COLUMN previous_value_uuid UUID,
  ADD COLUMN previous_value_date DATE;

-- ── account_changes ─────────────────────────────────────────────────────────
ALTER TABLE account_changes
  ADD COLUMN previous_value_text TEXT,
  ADD COLUMN previous_value_uuid UUID,
  ADD COLUMN previous_value_date DATE;

-- ── campaign_changes ────────────────────────────────────────────────────────
ALTER TABLE campaign_changes
  ADD COLUMN previous_value_text TEXT,
  ADD COLUMN previous_value_uuid UUID,
  ADD COLUMN previous_value_date DATE;

-- ── office_changes ──────────────────────────────────────────────────────────
ALTER TABLE office_changes
  ADD COLUMN previous_value_text TEXT,
  ADD COLUMN previous_value_date DATE;

-- ── team_changes ────────────────────────────────────────────────────────────
ALTER TABLE team_changes
  ADD COLUMN previous_value_text TEXT,
  ADD COLUMN previous_value_date DATE;
