-- Data sources configuration table.
-- Each row represents a sync integration (Google Directory, Workfront, etc.)
-- with its schedule and current status.

CREATE TABLE data_sources (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key            TEXT UNIQUE NOT NULL,
  name           TEXT NOT NULL,
  description    TEXT,
  is_active      BOOLEAN NOT NULL DEFAULT true,
  sync_interval  TEXT NOT NULL DEFAULT 'daily',
  cron_schedule  TEXT,
  last_sync_at   TIMESTAMPTZ,
  last_status    TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed the known data sources
INSERT INTO data_sources (key, name, description, sync_interval, cron_schedule) VALUES
  ('google_directory', 'Google Directory', 'Staff profiles from Google Workspace directory (contacts.google.com/directory). Creates and updates staff records, syncs metadata (phones, locations, managers, skills).', 'daily', '0 6 * * *'),
  ('workfront', 'Workfront', 'Accounts and campaigns from Workfront (Maconomy proxy). Maps projects to accounts by client name and tracks campaign status.', 'daily', '0 7 * * *'),
  ('google_drive', 'Google Drive', 'Sparse extraction of high-level campaign/project state from Google Drive folder conventions. Not ETL — only structured metadata.', 'manual', NULL),
  ('staff_metadata_import', 'Staff Metadata Import', 'Batch import of staff metadata from CSV or JSON. Used for enriching staff records with data not available in the directory (specialties, certifications, etc.).', 'manual', NULL);
