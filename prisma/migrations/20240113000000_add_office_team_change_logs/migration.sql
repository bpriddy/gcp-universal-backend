CREATE TABLE office_changes (
  id         UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  office_id  UUID        NOT NULL REFERENCES offices(id) ON DELETE CASCADE,
  property   TEXT        NOT NULL,
  value_text TEXT,
  value_date DATE,
  changed_by UUID        REFERENCES staff(id),
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX office_changes_office_id_property_changed_at_idx
  ON office_changes (office_id, property, changed_at DESC);

CREATE TABLE team_changes (
  id         UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  team_id    UUID        NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  property   TEXT        NOT NULL,
  value_text TEXT,
  value_date DATE,
  changed_by UUID        REFERENCES staff(id),
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX team_changes_team_id_property_changed_at_idx
  ON team_changes (team_id, property, changed_at DESC);
