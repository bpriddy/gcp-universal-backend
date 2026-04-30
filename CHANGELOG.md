# Changelog

All notable changes to this repository are tracked here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Security entries
describe what controls were added; operational detail that could narrow
an attacker's search space (which values lived where, timing of rotations,
remaining exposures) lives in internal notes instead of this public log.

## [Unreleased]

### CORS allow-list — DB-backed, admin-controllable (2026-04-30)

Reviewer feedback: requiring a redeploy per origin registration was too
much friction for dev iteration. Moved the source of truth from the
cloudbuild substitution to a DB table that gub-admin can edit at
runtime.

- New `cors_allowed_origins` table (`id`, `origin`, `label`, `is_active`,
  `added_by` → `staff.id`, `created_at`, `updated_at`). Migration
  20260430010000 seeds it from the values that previously lived in
  `cloudbuild/dev.yaml`'s `_CORS_ALLOWED_ORIGINS` substitution.
- `originAllowList` middleware now queries the DB on each request
  (single-row index lookup; no caching today). Same friendly 403 body
  as before, but with updated `fix` guidance pointing at the gub-admin
  Settings UI rather than cloudbuild.
- DB lookup failure returns 503 with `CORS_LOOKUP_UNAVAILABLE`. DB-
  dependent endpoints would be failing anyway in this scenario, so the
  fail-closed posture isn't a meaningful availability regression — and
  silently allowing all origins on DB error would be worse.
- `cloudbuild/dev.yaml` — removed `_CORS_ALLOWED_ORIGINS` substitution
  and the corresponding `--set-env-vars` entry. The env var schema in
  `src/config/env.ts` keeps `CORS_ALLOWED_ORIGINS` as deprecated/unread
  so legacy references don't crash boot; future cleanup PR can remove it
  outright.
- README — new "CORS allow-list — dev/staging tooling" section
  documenting the two-layer architecture (app-layer middleware now;
  prod edge CORS later) and the contract for the future
  prod-deploy-promotes-DB-list-to-edge build step.

This is dev/staging tooling only. Production CORS would be edge-level
(WAF / Cloud Armor / load balancer); the middleware in prod would stay
mounted as defense-in-depth, not as the primary boundary. **No
production environment, prod deploy pipeline, or CI/CD strategy has
been planned in detail yet** — anything in the README or docs labeled
"prod" is forward-looking design intent rather than current state.
Status callouts have been added to README's CORS section, README's
top-level POC banner, and `docs/PRODUCTION-CHECKLIST.md` to make this
unambiguous.

### CORS rejection — informative 403 instead of opaque preflight block (2026-04-30)

Implementer feedback: a fresh consuming-app origin not in the allow-list
got an opaque "blocked by CORS policy" browser error. The dev had no way
to know which step they'd missed. The strict allow-list itself is fine —
the failure mode wasn't.

- `src/config/cors.ts`: CORS layer now reflects any origin (origin: true)
  with credentials. The cors lib stops being the gatekeeper.
- `src/middleware/originAllowList.ts` (new): mounted after the CORS
  middleware. Strict equality match against `CORS_ALLOWED_ORIGINS` — no
  wildcards. On a non-allow-listed origin, returns a structured 403 with
  the rejected origin, the file/key to edit (`cloudbuild/<env>.yaml` →
  `_CORS_ALLOWED_ORIGINS`), and the action to take. The browser CAN read
  this body because CORS already attached the Access-Control-Allow-Origin
  header.
- Bypass list for public-by-design endpoints: `/.well-known/jwks.json`,
  `/.well-known/oauth-authorization-server`, `/health`, `/health/live`.
  Reachable from any origin so SDK verifiers + load balancers aren't
  blocked.
- `cloudbuild/dev.yaml` — added the implementer's current Replit dev URL
  to the explicit allow-list (immediate unblock). The list grows
  per-consumer; the friendly 403 makes that obvious from the browser
  console.

Trade-off this design picks: keep the allow-list as a real check (no
wildcard widening), accept the per-new-origin redeploy as the cost of an
explicit registration step, and make the failure mode helpful enough
that devs don't bounce off it.

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
