# Data Sync System

> Automated ingestion of staff and organizational data from external
> sources into the shared PostgreSQL database.

## Overview

The platform syncs data from multiple external sources on configurable
schedules. Each source has a dedicated sync engine that fetches, classifies,
transforms, and applies data to the database. Every sync run produces
structured logs with counters, change details, skip reasons, and a
human-readable summary.

## Data Sources

| Source Key | Status | Description |
|-----------|--------|-------------|
| `google_directory` | Active | Syncs staff from Google Workspace directory (People API) |
| `google_drive` | Active | Document and folder metadata via Drive's `changes.list` API. Incremental polling on an admin-configurable cadence; full-folder scan as the bootstrap and "run sync now" path. |
| `workfront` | Coming soon | Project management data from Adobe Workfront |
| `staff_metadata_import` | Coming soon | Bulk metadata import from CSV/spreadsheet |

## Google Directory Sync

### How It Works

1. **Fetch** — Calls Google People API `listDirectoryPeople` using domain-wide
   delegation (service account impersonating `support@anomaly.com`).
2. **Classify** — Each directory entry is classified as either a `person` or
   `skip`. Non-person entries (groups, service accounts, external domains,
   no-reply addresses, newsletters) are recorded in the skip log.
3. **Map** — Person entries are transformed into staff records with fields:
   `firstName`, `lastName`, `title`, `email`, `department`.
4. **Apply** — Staff records are created or updated. Changes are written to
   `staff_changes` with `previous_value_text` for human-readable diffs.
5. **Log** — A `sync_runs` row is completed with counters, structured JSONB
   details, and a pre-rendered text summary.

### Classification — LLM-backed (replaces regex, 2026-04-22)

Lives in `src/modules/staff-classifier/` — source-agnostic (accepts any
`{ email, displayName }` pair; not coupled to Google Directory). Three
layers in order:

1. **Sync-rule overrides** (`sync-rules.service.ts`) — per-email admin
   overrides. Stubbed today; will read from a future `sync_rules` table.
   `always_skip` or `always_keep` here wins over every other layer.

2. **Hard filters** (`hard-filters.ts`) — deterministic skips. Only two
   rules, both bright-line:
   - `unmappable` — missing email OR displayName
   - `external_domain` — domain not in `PRIMARY_DOMAINS` (includes
     subdomains of the primary — e.g. `news.anomaly.com` is treated as
     external)

3. **LLM classifier** (`llm-classifier.ts`) — Gemini with structured
   output. Everything that survives the first two layers goes here.
   - Prompt key: `staff.classify_v1` in the `prompt_presets` table
     (editable without a deploy).
   - Batched 50 entries per call for token economy (~$0.02/sync for
     a 500-entry directory on Flash pricing).
   - **Greedy-keep bias** — the prompt explicitly prefers false
     positives (service account let through) over false negatives
     (real staff dropped). If the LLM returns fewer items than sent,
     a single retry covers the missing ones; anything still missing
     stays classified as `person`.
   - **Fail-open** — network errors, rate limits, or MockLlmDriver
     (unset `GEMINI_API_KEY`) all degrade to greedy-keep. A sync
     never fails because Gemini was unavailable.
   - **Audit** — service_account skips emit the LLM's short reason
     + confidence into the sync run log (see `details.skipped.detail`
     and `details.skipped.confidence`).

The old regex patterns (`SERVICE_ACCOUNT_PATTERNS`, `SERVICE_NAME_PATTERNS`)
were deleted; conventions about "this looks like a service account" now
live in the prompt, not in code. Update the prompt (and the future
sync_rules table) instead of redeploying.

### Authentication

Uses a GCP service account with domain-wide delegation:

