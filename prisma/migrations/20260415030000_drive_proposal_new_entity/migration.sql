-- Extend drive_change_proposals to carry "new entity" proposals alongside
-- existing field-change proposals.
--
-- Shape:
--   kind='field_change'  → edits to an existing row (current behavior)
--   kind='new_entity'    → proposes creating a new account or campaign.
--                          One proposal row per field, grouped by proposal_group_id.
--                          On approval, the group is collapsed into one INSERT.
--
-- For kind='new_entity':
--   - account proposal:  account_id NULL,            campaign_id NULL
--   - campaign proposal: account_id NOT NULL (parent), campaign_id NULL
--   - source_drive_folder_id NOT NULL (so approval can link the folder on insert)
--   - proposal_group_id NOT NULL (groups all field rows of one proposed entity)

ALTER TABLE "drive_change_proposals"
  ADD COLUMN "kind"                   TEXT NOT NULL DEFAULT 'field_change',
  ADD COLUMN "proposal_group_id"      UUID NULL,
  ADD COLUMN "source_drive_folder_id" TEXT NULL,
  ADD CONSTRAINT "drive_change_proposals_kind_check"
    CHECK (kind IN ('field_change', 'new_entity'));

-- Replace the old entity-id presence check with one that's kind-aware.
ALTER TABLE "drive_change_proposals"
  DROP CONSTRAINT "drive_change_proposals_entity_id_present";

ALTER TABLE "drive_change_proposals"
  ADD CONSTRAINT "drive_change_proposals_entity_shape"
    CHECK (
      (kind = 'field_change' AND (
        (entity_type = 'account'  AND account_id  IS NOT NULL AND campaign_id IS NULL)
        OR
        (entity_type = 'campaign' AND campaign_id IS NOT NULL)
      ))
      OR
      (kind = 'new_entity' AND proposal_group_id IS NOT NULL AND source_drive_folder_id IS NOT NULL AND (
        (entity_type = 'account'  AND account_id IS NULL AND campaign_id IS NULL)
        OR
        (entity_type = 'campaign' AND account_id IS NOT NULL AND campaign_id IS NULL)
      ))
    );

CREATE INDEX "drive_change_proposals_proposal_group_id_idx"
  ON "drive_change_proposals"("proposal_group_id");
CREATE INDEX "drive_change_proposals_source_drive_folder_id_idx"
  ON "drive_change_proposals"("source_drive_folder_id");
CREATE INDEX "drive_change_proposals_kind_state_idx"
  ON "drive_change_proposals"("kind", "state");
