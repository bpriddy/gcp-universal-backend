-- Add okta_city to offices for Okta profile.city → office mapping
ALTER TABLE offices ADD COLUMN okta_city TEXT UNIQUE;

-- Append-only staff change log (mirrors account_changes / office_changes pattern)
-- source: how the change arrived — 'okta_sync' | 'okta_webhook' | 'admin'
CREATE TABLE staff_changes (
  id         UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  staff_id   UUID        NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  property   TEXT        NOT NULL,
  value_text TEXT,
  value_uuid UUID,
  value_date DATE,
  source     TEXT        NOT NULL DEFAULT 'admin',
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX staff_changes_staff_id_property_changed_at_idx
  ON staff_changes (staff_id, property, changed_at DESC);