- **Service account key:** `./secrets/contacts-service-account.json`
- **Impersonation target:** `support@anomaly.com`
- **OAuth scope:** `https://www.googleapis.com/auth/directory.readonly`
- **API:** People API (`people.googleapis.com`) must be enabled on the GCP project.

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GOOGLE_DIRECTORY_SA_KEY_PATH` | Yes | Path to service account JSON key |
| `GOOGLE_DIRECTORY_IMPERSONATE_EMAIL` | Yes | Email to impersonate for delegation |
| `GOOGLE_DIRECTORY_ENABLED` | No | Set to `false` to disable (default: `true`) |

### Running Manually

```bash
npx tsx scripts/run-directory-sync.ts
```

## Google Drive Sync

### How It Works

Drive sync is **incremental polling** via Drive's `changes.list` API. The
admin-configurable cadence runs as a Cloud Scheduler job (created in
Terraform) that POSTs to GUB's `/poll` endpoint. The handler:

1. Reads the saved `page_token` from the singleton `drive_sync_state`
   row.
2. Calls `changes.list` starting from that token, paginating internally.
3. Filters returned changes to those inside the configured root folder
   tree (defensive belt against permission-inheritance edge cases).
4. If no in-scope changes: persists the new terminal page token, returns
   200.
5. If in-scope changes exist: kicks off a full sync (`kickoffFullSync`
   pattern, fire-and-forget 202), persists the new terminal page token,
   returns 202.
6. If the saved token has expired (Drive 410 after ~7d idle), or no
   token was ever saved: clears the token, returns 503
   `bootstrap_required`.

Bootstrap and recovery share a single path: `POST /run-full-sync`. It
discovers + scans every linked account/campaign folder, then captures a
fresh start page token via `changes.getStartPageToken` at the end of a
successful run. From that point, `/poll` has somewhere to start.

### Architecture decision: pull, not push

GUB does **not** receive webhook notifications from Drive. There is no
push channel registration, no `/notify` webhook receiver, no channel-
expiry renewal. The `/notify` route in the Drive router is reviewer
**email fan-out** for proposal review — unrelated to Drive's push API.
The pull architecture trades real-time updates for operational
simplicity: no channel renewals, no inbound webhook reachability
concerns, no async delivery failures during outages.

### Chunking and the stale-sync reaper

A single `/run-full-sync` over a multi-thousand-file folder may exceed
a Cloud Run instance's reliable lifetime. The runner enforces a
**50-min wall-clock budget per chunk**, checked between entities. When
the budget trips, the runner persists `chunk_phase` + `chunk_index` to
`sync_runs`, sets `status='paused'`, and self-POSTs to
`/run-full-sync/continue` to resume in a fresh Cloud Run request.

If a Cloud Run instance dies between checkpoint persist and self-call
dispatch, the `sync_run` is left stuck. A **stale-sync reaper** runs at
the entry of `/poll`, `/run-full-sync`, and `/run-full-sync/continue`,
detecting stuck rows by their lack of recent `updated_at` activity and
flipping them to `failed`. Thresholds: `paused > 60 min`, `running >
24 hr`. Calibrated against this org's actual scale (per-project folder
ceiling ~100 files; pathological multi-project batch case ~1k files).

See backend README "Drive sync — incremental polling" for full
operational details (bootstrap procedure, token expiry recovery,
chunking math, reaper thresholds).

### Drive API authentication — STS impersonation chain

Anomaly's restricted internal Drives only allow `@anomaly.com` accounts to
be added. A service account email (`*.iam.gserviceaccount.com`) can't be
added directly. The Drive client uses an **STS impersonation chain** that
ends at a real `@anomaly.com` "bot user," which IT shares on each
restricted Drive.

```
Cloud Run runtime SA  (no key file — uses Application Default Credentials)
  ↓ holds roles/iam.serviceAccountTokenCreator on the next hop
gdrive-scanner@os-test-491819.iam.gserviceaccount.com  (dedicated Drive SA)
  ↓ Workspace admin granted DWD with scope drive.readonly to this SA only
bot@anomaly.com  (proxy user)
  ↓ shared by IT on each restricted Drive as Viewer
