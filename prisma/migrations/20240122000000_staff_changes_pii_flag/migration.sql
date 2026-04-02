-- ── PII classification flag on staff_changes ─────────────────────────────────
--
-- Adds a value_is_pii boolean column so that:
--   • Queries (anonymise, DSAR tooling) can identify PII-bearing rows without
--     hardcoding property name lists in multiple places.
--   • Audit tooling can report on PII exposure surface without joining to a
--     separate config table.
--
-- The immutability trigger on staff_changes blocks UPDATE, so the backfill
-- must temporarily disable it.  This migration runs as the table owner
-- (gub_migrator), which has the required ALTER TABLE privilege.
-- The trigger is re-enabled before the migration commits.
--
-- PII properties currently tracked:
--   full_name, email, title, department
--
-- Non-PII properties (operational metadata, safe to retain as-is):
--   status, office_id, started_at, ended_at, source

-- Step 1: add column (default false covers all existing rows before backfill)
ALTER TABLE staff_changes
  ADD COLUMN IF NOT EXISTS value_is_pii BOOLEAN NOT NULL DEFAULT false;

-- Step 2: open the table for the backfill by disabling the immutability trigger
ALTER TABLE staff_changes DISABLE TRIGGER staff_changes_immutable;

-- Step 3: backfill — mark existing rows that hold personal data
UPDATE staff_changes
SET    value_is_pii = true
WHERE  property IN ('full_name', 'email', 'title', 'department');

-- Step 4: restore immutability
ALTER TABLE staff_changes ENABLE TRIGGER staff_changes_immutable;
