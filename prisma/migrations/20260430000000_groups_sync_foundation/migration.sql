-- Groups sync foundation
-- Adds the schema needed for the Google Groups → teams sync, which mirrors
-- the existing Google Directory → staff sync:
--
--   1. team_external_ids — stable mapping from Google Group ID → team.id.
--      Mirrors staff_external_ids. system='google_groups', external_id=
--      <Google's stable group id>. Without this, renaming a group would
--      look like delete-old-team-then-create-new-team to the sync.
--
--   2. team_members evolution — supports "unlinked" rows for member emails
--      that don't match any staff record. Greedy ingest: when the sync
--      can't resolve an email, it writes the row with staff_id NULL +
--      source_email set + unlinked=true so the admin UI can surface it
--      for manual fix. Sync-sourced rows carry source='google_groups_sync'
--      so the standard "managed set" delete logic can remove members who
--      left the group without touching manually-added rows.
--
--   3. data_sources seed — adds the 'google_groups' row so the admin UI
--      list page shows it.

-- ─── 1. team_external_ids ─────────────────────────────────────────────────
CREATE TABLE "team_external_ids" (
  "id"          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  "team_id"     UUID        NOT NULL REFERENCES "teams"("id") ON DELETE CASCADE,
  "system"      TEXT        NOT NULL,
  "external_id" TEXT        NOT NULL,
  "created_at"  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "team_external_ids_system_external_id_key" UNIQUE ("system", "external_id")
);

CREATE INDEX "team_external_ids_team_id_idx" ON "team_external_ids" ("team_id");

-- ─── 2. team_members evolution ────────────────────────────────────────────
-- Add new columns. staff_id is being made nullable to support unlinked
-- rows; Postgres allows the existing unique (team_id, staff_id) to stay
-- (NULL != NULL by default — multiple unlinked rows are fine), but we
-- want to ALSO prevent duplicate unlinked rows for the same email per
-- team. So: drop the old unique, add a partial unique for linked rows,
-- and a partial unique for unlinked rows.

ALTER TABLE "team_members"
  ALTER COLUMN "staff_id" DROP NOT NULL,
  ADD COLUMN "source_email" TEXT NULL,
  ADD COLUMN "unlinked"     BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "source"       TEXT    NOT NULL DEFAULT 'manual';

-- Drop the table-level unique on (team_id, staff_id) — replaced below by
-- a partial unique that only applies when staff_id IS NOT NULL.
ALTER TABLE "team_members"
  DROP CONSTRAINT IF EXISTS "team_members_team_id_staff_id_key";

CREATE UNIQUE INDEX "team_members_linked_unique"
  ON "team_members" ("team_id", "staff_id")
  WHERE "staff_id" IS NOT NULL;

CREATE UNIQUE INDEX "team_members_unlinked_unique"
  ON "team_members" ("team_id", "source_email")
  WHERE "staff_id" IS NULL;

-- Index for the admin UI: "show me unlinked members for this team."
CREATE INDEX "team_members_team_unlinked_idx"
  ON "team_members" ("team_id", "unlinked");

-- Sanity check: an unlinked row must have a source_email; a linked row
-- needs neither (the foreign key carries identity). Without this, a row
-- with staff_id=NULL AND source_email=NULL would be uniquely indexable
-- only as a single "ghost" row per team, which is meaningless.
ALTER TABLE "team_members"
  ADD CONSTRAINT "team_members_unlinked_has_email"
    CHECK ("staff_id" IS NOT NULL OR "source_email" IS NOT NULL);

-- ─── 3. data_sources seed for google_groups ──────────────────────────────
-- Mirrors the seeding pattern from 20240131000000_data_sources. ON CONFLICT
-- DO NOTHING so re-running this migration on a DB that already has the
-- row is a no-op.
INSERT INTO "data_sources" ("key", "name", "description", "sync_interval", "cron_schedule")
VALUES (
  'google_groups',
  'Google Groups',
  'Workspace groups → teams sync via Admin SDK Directory API. Each group becomes a team; members are resolved to staff by email, unresolved members get unlinked rows for manual fix.',
  'daily',
  NULL
)
ON CONFLICT ("key") DO NOTHING;
