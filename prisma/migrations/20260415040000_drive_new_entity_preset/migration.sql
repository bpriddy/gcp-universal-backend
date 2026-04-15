-- Seed the drive.new_entity_extraction.v1 prompt preset.
-- Used by drive.discover.ts when a Drive folder has no matching entity
-- in our DB. Response shape is enforced by Gemini responseSchema
-- (newEntityResponseSchema in drive.structured-output.ts).

INSERT INTO "prompt_presets" ("key", "description", "template", "variables", "model", "temperature")
VALUES (
  'drive.new_entity_extraction.v1',
  'New-entity discovery: given a Drive folder and a sample of its files, proposes initial field values for a new account or campaign. Response shape is enforced by Gemini responseSchema.',
  $TEMPLATE$You are examining a folder in a shared Google Drive to decide whether it represents a new {{entity_type}} that should be added to our database, and if so, what its initial field values should be.

FOLDER
  Name: {{folder_name}}
  Path: {{folder_path}}
  Drive folder id: {{folder_id}}

PARENT ACCOUNT (authoritative context for campaign proposals)
{{parent_account_state_json}}

SAMPLE OF FILES inside this folder (up to a few files, with text previews):
{{file_sample_json}}

WRITABLE FIELDS for this {{entity_type}} (only these field names are valid in the proposal):
{{writable_fields_json}}

TASK
  First, decide whether this folder actually represents a new {{entity_type}}.
  Set is_entity=false (and give a short skip_reason) when the folder looks like:
    - a scratchpad / archive / template / inbox
    - a personal folder for an internal employee
    - a sub-project of something that isn't itself an entity
    - empty or filled with non-business artifacts
  Set is_entity=true only when the folder's name + contents clearly indicate a real {{entity_type}}.

  If is_entity=true, fill `proposal` with:
    - name: the entity's name. Usually the folder name, cleaned up (e.g. strip trailing "(old)", normalize casing).
    - One entry per writable field for which the folder's contents support a confident proposal. Values are always strings:
      dates as YYYY-MM-DD, uuids as raw uuid, numbers as decimal strings. Use null (or omit) when you can't propose a confident initial value — the owner will fill it in later.

  For campaign proposals, lean on the parent account state above — e.g. don't invent an industry if one is already on the parent; don't propose dates outside a plausible range for an agency campaign.

  Always include:
    - reasoning: one-to-three sentences citing what in the folder/files led to this proposal (or the skip decision).
    - confidence: 0.0–1.0, your subjective certainty that (a) this is a {{entity_type}} and (b) the proposed values are correct.

  Be conservative. It is better to propose fewer fields at higher confidence than many fields at low confidence — the owner has to approve each one. When in doubt on a field, omit it; when in doubt on whether the folder is an entity at all, set is_entity=false with a clear skip_reason.$TEMPLATE$,
  '["entity_type","folder_name","folder_path","folder_id","parent_account_state_json","file_sample_json","writable_fields_json"]'::jsonb,
  'gemini-1.5-pro',
  0.20
)
ON CONFLICT ("key") DO UPDATE SET
  "description" = EXCLUDED."description",
  "template"    = EXCLUDED."template",
  "variables"   = EXCLUDED."variables",
  "model"       = EXCLUDED."model",
  "temperature" = EXCLUDED."temperature",
  "updated_at"  = NOW();
