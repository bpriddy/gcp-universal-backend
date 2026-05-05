# Changelog

All notable changes to this repository are tracked here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Security entries
describe what controls were added; operational detail that could narrow
an attacker's search space (which values lived where, timing of rotations,
remaining exposures) lives in internal notes instead of this public log.

## [Unreleased]

### SDK error handling — typed exchange errors + classified middleware errors (2026-05-04)

Surfaced during a debugging session with the work-flows implementer:
the SDK was flattening rich error responses from GUB into bare
`Error(message)` instances, forcing consumers to string-match error
text. Fixed.

- `sdk/frontend` exports `GUBExchangeError` with `code`, `message`,
  `status`, `details` preserved verbatim from GUB's response.
  Consumers can `instanceof GUBExchangeError` and switch on `err.code`
  to route different failure modes to different UI (admin contact,
  user retry, generic toast).
- `sdk/backend`'s `gub.middleware()` no longer flattens every
  verification failure to `INVALID_TOKEN`. New `classifyVerifyError`
  maps `jose`'s typed errors to specific codes:
  `TOKEN_EXPIRED` / `CLAIM_INVALID` / `SIGNATURE_INVALID` /
  `KEY_NOT_FOUND` / `JWKS_FETCH_TIMEOUT` / `TOKEN_MALFORMED` /
  `JOSE_<code>` / `INVALID_TOKEN` (catch-all for backward compat).
- `sdk/USAGE.md` — new "Quick start: 5 steps" section near the top
  documents the operational onboarding (register trusted_apps → set
  env vars → pick appId → wire SDK → test login) in order, plus a
  middleware-error-codes table and a typed-error handling example.
  Explicit guidance to keep `gub.config.ts` in shared code so
  frontend/backend can't drift on the appId literal.

### App-level access gating removed root-and-stem (2026-05-04)

Centralizing per-user, per-app authorization at the IdP layer was an
anti-pattern. It duplicated what the JWT audience claim already does
cryptographically, centralized decisions that belong at each consuming
app, and the `autoAccess=true` escape hatch was already a tell. After
discussion, removed the entire surface.

- Migration 20260504000000 drops `user_app_permissions`,
  `app_access_requests`, and the `auto_access` + `is_active` columns
  from `apps`. The `apps` table itself is preserved as a thin
  appId → friendly-name registry.
- `checkOrProvisionAppAccess`, `pending_approval` branch, and
  `PendingApprovalResponse` removed from auth flow. JWT no longer
  carries a `permissions[]` claim.
- SDK: `GUBPendingApprovalError` (a hotfix from earlier in the day),
  `requireRole` middleware, `appPermission` field on
  `GUBRequestContext`, and `permissions[]` on `GUBUser` all removed.
- gub-admin: `/apps` page + `/api/apps`, `/app-access-requests` page
  + `/api/app-access-requests` removed. Nav cleaned up. The
  `/users/[id]` detail page no longer tries to render permissions.
- Pre-existing JWT audience bug fixed as part of this work:
  `signAccessToken` now accepts `{ appId }` and signs with
  `aud = [appId, JWT_AUDIENCE]` (multi-audience). Without this fix,
  the SDK config simplification's `aud === appId` verifier check
  was unreachable — GUB always signed with `JWT_AUDIENCE` only.
- New decision doc at `docs/proposals/remove-app-access-gating.md`
  with the architectural reasoning. Implementer-facing migration
  notice at `docs/proposals/implementer-heads-up-2026-05-04.md`.

Net change: -341 lines on GUB, -710 lines on gub-admin.

### Trusted apps registry (2026-04-30)

Consolidates the previous CORS allow-list and the previous Google
audience allow-list into a single registry, with strict same-row
pairing of origin and Google client_id. A fork or derivative
environment cannot inherit a parent app's trust at any layer.

- Migration 20260430040000 creates `trusted_apps` (`id`, `name`,
  `origins TEXT[]`, `google_client_ids TEXT[]`, `is_active`,
  `added_by`, `created_at`, `updated_at`) with GIN indexes on
  the array columns. Folds existing `cors_allowed_origins` rows
  into the new shape and drops the legacy table.
- `originAllowList` middleware now reads `trusted_apps.origins[]`
  for the coarse CORS gate. `verifyGoogleToken` reads
  `trusted_apps.google_client_ids[]` for the cryptographic audience
  check, then enforces strict same-row pairing on the verified
  audience + the request's `Origin` header.
- `ensureSelfTrustedApp` boot-time idempotent seed inserts a
  "GUB itself" row holding the env `GOOGLE_CLIENT_ID` so the OAuth
  broker's self-issued tokens still verify after migration. Also
  normalizes whitespace in array values defensively (catches a
  Secret Manager trailing-newline bug we hit during deploy).
- `verifyGoogleToken` returns structured error codes:
  `AUDIENCE_NOT_REGISTERED`, `AUDIENCE_ORIGIN_MISMATCH`,
  `AUDIENCES_REGISTRY_EMPTY`, `EMAIL_NOT_VERIFIED`,
  `INVALID_GOOGLE_TOKEN`. `errorHandler` returns 403 (operator
  action required) for the registration-related codes; 401 for
  recoverable token failures.
- gub-admin → Settings → Trusted apps surfaces CRUD. Old
  `/settings/cors-origins` redirects in. Audit log gets every add /
  edit / deactivate / delete via `requireActor`.

### SDK configuration simplification — `defineGUBConfig` helper (2026-04-30)

Implementer-side env-var sprawl was an anti-pattern. Six env vars,
three of them carrying the same string, audience and issuer that
should come from a discovery doc. Collapsed.

- New `sdk/config.ts` exports `defineGUBConfig({ url, googleClientId, appId })`.
  Validates input synchronously, lazily fetches and validates
  `${url}/.well-known/oauth-authorization-server`, exposes typed
  accessors for `issuer`, `jwksUri`, etc.
- Both `sdk/backend/createGUBClient` and `sdk/frontend/<GUBProvider>`
  consume the same `GUBConfig` object. Implementers declare config
  once in a shared file.
- `appId` becomes a code constant instead of an env var (identity,
  not config). Audience verification on the consumer side pins to
  `aud === gub.appId`, decided per security team.
- Discovery-doc fetch enforces `discovery.issuer === url` (single
  trust anchor; loud failure on typo). HTTPS-only except loopback.
  In-memory cache only (per security review — tampered on-disk cache
  would become the trust anchor).
- Backward-compat: legacy `{ gubUrl, issuer, audience }` and
  `{ gubUrl, googleClientId }` shapes still accepted with one-time
  `console.warn` at construction. Will be removed in a future major.
- Decision doc at `docs/proposals/sdk-config-simplification.md` with
  the security review's responses to the original 6 asks.

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
