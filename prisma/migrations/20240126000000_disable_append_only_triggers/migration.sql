-- Disable append-only / immutable triggers during development.
--
-- These triggers prevent UPDATE and DELETE on change-log tables and audit_log.
-- During active development we need the flexibility to modify and delete records.
--
-- ⚠️  RE-ENABLE BEFORE PRODUCTION GO-LIVE ⚠️
-- Run a migration that reverses these DROPs, or re-apply the original migrations.
-- The backend logs a WARN at startup if these triggers are missing.

-- Change-log immutability triggers (from 20240116000000_security_constraints)
DROP TRIGGER IF EXISTS account_changes_immutable ON account_changes;
DROP TRIGGER IF EXISTS campaign_changes_immutable ON campaign_changes;
DROP TRIGGER IF EXISTS office_changes_immutable ON office_changes;
DROP TRIGGER IF EXISTS team_changes_immutable ON team_changes;
DROP TRIGGER IF EXISTS staff_changes_immutable ON staff_changes;

-- Audit log immutability triggers (from 20240107000000_audit_log and 20240118000000_audit_log_immutable)
DROP TRIGGER IF EXISTS audit_log_no_update ON audit_log;
DROP TRIGGER IF EXISTS audit_log_no_delete ON audit_log;
DROP TRIGGER IF EXISTS trg_audit_log_immutable ON audit_log;

-- User no-delete trigger (from 20240105000000_users_no_delete_loud)
DROP TRIGGER IF EXISTS users_no_delete ON users;

-- Staff no-delete trigger (from 20240108000000_add_staff)
DROP TRIGGER IF EXISTS staff_no_delete ON staff;

-- NOTE: The underlying functions are left intact so the triggers can be
-- re-created without re-deploying the functions.
