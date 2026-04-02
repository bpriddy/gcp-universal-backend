-- ── Protect audit_log from mutations ─────────────────────────────────────────
-- Reuses the raise_on_change_log_mutation() function created in the
-- security_constraints migration.  INSERT is allowed (append-only);
-- UPDATE and DELETE are blocked at the DB level.

CREATE TRIGGER trg_audit_log_immutable
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION raise_on_change_log_mutation();
