-- ─────────────────────────────────────────────────────────────────────────────
-- Security constraints migration
--
-- 1. Trigger-protect all *_changes tables (block UPDATE + DELETE)
--    Mirrors the existing audit_log protection pattern.
--
-- 2. CHECK constraints on status/source enums that were previously only
--    validated at the application layer.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── 1. Shared trigger function ────────────────────────────────────────────────
-- Reused by all append-only tables. Raises an exception on any attempt to
-- UPDATE or DELETE a row, making the tables immutable after insert.

CREATE OR REPLACE FUNCTION raise_on_change_log_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'Change log table "%" is append-only. UPDATE and DELETE are not permitted. (operation: %)',
    TG_TABLE_NAME, TG_OP;
  RETURN NULL;
END;
$$;


-- ── 2. account_changes ───────────────────────────────────────────────────────

CREATE TRIGGER account_changes_immutable
  BEFORE UPDATE OR DELETE ON account_changes
  FOR EACH ROW EXECUTE FUNCTION raise_on_change_log_mutation();


-- ── 3. campaign_changes ──────────────────────────────────────────────────────

CREATE TRIGGER campaign_changes_immutable
  BEFORE UPDATE OR DELETE ON campaign_changes
  FOR EACH ROW EXECUTE FUNCTION raise_on_change_log_mutation();


-- ── 4. office_changes ────────────────────────────────────────────────────────

CREATE TRIGGER office_changes_immutable
  BEFORE UPDATE OR DELETE ON office_changes
  FOR EACH ROW EXECUTE FUNCTION raise_on_change_log_mutation();


-- ── 5. team_changes ──────────────────────────────────────────────────────────

CREATE TRIGGER team_changes_immutable
  BEFORE UPDATE OR DELETE ON team_changes
  FOR EACH ROW EXECUTE FUNCTION raise_on_change_log_mutation();


-- ── 6. staff_changes ─────────────────────────────────────────────────────────

CREATE TRIGGER staff_changes_immutable
  BEFORE UPDATE OR DELETE ON staff_changes
  FOR EACH ROW EXECUTE FUNCTION raise_on_change_log_mutation();


-- ── 7. CHECK constraints ──────────────────────────────────────────────────────

-- access_requests.status
ALTER TABLE access_requests
  ADD CONSTRAINT access_requests_status_check
  CHECK (status IN ('pending', 'approved', 'denied'));

-- staff_changes.source
ALTER TABLE staff_changes
  ADD CONSTRAINT staff_changes_source_check
  CHECK (source IN ('okta_sync', 'okta_webhook', 'admin'));

-- access_requests.resource_type — same domain as access_grants
-- Note: func:* and staff:* prefixes use colons which are valid in TEXT CHECK values.
ALTER TABLE access_requests
  ADD CONSTRAINT access_requests_resource_type_check
  CHECK (resource_type IN (
    'account', 'campaign', 'office', 'team',
    'func:temporal', 'func:export', 'func:admin_ui',
    'staff:all', 'staff:current', 'staff:office', 'staff:team'
  ));
