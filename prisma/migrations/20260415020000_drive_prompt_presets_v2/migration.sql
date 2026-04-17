-- Update drive.file_extraction.v1 and drive.distillation.v1 prompt templates
-- to the v2 shape, which pairs with Gemini structured output (responseSchema).
--
-- The schema enforces response shape, so the prompt only needs to explain
-- context + intent. No JSON-shape instructions in the prompt anymore —
-- that's the schema's job.

UPDATE "prompt_presets"
SET
  "description" = 'Per-file extraction: interprets a Drive file against BOTH account and campaign current state and emits candidate observations per entity. Response shape is enforced by Gemini responseSchema.',
  "template" = $TEMPLATE$You are reading a file from a shared Google Drive belonging to an agency project. The file may contain evidence that the account or campaign's current state is incorrect or out of date.

ACCOUNT
  Name: {{account_name}}
  Current state (authoritative — only propose changes that disagree with this):
{{account_current_state_json}}

CAMPAIGN
  Name: {{campaign_name}}
  Current state (authoritative — only propose changes that disagree with this):
{{campaign_current_state_json}}

FILE
  Path: {{file_path}}
  Last modified: {{modified_time}} by {{modified_by}}

  Contents:
  """
  {{file_text}}
  """

TASK
  Produce an observation for each entity (account, campaign) according to the output schema.

  For each entity:
    - If the file contains NO information that would change the entity's current state, return an empty array for that entity. Do not emit change proposals for values already reflected in current state.
    - For each genuine change the file implies, emit kind="field_change" with the field name and the proposed new value as a string. Dates: YYYY-MM-DD. UUIDs: raw uuid. Numbers: decimal string. Use null to propose clearing a field.
    - For relevant-but-not-field-mappable information (e.g. a stakeholder note, a competitive signal), emit kind="note" with note_text and omit field/proposed_value.

  Always include a one-sentence reasoning citing what in the file implies the observation, and a confidence between 0 and 1.
  Be conservative: if unsure whether the file is authoritative for a field, prefer kind="note" with the relevant excerpt over a field_change.$TEMPLATE$,
  "variables" = '["account_name","account_current_state_json","campaign_name","campaign_current_state_json","file_path","modified_time","modified_by","file_text"]'::jsonb,
  "updated_at" = NOW()
WHERE "key" = 'drive.file_extraction.v1';

UPDATE "prompt_presets"
SET
  "description" = 'Per-entity distillation: dedupes and conflict-resolves a run''s observations for a single entity; splits into field_changes, notes, ambiguous. Response shape is enforced by Gemini responseSchema.',
  "template" = $TEMPLATE$You are reviewing all observations extracted this scan run for a single {{entity_type}}.

WRITABLE FIELDS for {{entity_type}} (only these field names are valid in field_changes):
{{writable_fields_json}}

OBSERVATIONS (array, each tagged with source_file_id):
{{observations_json}}

CURRENT {{entity_type}} STATE (authoritative):
{{current_state_json}}

TASK
  Produce a deduped, conflict-resolved set of proposed changes and notes for this entity.

  - field_changes: merge duplicates that propose the same field. If multiple files disagree on a field's value and you cannot confidently pick one, move the disagreement to `ambiguous` instead of emitting a field_change.
  - Drop any observation whose proposed_value already matches current state.
  - notes: carry forward kind="note" observations that are still relevant, consolidating near-duplicates. Each note should cite source_file_ids.
  - ambiguous: anything conflicting, low-confidence, or unresolvable. Always cite source_file_ids and, when helpful, a short reasoning.
  - For each field_change, include every source_file_id that contributed to it.

  Be conservative. It is better to mark something ambiguous than to propose a wrong field_change.$TEMPLATE$,
  "variables" = '["entity_type","writable_fields_json","observations_json","current_state_json"]'::jsonb,
  "updated_at" = NOW()
WHERE "key" = 'drive.distillation.v1';
