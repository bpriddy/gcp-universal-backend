-- Drive Sync Foundation
-- Adds drive folder refs to accounts/campaigns, account owner, per-file snapshots,
-- scan logs (uncategorized insights sink), change proposals (structured insights sink),
-- and the prompt_presets table used across LLM-driven modules.
--
-- Sync run metadata reuses the existing sync_runs table with source = 'google_drive'.

-- ─── accounts: owner + drive folder ─────────────────────────────────────────
ALTER TABLE "accounts"
  ADD COLUMN "owner_staff_id"        UUID NULL REFERENCES "staff"("id") ON DELETE SET NULL,
  ADD COLUMN "drive_folder_id"       TEXT NULL,
  ADD COLUMN "drive_folder_url"      TEXT NULL,
  ADD COLUMN "drive_folder_path"     TEXT NULL,
  ADD COLUMN "drive_last_scanned_at" TIMESTAMPTZ NULL;

CREATE INDEX "accounts_owner_staff_id_idx"   ON "accounts"("owner_staff_id");
CREATE INDEX "accounts_drive_folder_id_idx"  ON "accounts"("drive_folder_id");

-- ─── campaigns: drive folder ────────────────────────────────────────────────
ALTER TABLE "campaigns"
  ADD COLUMN "drive_folder_id"       TEXT NULL,
  ADD COLUMN "drive_folder_url"      TEXT NULL,
  ADD COLUMN "drive_folder_path"     TEXT NULL,
  ADD COLUMN "drive_last_scanned_at" TIMESTAMPTZ NULL;

CREATE INDEX "campaigns_drive_folder_id_idx" ON "campaigns"("drive_folder_id");

