-- ── GDPR Art. 17 erasure gate for append-only change log tables ──────────────
--
-- The existing raise_on_change_log_mutation() function blocks ALL UPDATE and
-- DELETE on every *_changes table and on audit_log.  That immutability
-- guarantee is correct for normal operations.
--
-- GDPR Art. 17 (right to erasure) requires that we can scrub PII from
-- change log rows when a Data Subject Access Request demands it.  We do NOT
-- delete the row (the fact that a change happened is a legitimate business
-- record); we only overwrite the value columns that hold personal data.
--
-- To allow that narrow operation while keeping the general immutability
-- guarantee intact, this migration replaces the trigger function with a
-- version that:
--
--   • Always blocks DELETE — immutability is absolute for hard deletes.
--   • Allows UPDATE ONLY when the current transaction has explicitly set
--     the session-local variable  app.gdpr_erasure = 'true'.
--     The anonymise endpoint is the only code path that sets this flag.
--
-- The flag is LOCAL to the transaction (SET LOCAL …), so it resets
-- automatically on commit/rollback and cannot leak between requests.

CREATE OR REPLACE FUNCTION raise_on_change_log_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Narrow GDPR Art. 17 gate: UPDATE is permitted only within a transaction
  -- that has explicitly declared itself a GDPR erasure operation.
  -- DELETE is unconditionally blocked — rows are never hard-deleted.
  IF TG_OP = 'UPDATE'
     AND current_setting('app.gdpr_erasure', true) = 'true'
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'Change log table "%" is append-only. UPDATE and DELETE are not permitted. (operation: %)',
    TG_TABLE_NAME, TG_OP;

  RETURN NULL;
END;
$$;
