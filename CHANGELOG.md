# Changelog

All notable changes to this repository are tracked here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Security entries
describe what controls were added; operational detail that could narrow
an attacker's search space (which values lived where, timing of rotations,
remaining exposures) lives in internal notes instead of this public log.

## [Unreleased]

### Google Groups → teams sync (2026-04-30)

- New module `src/modules/integrations/google-groups/` mirrors the
  Directory sync shape: `groups.client.ts` (Admin SDK Directory API,
  reuses Directory SA + DWD), `groups.sync.ts` (per-group upsert + diff
  + member resolution), `groups.cron.ts` (orchestrator), `groups.router.ts`
  (POST /cron, fire-and-forget 202).
- Each Workspace group becomes a team. Greedy ingest — no name/size
  filtering. If a group shouldn't be a team, admin flips `isActive=false`
  on the team manually.
- Members are resolved to staff by email. Unresolved members get
  **unlinked rows** (`staff_id=NULL`, `source_email=<email>`,
  `unlinked=true`) so the admin UI can surface them for manual fix —
  the operator either provisions the missing staff record (next sync
  resolves them) or deletes the unlinked row.
- New `team_external_ids` table mirrors `staff_external_ids`: stable
  Google Group ID → team.id mapping, survives renames.
- `team_members` evolved: `staff_id` nullable, new
  `source_email` / `unlinked` / `source` columns, partial unique
  indexes for linked vs unlinked rows, CHECK constraint that an
  unlinked row must have a `source_email`.
- "Managed set" deletion: sync only removes rows where
  `source='google_groups_sync'`. Manually-added members
  (`source='manual'`) are preserved unconditionally.
- New env vars: `GOOGLE_GROUPS_DOMAIN`,
  `GOOGLE_GROUPS_DELAY_BETWEEN_GROUPS_MS`. SA + impersonation user
  reused from the Directory sync.
- Cloud Scheduler: new `sync-google_groups-dev` job, daily 06:30 ET
  (30 min after Directory) — added via the existing `sync_schedules`
  Terraform map, no new resource files.
- README + docs/DATA-SYNC.md updated with the full pipeline,
  schema, env vars, and DWD scope requirements.
- One out-of-band IT action required before the sync produces real
  data: Workspace admin must add `admin.directory.group.readonly` +
  `admin.directory.group.member.readonly` scopes to the existing DWD
  client (piggy-backing the contacts workstream — no separate IT ask).

### Drive sync infra (2026-04-29)

- New `terraform/drive_poll.tf` adds the GCP-side wiring for the Drive
  incremental-poll feature:
  - `google_cloud_scheduler_job.drive_poll`: daily POST to
    `/integrations/google-drive/poll` (default 07:00 America/New_York,
    one hour after the Directory sync). Schedule + paused state are
    `lifecycle.ignore_changes` because gub-admin owns the runtime
    cadence via the Cloud Scheduler API (Pattern A).
  - `google_service_account_iam_member.runtime_can_impersonate_drive_sa`:
    runtime SA gets `roles/iam.serviceAccountTokenCreator` on
    `gdrive-scanner@`. This is the IAM piece that makes Path B's STS
    impersonation chain work.
  - `google_project_iam_custom_role.gub_admin_drive_scheduler_editor`:
    narrow custom role with just `cloudscheduler.jobs.{get,list,update}`.
    Predefined roles were too broad; this is the minimum to drive the
    cadence editor in PR 3.
  - `google_project_iam_member.gub_admin_drive_scheduler_grant`: grants
    the custom role to the gub-admin runtime SA.
- Replaced placeholder `gub-drive-sync@` with the actual SA name
  `gdrive-scanner@os-test-491819.iam.gserviceaccount.com` across docs
  and `.env.example`.
- Workspace-admin actions (DWD grant, bot user provisioning, sharing
  the bot on each restricted Drive) remain out-of-band — no Terraform
  surface.

### Drive auth (2026-04-29)

- **STS impersonation chain** for Drive API auth (Path B in
  `drive.client.ts`), selected when `GOOGLE_DRIVE_TARGET_SA` is set.
  Cloud Run runtime SA → impersonates dedicated `gdrive-scanner@` SA via
  `iamcredentials.signJwt` → bot user `@anomaly.com` via DWD. No key
  file. Workaround for Anomaly's restricted Drives that only accept
  `@anomaly.com` accounts as members.
- Legacy key-file path (Path A) retained as fallback for environments
  that haven't been through the IT setup. Selected when
  `GOOGLE_DRIVE_TARGET_SA` is unset; preserves current dev behavior.
- **Egress filter** — `assertSubjectAllowed()` checks the impersonation
  subject against the boot-time configured `GOOGLE_DRIVE_IMPERSONATE_EMAIL`
  on every auth-build. Refuses to widen impersonation scope to any other
  user. Defense in depth against future code paths that might take a
  subject from elsewhere; not absolute prevention against runtime RCE.
- New env var `GOOGLE_DRIVE_TARGET_SA`. Documented in README ("Drive API
  auth — STS impersonation chain") and `docs/DATA-SYNC.md` ("Drive API
  authentication") with the full GCP + Workspace setup checklist.

### Drive sync (2026-04-29)

- Replaced full-folder-scan trigger with **incremental polling** via
  Drive's `changes.list` API. New `POST /integrations/google-drive/poll`
  endpoint is the Cloud Scheduler target; only kicks off a full sync
  when there are in-scope changes. Cadence is admin-configurable from
  gub-admin (writes the cron expression onto a Cloud Scheduler job;
  reads live state from the job on render).
- New singleton `drive_sync_state` table holding the page token,
  last-polled timestamp, and last-poll outcome. `/run-full-sync`
  augmented to capture and persist a fresh start page token at end of
  successful run, so bootstrap and post-token-expiry recovery share one
  path.
- **Chunking** for the bootstrap path: 50-min wall-clock budget per
  chunk, persisted checkpoints on `sync_runs` (`chunk_phase` /
  `chunk_index`), HTTP self-call to `/run-full-sync/continue` to resume
  in a fresh Cloud Run request. Sized for this org's actual scale
  (per-project ceiling ~100 files; pathological multi-project batch
  ~1k files).
- **Stale-sync reaper** runs at request entry of `/poll`,
  `/run-full-sync`, `/run-full-sync/continue`. Detects rows stuck in
  `running` (>24h since `updated_at`) or `paused` (>60min since
  `updated_at`) — typically caused by Cloud Run instance death between
  checkpoint persist and self-call dispatch — and force-fails them so
  subsequent syncs aren't blocked by the concurrency guard. New
  `sync_runs.updated_at` heartbeat column powers the detection (DB
  trigger + Prisma `@updatedAt`).
- README and `docs/DATA-SYNC.md` updated with full operational details
  (bootstrap, token expiry, chunking math, reaper thresholds).

### Security (2026-04-23)

- Added a `gitleaks` pre-commit hook (`.githooks/pre-commit`) that scans
  staged changes before every commit and rejects the commit on any
  finding. One-time setup per clone is documented in the README
  ("Local setup").
- Tightened `.gitignore` coverage to block additional secret-file shapes
  from slipping through (additional `.env.*` variants, typical key/cert
  file extensions).
- Refreshed `.env.example` so it enumerates every configuration key the
  backend reads today — new devs have a single authoritative reference
  and no reason to copy from a colleague's local file.
- Added `BACKLOG.md` to track infrastructure follow-ups queued for the
  next relevant deploy.
