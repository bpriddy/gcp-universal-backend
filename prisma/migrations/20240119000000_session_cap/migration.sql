-- ── Session cap — max 10 concurrent active sessions per user ─────────────────
--
-- Fires AFTER every INSERT on refresh_tokens.  Counts non-revoked,
-- non-expired tokens for the user; if the count exceeds the cap, the oldest
-- sessions (by issued_at) are revoked immediately in the same transaction.
--
-- The cap is intentionally generous (10) so normal multi-device use —
-- phone, laptop, work machine, browser — never triggers it.  The purpose
-- is to bound the blast radius of a credential compromise, not to restrict
-- legitimate use.
--
-- Rotation note: rotateRefreshToken() inserts a new token THEN marks the
-- old one revoked.  The trigger fires between those two steps, so there is a
-- brief instant where one extra token appears active.  The trigger excludes
-- the newly inserted row (id <> NEW.id) so the oldest *other* session is
-- bumped, not the one being rotated.

CREATE OR REPLACE FUNCTION enforce_session_cap()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  cap    CONSTANT int := 10;
  excess int;
BEGIN
  SELECT GREATEST(COUNT(*) - cap, 0) INTO excess
  FROM   refresh_tokens
  WHERE  user_id    = NEW.user_id
    AND  revoked_at IS NULL
    AND  expires_at > now();

  IF excess > 0 THEN
    UPDATE refresh_tokens
    SET    revoked_at = now()
    WHERE  id IN (
      SELECT id
      FROM   refresh_tokens
      WHERE  user_id    = NEW.user_id
        AND  revoked_at IS NULL
        AND  expires_at > now()
        AND  id         <> NEW.id          -- never bump the token just issued
      ORDER  BY issued_at ASC              -- oldest sessions go first
      LIMIT  excess
    );
  END IF;

  RETURN NULL;  -- AFTER trigger; return value is ignored
END;
$$;

CREATE TRIGGER trg_session_cap
  AFTER INSERT ON refresh_tokens
  FOR EACH ROW EXECUTE FUNCTION enforce_session_cap();