-- ─── prompt_presets ─────────────────────────────────────────────────────────
-- Editable preset prompts. Used by Drive sync for file extraction + distillation,
-- but generic so other modules can reuse the pattern.
CREATE TABLE "prompt_presets" (
  "id"          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "key"         TEXT NOT NULL UNIQUE,
  "description" TEXT NULL,
  "template"    TEXT NOT NULL,
  "variables"   JSONB NOT NULL DEFAULT '[]'::jsonb,
  "model"       TEXT NOT NULL DEFAULT 'gemini-1.5-pro',
  "temperature" NUMERIC(3,2) NOT NULL DEFAULT 0.20,
  "is_active"   BOOLEAN NOT NULL DEFAULT TRUE,
  "updated_by"  UUID NULL REFERENCES "staff"("id") ON DELETE SET NULL,
  "created_at"  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at"  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── drive_file_snapshots ───────────────────────────────────────────────────
-- Append-only per-file history. Delta skip compares Drive's modifiedTime to
-- the max scanned_at for this file_id.
CREATE TABLE "drive_file_snapshots" (
  "id"             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "sync_run_id"    UUID NULL REFERENCES "sync_runs"("id") ON DELETE SET NULL,
  "file_id"        TEXT NOT NULL,
  "account_id"     UUID NULL REFERENCES "accounts"("id") ON DELETE SET NULL,
  "campaign_id"    UUID NULL REFERENCES "campaigns"("id") ON DELETE SET NULL,
  "name"           TEXT NOT NULL,
  "mime_type"      TEXT NULL,
  "path"           TEXT NULL,
  "modified_time"  TIMESTAMPTZ NULL,
  "modified_by"    TEXT NULL,
  "size_bytes"     BIGINT NULL,
  "content_hash"   TEXT NULL,
  "was_extracted"  BOOLEAN NOT NULL DEFAULT FALSE,
  "skip_reason"    TEXT NULL,
  "scanned_at"     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX "drive_file_snapshots_file_id_scanned_at_idx"  ON "drive_file_snapshots"("file_id", "scanned_at" DESC);
CREATE INDEX "drive_file_snapshots_account_id_idx"          ON "drive_file_snapshots"("account_id");
CREATE INDEX "drive_file_snapshots_campaign_id_idx"         ON "drive_file_snapshots"("campaign_id");
CREATE INDEX "drive_file_snapshots_sync_run_id_idx"         ON "drive_file_snapshots"("sync_run_id");

-- ─── drive_scan_logs ────────────────────────────────────────────────────────
-- Uncategorized-but-interesting info + operational warnings.
-- Mirrors the directory-sync-logs UX.
CREATE TABLE "drive_scan_logs" (
  "id"           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "sync_run_id"  UUID NULL REFERENCES "sync_runs"("id") ON DELETE SET NULL,
  "account_id"   UUID NULL REFERENCES "accounts"("id") ON DELETE SET NULL,
  "campaign_id"  UUID NULL REFERENCES "campaigns"("id") ON DELETE SET NULL,
  "file_id"      TEXT NULL,
  "level"        TEXT NOT NULL,
  "category"     TEXT NOT NULL,
  "message"      TEXT NOT NULL,
  "payload"      JSONB NULL,
  "created_at"   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "drive_scan_logs_level_check"
    CHECK (level IN ('info','note','warn','error')),
  CONSTRAINT "drive_scan_logs_category_check"
    CHECK (category IN (
      'uncategorized_insight',
      'ambiguous',
      'skipped_delta',
      'skipped_mime',
      'skipped_size',
      'parse_error',
      'extract_error',
      'llm_error',
      'traversal_error',
      'diagnostic'
    ))
);

CREATE INDEX "drive_scan_logs_sync_run_id_idx"             ON "drive_scan_logs"("sync_run_id");
CREATE INDEX "drive_scan_logs_account_id_created_at_idx"   ON "drive_scan_logs"("account_id", "created_at" DESC);
CREATE INDEX "drive_scan_logs_campaign_id_created_at_idx"  ON "drive_scan_logs"("campaign_id", "created_at" DESC);
CREATE INDEX "drive_scan_logs_level_idx"                   ON "drive_scan_logs"("level");

-- ─── drive_change_proposals ─────────────────────────────────────────────────
-- Structured, reviewable proposals. On approval, the module writes a row into
-- account_changes / campaign_changes using the approver's staff_id as changed_by.
CREATE TABLE "drive_change_proposals" (
  "id"                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "sync_run_id"       UUID NULL REFERENCES "sync_runs"("id") ON DELETE SET NULL,
  "entity_type"       TEXT NOT NULL,
  "account_id"        UUID NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "campaign_id"       UUID NULL REFERENCES "campaigns"("id") ON DELETE CASCADE,
  "property"          TEXT NOT NULL,
  "current_value"     JSONB NULL,
  "proposed_value"    JSONB NULL,
  "reasoning"         TEXT NULL,
  "source_file_ids"   TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "confidence"        NUMERIC(3,2) NULL,
  "state"             TEXT NOT NULL DEFAULT 'pending',
  "review_token"      TEXT NOT NULL UNIQUE,
  "reviewer_email"    TEXT NULL,
  "reviewer_staff_id" UUID NULL REFERENCES "staff"("id") ON DELETE SET NULL,
  "expires_at"        TIMESTAMPTZ NOT NULL,
  "decided_at"        TIMESTAMPTZ NULL,
  "decided_by"        UUID NULL REFERENCES "staff"("id") ON DELETE SET NULL,
  "applied_change_id" UUID NULL,
  "created_at"        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "drive_change_proposals_entity_type_check"
    CHECK (entity_type IN ('account','campaign')),
  CONSTRAINT "drive_change_proposals_state_check"
    CHECK (state IN ('pending','approved','rejected','applied','expired')),
  CONSTRAINT "drive_change_proposals_entity_id_present"
    CHECK ((entity_type = 'account' AND account_id IS NOT NULL AND campaign_id IS NULL)
        OR (entity_type = 'campaign' AND campaign_id IS NOT NULL))
);

CREATE INDEX "drive_change_proposals_state_idx"                  ON "drive_change_proposals"("state");
CREATE INDEX "drive_change_proposals_account_id_state_idx"       ON "drive_change_proposals"("account_id","state");
CREATE INDEX "drive_change_proposals_campaign_id_state_idx"      ON "drive_change_proposals"("campaign_id","state");
CREATE INDEX "drive_change_proposals_sync_run_id_idx"            ON "drive_change_proposals"("sync_run_id");
CREATE INDEX "drive_change_proposals_reviewer_staff_id_idx"      ON "drive_change_proposals"("reviewer_staff_id");
CREATE INDEX "drive_change_proposals_expires_at_idx"             ON "drive_change_proposals"("expires_at");

-- ─── seed: starter prompt presets ───────────────────────────────────────────
INSERT INTO "prompt_presets" ("key", "description", "template", "variables", "model", "temperature")
VALUES
  (
    'drive.file_extraction.v1',
    'Per-file extraction: interprets a Drive file against account+campaign context and emits candidate observations.',
    $TEMPLATE$You are reading a file from a shared Google Drive belonging to an agency project.

Context:
  Account:   {{account_name}} (status: {{account_status}})
  Campaign:  {{campaign_name}} (launch: {{campaign_launch_date}})
  File path: {{file_path}}
  Last modified: {{modified_time}} by {{modified_by}}

File contents:
"""
{{file_text}}
"""

Extract observations that may be relevant to the account or campaign state.
Return ONLY a JSON array. If nothing is relevant, return [].

Each observation:
{
  "kind":           "field_change" | "note",
  "entity":         "account" | "campaign",
  "field":          "<snake_case property name, or null>",
  "proposed_value": <any, or null>,
  "note":           "<short human-readable summary, or null>",
  "reasoning":      "<why this file implies this>",
  "confidence":     <number between 0 and 1>
}$TEMPLATE$,
    '["account_name","account_status","campaign_name","campaign_launch_date","file_path","modified_time","modified_by","file_text"]'::jsonb,
    'gemini-1.5-pro',
    0.20
  ),
  (
    'drive.distillation.v1',
    'Per-entity distillation: dedupes and conflict-resolves a run''s observations; splits into field_changes, notes, ambiguous.',
    $TEMPLATE$You are reviewing all observations extracted this week for a single {{entity_type}}.

Observations (JSON array):
{{observations_json}}

Current {{entity_type}} state (JSON):
{{current_state_json}}

Produce a deduped, conflict-resolved set.
- Merge duplicates, preferring the most recent source.
- Drop observations already reflected in current state.
- Flag unresolved conflicts as kind="note" with an explicit "ambiguity" reasoning.

Return ONLY JSON:
{
  "field_changes": [ { "field": "...", "proposed_value": ..., "reasoning": "...", "source_file_ids": [...], "confidence": <0..1> } ],
  "notes":         [ { "text": "...", "source_file_ids": [...] } ],
  "ambiguous":     [ { "text": "...", "source_file_ids": [...], "reasoning": "..." } ]
}$TEMPLATE$,
    '["entity_type","observations_json","current_state_json"]'::jsonb,
    'gemini-1.5-pro',
    0.20
  );
