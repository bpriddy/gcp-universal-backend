-- CORS allow-list — runtime-mutable replacement for the env-driven list.
--
-- Dev/staging-scoped admin tooling: lets a gub-admin operator add or
-- remove allowed origins at runtime via the admin UI without a redeploy.
-- The originAllowList middleware queries this table on every request
-- that has an Origin header (except public-by-design bypass paths).
--
-- Production should NOT rely on this — production CORS is handled at the
-- edge (WAF, Cloud Armor, load balancer). The middleware staying mounted
-- in prod is defense-in-depth, not the primary boundary.

CREATE TABLE "cors_allowed_origins" (
  "id"         UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  "origin"     TEXT         NOT NULL UNIQUE,
  "label"      TEXT         NULL,
  "is_active"  BOOLEAN      NOT NULL DEFAULT true,
  "added_by"   UUID         NULL REFERENCES "staff"("id") ON DELETE SET NULL,
  "created_at" TIMESTAMPTZ  NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX "cors_allowed_origins_origin_is_active_idx"
  ON "cors_allowed_origins" ("origin", "is_active");

-- Seed from the current cloudbuild/dev.yaml _CORS_ALLOWED_ORIGINS list
-- verbatim. Preserves existing behavior so the cutover is invisible to
-- consumers. Operators can then prune or relabel via the admin UI.
INSERT INTO "cors_allowed_origins" ("origin", "label", "is_active") VALUES
  ('https://d87ae7f0-70ba-4579-b44b-761cd572dda4-00-362241jmj0fns.riker.replit.dev',
   'work-flows Replit dev (initial)',
   true),
  ('https://fcbe1f1a-8730-4a88-969c-15fcf173fde6-00-118j2bu44tt6p.kirk.replit.dev',
   'work-flows Replit dev (implementer fork, 2026-04-30)',
   true),
  ('http://localhost:5173',
   'Local Vite dev server (default port)',
   true),
  ('http://localhost:3000',
   'Local Express server (default port)',
   true)
ON CONFLICT ("origin") DO NOTHING;
