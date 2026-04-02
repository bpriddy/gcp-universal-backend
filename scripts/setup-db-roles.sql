-- ─────────────────────────────────────────────────────────────────────────────
-- GUB database role setup
-- Run once per environment as a PostgreSQL superuser BEFORE running migrations.
--
-- Usage (local):
--   psql -d gub_dev -f scripts/setup-db-roles.sql
--
-- Usage (Cloud SQL):
--   Via Cloud SQL Auth Proxy or gcloud sql connect, as the postgres user.
--
-- Roles created:
--   gub_migrator  — DDL privileges; used exclusively by prisma migrate deploy
--   gub_app       — DML on all tables; used by the API and gub-admin at runtime
--   gub_admin     — Same as gub_app but with BYPASSRLS; used by gub-admin only
--   gub_readonly  — SELECT only; for reporting, analytics, read replicas
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Create roles ───────────────────────────────────────────────────────────
-- Passwords should be overridden in each environment via:
--   ALTER ROLE gub_migrator PASSWORD '<secret from Secret Manager>';

DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'gub_migrator') THEN
    CREATE ROLE gub_migrator LOGIN PASSWORD 'change_me_migrator';
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'gub_app') THEN
    CREATE ROLE gub_app LOGIN PASSWORD 'change_me_app';
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'gub_admin') THEN
    CREATE ROLE gub_admin LOGIN PASSWORD 'change_me_admin';
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'gub_readonly') THEN
    CREATE ROLE gub_readonly LOGIN PASSWORD 'change_me_readonly';
  END IF;
END $$;

-- ── 2. Schema-level access ────────────────────────────────────────────────────

GRANT USAGE ON SCHEMA public TO gub_migrator, gub_app, gub_admin, gub_readonly;

-- gub_migrator needs to create and alter objects
GRANT CREATE ON SCHEMA public TO gub_migrator;

-- ── 3. Grant on existing tables ───────────────────────────────────────────────

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO gub_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO gub_admin;
GRANT SELECT                         ON ALL TABLES IN SCHEMA public TO gub_readonly;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO gub_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO gub_admin;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO gub_readonly;

-- ── 4. Default privileges — auto-grant on future tables ───────────────────────
-- Every table created by gub_migrator in future migrations will automatically
-- receive the correct grants. Nothing to remember per migration.

ALTER DEFAULT PRIVILEGES FOR ROLE gub_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO gub_app;

ALTER DEFAULT PRIVILEGES FOR ROLE gub_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO gub_admin;

ALTER DEFAULT PRIVILEGES FOR ROLE gub_migrator IN SCHEMA public
  GRANT SELECT ON TABLES TO gub_readonly;

ALTER DEFAULT PRIVILEGES FOR ROLE gub_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO gub_app;

ALTER DEFAULT PRIVILEGES FOR ROLE gub_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO gub_admin;

-- ── 5. BYPASSRLS for gub_admin ────────────────────────────────────────────────
-- gub-admin is protected by GCP IAP at the network layer; it needs to read
-- and write all rows regardless of any future RLS policies on the API path.

ALTER ROLE gub_admin BYPASSRLS;

-- ── 6. Restrict gub_app and gub_readonly from DDL ────────────────────────────
-- These roles must never be able to create, alter, or drop schema objects.
-- (They have no CREATE on schema public, so this is already enforced above —
-- this comment documents the intent explicitly for audit purposes.)

-- ── Done ──────────────────────────────────────────────────────────────────────
-- Next steps:
--   1. Set strong passwords: ALTER ROLE <role> PASSWORD '<from Secret Manager>';
--   2. Update DATABASE_URL in .env to use gub_app credentials
--   3. Add DATABASE_MIGRATOR_URL in .env to use gub_migrator credentials
--   4. Add DATABASE_ADMIN_URL in gub-admin .env to use gub_admin credentials
--   5. In production, enforce sslmode=require on all connection strings

\echo 'GUB roles created and privileges granted.'
\echo 'Remember to set strong passwords before use in any non-local environment.'
