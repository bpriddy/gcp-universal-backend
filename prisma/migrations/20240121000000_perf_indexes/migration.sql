-- ── Performance indexes ───────────────────────────────────────────────────────
--
-- refresh_tokens.expires_at
-- ─────────────────────────
-- Two code paths filter on this column without an index:
--   • cleanup.ts  — deletes rows WHERE expires_at < cutoff
--   • enforce_session_cap() trigger — counts rows WHERE expires_at > now()
-- Without an index both do a full table scan.  As token volume grows (one row
-- per login per device) this becomes the first query to show up in slow-query
-- logs.
--
-- access_grants — composite active-grant index
-- ────────────────────────────────────────────
-- Every access check (checkAccess, getGrantedResourceIds, getTemporalCutoff)
-- executes a query with the same WHERE shape:
--
--   WHERE user_id    = $1
--     AND revoked_at IS NULL
--     AND (expires_at IS NULL OR expires_at > now())
--
-- The existing index on (user_id) alone forces Postgres to re-examine every
-- grant for that user and filter out revoked/expired rows in memory.  The
-- composite partial index below covers all three conditions in the index
-- itself, so the planner can satisfy the query with an index-only scan in
-- the common case.
--
-- Production note: on a live database with significant row counts, prefer
-- running these as CREATE INDEX CONCURRENTLY outside of a transaction to
-- avoid table-level locks.  IF NOT EXISTS makes re-running safe in either
-- case.

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires_at
  ON refresh_tokens (expires_at);

CREATE INDEX IF NOT EXISTS idx_access_grants_active
  ON access_grants (user_id, revoked_at, expires_at)
  WHERE revoked_at IS NULL;
