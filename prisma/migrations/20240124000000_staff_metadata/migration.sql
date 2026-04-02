-- ── staff_metadata ────────────────────────────────────────────────────────
-- Flexible key/value store for staff traits: skills, interests, work
-- highlights, certifications, and any future types.
-- source/provenance is intentionally omitted — it is inferrable from the
-- audit_log (actor === subject → self-reported, actor !== subject → manager).

CREATE TABLE IF NOT EXISTS staff_metadata (
  id          UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  staff_id    UUID        NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  type        TEXT        NOT NULL,
  label       TEXT        NOT NULL,
  value       TEXT,
  notes       TEXT,
  metadata    JSONB,
  is_featured BOOLEAN     NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Per-person type lookups (primary read pattern)
CREATE INDEX IF NOT EXISTS idx_staff_metadata_staff_type
  ON staff_metadata (staff_id, type);

-- Cross-staff resourcing search by type + label
CREATE INDEX IF NOT EXISTS idx_staff_metadata_type_label
  ON staff_metadata (type, label);

-- Filter by level/value within a type (e.g. all expert-level skills)
CREATE INDEX IF NOT EXISTS idx_staff_metadata_type_value
  ON staff_metadata (type, value);

-- GIN index for JSONB metadata field queries
CREATE INDEX IF NOT EXISTS idx_staff_metadata_metadata_gin
  ON staff_metadata USING GIN (metadata);

-- Keep updated_at current automatically
CREATE OR REPLACE FUNCTION set_staff_metadata_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END; $$;

CREATE TRIGGER trg_staff_metadata_updated_at
  BEFORE UPDATE ON staff_metadata
  FOR EACH ROW EXECUTE FUNCTION set_staff_metadata_updated_at();