[Restricted client + internal Drives]
```

The Drive client (`drive.client.ts`) calls `iamcredentials.signJwt` to
sign a JWT *as* the dedicated Drive SA, with `sub=bot@anomaly.com` in
the JWT payload. The signed JWT is exchanged at
`oauth2.googleapis.com/token` for an OAuth access token that represents
the bot user. That token is used for Drive API calls.

The chain is selected at boot when `GOOGLE_DRIVE_TARGET_SA` is set.
Without it, the client falls back to a legacy key-file path (Path A in
`drive.client.ts`) — convenient for dev environments that haven't been
through the IT setup yet.

**Egress filter.** All auth paths run `assertSubjectAllowed()` against
the boot-time configured bot user, so a future code path that tries to
impersonate any other user fails loudly. This is defense-in-depth, not
absolute prevention — a sufficiently capable RCE attacker can mint tokens
along the same chain. The real protections at this layer are: scope
locked to `drive.readonly` (no writes/deletes), bot user only shared on
intended Drives, and clean revocation via the dedicated SA boundary.

See backend README "Drive API auth — STS impersonation chain" for the
full GCP/Workspace setup checklist.

### Admin endpoint authentication (debt — Item 7b)

Currently the Drive admin endpoints (`/poll`, `/run-full-sync`,
`/run-full-sync/continue`, `/cron`, `/notify`, `/sweep-expired`) accept
any caller — same KNOWN DEBT pattern as `google-directory/cron`. Item
7b will add OIDC ID-token verification at the gateway in one pass for
all admin endpoints across both integrations.

### Environment Variables

| Variable | Purpose |
|----------|---------|
| `DRIVE_ROOT_FOLDER_ID` | Shared-drive root folder; required for discovery + the in-scope filter on `/poll` |
| `GOOGLE_DRIVE_TARGET_SA` | Dedicated Drive SA for the impersonation chain. Setting this enables Path B; leaving unset selects the legacy key-file path. |
| `GOOGLE_DRIVE_IMPERSONATE_EMAIL` | The `@anomaly.com` bot/proxy user the dedicated SA impersonates via DWD. Mandatory for Path B. |
| `GOOGLE_DRIVE_SA_KEY_PATH` / `_B64` | Path-A only: legacy SA key (falls back to `GOOGLE_DIRECTORY_SA_KEY_*`). Ignored when Path B is selected. |
| `SELF_BASE_URL` | Self-call target for chunk continuation; falls back to `JWT_ISSUER` |
| `DRIVE_DELAY_BETWEEN_ACCOUNTS_MS` | Pacing between account scans (default 5000) |
| `DRIVE_DELAY_BETWEEN_CAMPAIGNS_MS` | Pacing between campaign scans (default 2000) |
| `DRIVE_DELAY_BETWEEN_FILES_MS` | Pacing between file extractions (default 500) |
| `DRIVE_MAX_FILE_SIZE_BYTES` | Files larger than this are skipped (default 25 MB) |
| `DRIVE_PROPOSAL_TTL_DAYS` | Proposal expiry window (default 14) |

## Sync Run Logging

### sync_runs Table

Every sync execution creates a row in `sync_runs`:

| Column | Type | Description |
|--------|------|-------------|
| `source` | string | Data source key (e.g. `google_directory`) |
| `status` | string | `running`, `success`, or `failed` |
| `started_at` | timestamptz | When the sync began |
| `completed_at` | timestamptz | When the sync finished |
| `duration_ms` | int | Total runtime in milliseconds |
| `total_scanned` | int | Total entries fetched from source |
| `created` | int | New records created |
| `updated` | int | Existing records updated |
| `unchanged` | int | Records with no changes |
| `skipped` | int | Entries skipped (non-person, etc.) |
| `errored` | int | Entries that failed to process |
| `details` | jsonb | Structured data: changes, skips, errors with names/emails |
| `summary` | text | Pre-rendered human-readable report |

### data_sources Table

Configuration for each sync source:

| Column | Type | Description |
|--------|------|-------------|
| `key` | string (unique) | Source identifier |
| `name` | string | Display name |
| `description` | text | Human-readable description |
| `is_active` | boolean | Whether scheduled syncing is enabled |
| `sync_interval` | string | `hourly`, `daily`, `weekly`, or `manual` |
| `cron_schedule` | string | Generated cron expression (e.g. `0 6 * * *`) |
| `last_sync_at` | timestamptz | Timestamp of last completed sync |
| `last_status` | string | `success` or `failed` |

### Sync Run Service

The shared service (`sync-run.service.ts`) provides:

- `startSyncRun(source)` — Creates a `running` row, returns the ID.
  Also runs the **stale-run sweep** at the start of every new run:
  anything stuck in `running` for > 15 minutes is flipped to `failed`
  with a diagnostic summary. This is the safety net for background
  work that dies mid-flight (Cloud Run instance terminated, OOM, crash).
- `completeSyncRun(runId, source, counters, details, status)` — Writes final
  counters, JSONB details, human-readable summary, and updates the
  `data_sources` row with `last_sync_at` and `last_status`.
- `sweepStaleSyncRuns(maxAgeMs = 15m)` — Standalone sweeper. Called
  inside `startSyncRun`; can also be called manually for housekeeping.

### API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/integrations/sync-runs` | List runs (filterable by `?source=`) |
| `GET` | `/integrations/sync-runs/latest/:source` | Latest run for a source |
| `GET` | `/integrations/sync-runs/:id` | Full run details |
| `POST` | `/integrations/google-directory/cron` | Trigger Directory sync |
| `POST` | `/integrations/google-drive/poll` | **Cloud Scheduler target** for Drive. Calls `changes.list`; only fires a full sync when in-scope changes exist. 200 / 202 / 503. |
| `POST` | `/integrations/google-drive/run-full-sync` | Admin "Run sync now" + bootstrap path. Captures a fresh start page token at end of run so the next `/poll` has somewhere to start. Chunked for large folders. |
| `POST` | `/integrations/google-drive/run-full-sync/continue` | Self-call continuation. Body `{ syncRunId }`. Resumes a paused sync from its checkpoint. |
| `POST` | `/integrations/google-drive/cron` | Legacy alias for `/run-full-sync`. Retained so older callers don't break. |
| `POST` | `/integrations/google-drive/notify` | On-demand reviewer email fan-out for pending+unnotified proposals. NOT a webhook receiver. |
| `POST` | `/integrations/google-drive/sweep-expired` | Cron target — flip expired proposals to `state='expired'`. |

