-- Seed the staff.classify_v1 prompt used by src/modules/staff-classifier.
-- Replaces the regex-based directory classifier with a batched LLM call.
--
-- Design constraints driven by the chat spec:
--   1. GREEDY bias — a real person being dropped is much worse than a
--      service account being kept. Default answer is 'person'.
--   2. Source-agnostic — the classifier takes {email, displayName} pairs;
--      it does not know or care where they came from (Google Directory
--      today; may move to Okta/BambooHR/HRIS later).
--   3. Batched — up to ~50 entries per call for token economy.
--   4. Structured output — Gemini responseSchema guarantees the shape,
--      so the prompt does not describe JSON.
--   5. No human review queue — auto-apply. When a service account leaks,
--      the future sync_rules table provides a per-email override.
--
-- Response schema (see src/modules/staff-classifier/llm-classifier.ts):
--   { items: [{ email, classification, confidence, reason }, ...] }
--   classification: 'person' | 'service_account'
--
-- Edit this row via admin UI (future). Editing here requires a re-deploy
-- of this migration idempotently (ON CONFLICT DO UPDATE).

INSERT INTO "prompt_presets" (id, key, description, template, variables, model, temperature, is_active, updated_by)
VALUES (
  gen_random_uuid(),
  'staff.classify_v1',
  'Classify directory entries as ''person'' or ''service_account''. Greedy-keep bias: default to person; only mark service_account when strong signals say so.',
  $TEMPLATE$You are helping an agency decide which Google Workspace directory entries are real human staff members and which are group mailboxes, service accounts, or automation identities that should be excluded from the staff list.

INPUT
  You will receive a batch of directory entries. Each has an email and a display name.

TASK
  For each entry, output exactly one item in the response array with:
    - email: echoed back verbatim
    - classification: 'person' or 'service_account'
    - confidence: 0.0 to 1.0 — your subjective certainty in the classification
    - reason: a short phrase (8 words or fewer) explaining the classification

  Do not drop entries. Do not invent entries. The number of items you return
  MUST equal the number of inputs. Order does not matter — the caller matches
  by email.

BIAS — VERY IMPORTANT
  A real staff member wrongly classified as 'service_account' is a SEVERE
  failure. Being a little too permissive (letting a group mailbox through
  as 'person') is ACCEPTABLE — the downstream process has an override table
  to handle those cases.

  When in doubt, default to 'person'. Use 'service_account' only when you
  have strong signals such as:
    - Email local part is a department / function name: it, hr, data, ops,
      legal, support, admin, finance, accounting, marketing, devops, security
    - Email local part is a product / tool name: jamf, datadog, sentry,
      github, slack, pagerduty, rollbar, newrelic
    - Email is noreply / alerts / notifications / bounce / mailer-daemon
    - Display name suggests a team, department, or system: "NYC Talent",
      "JAMF Alerts", "Data Analytics", "Cultural Intelligence", "Billing Operations"
    - Display name is all-uppercase or contains "TEAM", "GROUP", "ALERTS",
      "NOTIFICATIONS", "BOT", "SYSTEM"
    - Name looks like a placeholder or test account: "test user", "yoda",
      "admin anomaly", "sandbox"

  Signals that indicate a real PERSON (and therefore 'person'):
    - Display name is a plausible human first + last name
    - Email local part matches human naming patterns (flast, first.last,
      firstl, etc.)
    - Even if the local part is short (cneff, agao, tfox), if the display
      name is a human name → person

  Single-word display names that are also common first names (Eric, Mike,
  Dave, Rich, Eli, Carl) paired with short local parts → person unless
  other signals say otherwise. "Yoda" / "Master Yoda" / placeholder-seeming
  names → service_account.

ENTRIES
{{entries_json}}
$TEMPLATE$,
  '["entries_json"]'::jsonb,
  'gemini-1.5-flash',
  0.10,
  true,
  NULL
)
ON CONFLICT (key) DO UPDATE SET
  description = EXCLUDED.description,
  template = EXCLUDED.template,
  variables = EXCLUDED.variables,
  model = EXCLUDED.model,
  temperature = EXCLUDED.temperature,
  is_active = EXCLUDED.is_active,
  updated_at = NOW();
