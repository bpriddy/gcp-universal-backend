-- Trusted Apps registry — consolidation of the CORS origin allow-list
-- and the Google audience allow-list into a single per-consuming-app row.
--
-- Operator's mental model: "I trust this consuming app to talk to GUB."
-- Each row holds the identifiers the app uses at the layers GUB actually
-- enforces:
--   - origins: which browser origins may make cross-origin requests
--   - google_client_ids: which Google OAuth client_ids GUB will trust
--     ID tokens from at /auth/google/exchange
--
-- Strict pairing: at /auth/google/exchange, BOTH the request's Origin
-- header and the token's `aud` claim must appear on the SAME row. A fork
-- of a registered app does not inherit access — its origin is unrelated
-- to the parent's row, and its Google client_id is too. This stops
-- "derivative" environments from quietly reusing a parent app's trust.
--
-- The cors_allowed_origins table this replaces was hours old; we fold
-- each existing row into a trusted_apps entry with the origin populated
-- and google_client_ids empty (they'll be filled in by an operator the
-- first time someone tries to sign in from that origin).

CREATE TABLE "trusted_apps" (
  "id"                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  "name"                TEXT         NOT NULL,
  "origins"             TEXT[]       NOT NULL DEFAULT ARRAY[]::TEXT[],
  "google_client_ids"   TEXT[]       NOT NULL DEFAULT ARRAY[]::TEXT[],
  "is_active"           BOOLEAN      NOT NULL DEFAULT true,
  "added_by"            UUID         NULL REFERENCES "staff"("id") ON DELETE SET NULL,
  "created_at"          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  "updated_at"          TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- GIN indexes on the array columns for fast membership lookups. Matches
-- the access patterns:
--   originAllowList:    SELECT 1 FROM trusted_apps WHERE is_active AND $1 = ANY(origins)
--   verifyGoogleToken:  SELECT 1 FROM trusted_apps
--                       WHERE is_active
--                         AND $aud = ANY(google_client_ids)
--                         AND $origin = ANY(origins)
CREATE INDEX "trusted_apps_origins_gin_idx"
  ON "trusted_apps" USING GIN ("origins");
CREATE INDEX "trusted_apps_google_client_ids_gin_idx"
  ON "trusted_apps" USING GIN ("google_client_ids");
CREATE INDEX "trusted_apps_is_active_idx"
  ON "trusted_apps" ("is_active");

-- Migrate every cors_allowed_origins row into trusted_apps. Each becomes
-- a one-origin app whose name is the original label (or origin if no
-- label). google_client_ids stays empty until an operator adds one.
INSERT INTO "trusted_apps" ("name", "origins", "google_client_ids", "is_active", "added_by", "created_at")
SELECT
  COALESCE("label", "origin"),
  ARRAY["origin"],
  ARRAY[]::TEXT[],
  "is_active",
  "added_by",
  "created_at"
FROM "cors_allowed_origins";

-- Drop the old table. There are no foreign-key dependencies on it
-- (added_by points OUT to staff, nothing points IN), and the only readers
-- are this codebase's originAllowList middleware + gub-admin's UI — both
-- ship in the same coordinated deploy as this migration.
DROP TABLE "cors_allowed_origins";
