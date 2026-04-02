-- ── App registry and unified auth model ──────────────────────────────────────
--
-- 1. apps — registry of all client applications.  autoAccess controls whether
--    first login automatically provisions UserAppPermission (permissive apps)
--    or holds the user at a request-access screen (gated apps).
--    dbIdentifier is reserved for isolated-tenant deployments where a client's
--    data lives in a dedicated database instance.
--
-- 2. users.google_sub → nullable — enables admins to pre-create user stubs by
--    email before the user has ever logged in.  googleSub is populated on first
--    login and then locked.
--
-- 3. user_app_permissions — drop db_identifier (belongs on apps, not per-user),
--    add FK to apps.app_id.
--
-- 4. app_access_requests — lightweight request table for gated apps.  Separate
--    from access_requests which handles resource-level (account/campaign) grants.

-- ── 1. apps ───────────────────────────────────────────────────────────────────

CREATE TABLE apps (
  id            UUID        NOT NULL DEFAULT gen_random_uuid(),
  app_id        TEXT        NOT NULL,
  name          TEXT        NOT NULL,
  description   TEXT,
  auto_access   BOOLEAN     NOT NULL DEFAULT false,
  db_identifier TEXT,
  is_active     BOOLEAN     NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT apps_pkey        PRIMARY KEY (id),
  CONSTRAINT apps_app_id_key  UNIQUE      (app_id)
);

-- ── 2. users.google_sub → nullable ───────────────────────────────────────────
-- PostgreSQL unique indexes on nullable columns allow multiple NULLs, so the
-- existing unique index on google_sub remains correct and needs no replacement.

ALTER TABLE users ALTER COLUMN google_sub DROP NOT NULL;

-- ── 3. user_app_permissions — drop db_identifier, add FK to apps ──────────────

ALTER TABLE user_app_permissions DROP COLUMN db_identifier;

ALTER TABLE user_app_permissions
  ADD CONSTRAINT user_app_permissions_app_id_fkey
  FOREIGN KEY (app_id) REFERENCES apps(app_id) ON DELETE CASCADE;

-- ── 4. app_access_requests ───────────────────────────────────────────────────

CREATE TABLE app_access_requests (
  id                   UUID        NOT NULL DEFAULT gen_random_uuid(),
  user_id              UUID        NOT NULL,
  app_id               TEXT        NOT NULL,
  reason               TEXT,
  status               TEXT        NOT NULL DEFAULT 'pending',
  reviewed_by_staff_id UUID,
  reviewed_at          TIMESTAMPTZ,
  review_note          TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT app_access_requests_pkey          PRIMARY KEY (id),
  CONSTRAINT app_access_requests_status_check  CHECK (status IN ('pending', 'approved', 'denied')),
  CONSTRAINT app_access_requests_user_fkey     FOREIGN KEY (user_id)              REFERENCES users(id)  ON DELETE RESTRICT,
  CONSTRAINT app_access_requests_app_fkey      FOREIGN KEY (app_id)               REFERENCES apps(app_id) ON DELETE CASCADE,
  CONSTRAINT app_access_requests_staff_fkey    FOREIGN KEY (reviewed_by_staff_id) REFERENCES staff(id)  ON DELETE SET NULL
);

CREATE INDEX idx_app_access_requests_user_id ON app_access_requests(user_id);
CREATE INDEX idx_app_access_requests_app_id  ON app_access_requests(app_id);
CREATE INDEX idx_app_access_requests_pending ON app_access_requests(status) WHERE status = 'pending';
