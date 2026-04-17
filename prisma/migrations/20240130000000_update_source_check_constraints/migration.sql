-- Update the staff_changes source check constraint to reflect the actual
-- data sources now in use (Google Directory replaced Okta).

ALTER TABLE staff_changes
  DROP CONSTRAINT staff_changes_source_check;

ALTER TABLE staff_changes
  ADD CONSTRAINT staff_changes_source_check
  CHECK (source IN ('google_directory_sync', 'admin', 'csv_import', 'workfront_sync'));