**Admin endpoint auth — known gap:** all POST endpoints above are
currently unauthenticated. See `drive.router.ts` inline TODO(security).
Tracked to be replaced with service-to-service Google ID token auth
(whitelisted caller SA → verified against Google JWKS).

### Cloud Run runtime requirements

Background sync work runs as fire-and-forget (the HTTP handler returns
202 before the sync finishes). Cloud Run's default CPU throttling
silently kills these — fix is `--no-cpu-throttling` on the service
(codified in `cloudbuild/dev.yaml`; applied to the dev service
2026-04-22). Without it, runs get stuck in `running` forever and never
write a summary. The sweep described above also catches this, but
prevention is the real fix.

## Change Log Previous Values

All five change log tables (`account_changes`, `campaign_changes`,
`office_changes`, `team_changes`, `staff_changes`) include `previous_value_*`
columns alongside existing value columns. This enables human-readable diffs
like "title: Producer -> Senior Producer" without querying historical rows.

| Column | Type | Purpose |
|--------|------|---------|
| `previous_value_text` | text | Previous string value |
| `previous_value_uuid` | uuid | Previous FK reference |
| `previous_value_date` | timestamptz | Previous date value |

A `NULL` previous value on a creation row means the property didn't exist before.

## Admin CMS Integration

The `gub-admin` CMS provides a Data Sources dashboard at `/data-sources`:

- **List view** — All sources with status badges, human-readable schedule
  descriptions, last sync time, and run counts. Coming-soon sources are dimmed.
- **Detail view** — Per-source configuration (interval, schedule, active/inactive)
  with a friendly dropdown-based cron builder, plus run history table.
- **Run detail view** — Counter cards, pre-rendered summary, changes table
  with inline diffs, skipped entries grouped by reason, and errors table.
- **API** — `PATCH /api/data-sources/:key` for updating sync configuration.
