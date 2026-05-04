-- Remove app-level access gating from GUB.
--
-- See docs/proposals/remove-app-access-gating.md for the full reasoning.
-- TL;DR: GUB does auth and data access. App-level "can this user use
-- this app?" decisions belong to each consuming app, not centralized
-- here. This migration removes the centralized gate's data layer.
--
-- Removed:
--   - app_access_requests:    the request/approval flow that only existed
--                             because of the gate.
--   - user_app_permissions:   the per-user, per-app permission rows the
--                             gate consulted; also the source of the
--                             permissions[] claim in JWTs (also dropped
--                             at the code layer in this PR).
--   - apps.auto_access:       was the escape hatch from the gate's
--                             onboarding pain. No gate, no escape hatch.
--   - apps.is_active:         was used to gate access. The audience
--                             registry doesn't need an active flag.
--
-- Preserved:
--   - apps (id, app_id, name, description, db_identifier, created_at,
--     updated_at): kept as a thin friendly-name registry for appIds.
--     Used by gub-admin's read-only listing; not a gate.

-- ─── 1. Drop the request/approval table ────────────────────────────────
-- Foreign keys: user (RESTRICT — but no longer matters since the table
-- itself is going), app (CASCADE), reviewed_by_staff (SET NULL).
DROP TABLE IF EXISTS "app_access_requests";

-- ─── 2. Drop the per-user/per-app permissions table ────────────────────
-- This is what populated the JWT `permissions[]` claim. With the table
-- gone, the JWT signing code (jwt.service.ts) drops the claim too —
-- consumers reading payload.permissions will see undefined and should
-- migrate to making access decisions on their own data.
DROP TABLE IF EXISTS "user_app_permissions";

-- ─── 3. Strip the gate-related columns from apps ───────────────────────
-- The remaining shape:
--   apps(id, app_id UNIQUE, name, description, db_identifier,
--        created_at, updated_at)
-- — a registry that gives appIds friendly names. Nothing more.
ALTER TABLE "apps"
  DROP COLUMN IF EXISTS "auto_access",
  DROP COLUMN IF EXISTS "is_active";
