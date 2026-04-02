-- ─────────────────────────────────────────────────────────────────────────────
-- Row-Level Security policies
--
-- Scope (Phase 1):
--   access_grants   — users see only their own grants
--   access_requests — users see only their own requests
--
-- Mechanism:
--   The API sets `app.current_user_id` via set_config() at the start of every
--   query transaction (injected by the Prisma $extends middleware in database.ts).
--   Policies read it back via current_user_id() defined below.
--
-- Roles:
--   gub_app   — runtime API role; subject to RLS filtering
--   gub_admin — gub-admin CMS role; has BYPASSRLS, sees all rows
--
-- Local dev note:
--   When connecting as a PostgreSQL superuser (local .env), RLS is bypassed
--   automatically. Policies only take effect when connecting as gub_app.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── Helper function ───────────────────────────────────────────────────────────
-- Safely extracts the current user UUID from the session config.
-- Returns NULL when no user context is set (auth routes, health checks).
-- NULL causes `user_id = current_user_id()` to evaluate to NULL (false),
-- so unauthenticated connections see no rows — correct and safe.

CREATE OR REPLACE FUNCTION current_user_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.current_user_id', true), '')::uuid;
$$;


-- ── access_grants ─────────────────────────────────────────────────────────────

ALTER TABLE access_grants ENABLE ROW LEVEL SECURITY;

-- Each user sees only their own grants.
-- Admins accessing via gub-admin use the gub_admin role (BYPASSRLS) and are
-- unaffected by this policy.
-- Policy applies to all non-superuser roles (PUBLIC).
-- gub_admin bypasses via BYPASSRLS (set in setup-db-roles.sql).
-- Superuser connections (local dev) bypass RLS automatically.
CREATE POLICY access_grants_self
  ON access_grants
  FOR ALL
  USING (user_id = current_user_id());


-- ── access_requests ───────────────────────────────────────────────────────────

ALTER TABLE access_requests ENABLE ROW LEVEL SECURITY;

-- Each user sees only their own requests.
CREATE POLICY access_requests_self
  ON access_requests
  FOR ALL
  USING (user_id = current_user_id());
