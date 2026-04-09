-- Rename okta_city to sync_city on offices table.
-- This field maps a city string from any staff data source (previously Okta,
-- now Google Directory) to an office record. The generic name reflects that
-- the data source is pluggable.

ALTER TABLE offices RENAME COLUMN okta_city TO sync_city;
