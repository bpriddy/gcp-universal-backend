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
| `workfront` | Coming soon | Project management data from Adobe Workfront |
| `google_drive` | Coming soon | Document and folder metadata from Google Drive |
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

### Classification Rules

The classifier (`directory.classifier.ts`) identifies non-person entries using:

- **Service accounts** — Email patterns like `support@`, `talent@`, `info@`,
  `berbackup@`, and display names starting with the company name.
- **External domains** — Emails not matching the primary domain(s).
- **No-reply addresses** — `noreply@`, `no-reply@`, `donotreply@` patterns.
- **Newsletters** — `newsletter@`, `updates@`, `digest@` patterns.
- **Unmappable** — Entries missing a name or email entirely.

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
- `completeSyncRun(runId, source, counters, details, status)` — Writes final
  counters, JSONB details, human-readable summary, and updates the
  `data_sources` row with `last_sync_at` and `last_status`.

### API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/integrations/sync-runs` | List runs (filterable by `?source=`) |
| `GET` | `/integrations/sync-runs/latest/:source` | Latest run for a source |
| `GET` | `/integrations/sync-runs/:id` | Full run details |

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
