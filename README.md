# gcp-universal-backend

A universal auth gateway for GCP-hosted applications. Accepts a Google OAuth token from the frontend, validates the user against a PostgreSQL users table, and issues RS256-signed JWTs that carry per-application permissions. Downstream apps verify tokens independently using the public JWKS endpoint — no callback to this service required.

> **POC Status:** This system is a working proof of concept that demonstrates
> end-to-end functionality across three repos. See the [docs/](./docs/) folder
> for comprehensive documentation intended for vendor onboarding.
>
> **No production environment, deploy pipeline, or CI/CD strategy has
> been planned in detail yet.** Anything in this README labeled "prod",
> "production", or referring to a future deploy pipeline is forward-
> looking design intent, not a description of current state. The dev
> environment described here is the entire system that exists today.

## Documentation

| Document | Description |
|----------|-------------|
| [Architecture Overview](./docs/ARCHITECTURE.md) | System map, three repos, data model, GCP resources |
| [Authentication Flow](./docs/AUTH-FLOW.md) | All auth paths: browser, Agentspace/ADK, OAuth broker |
| [Deployment Guide](./docs/DEPLOYMENT.md) | Step-by-step GCP setup with validated commands |
| [Agentspace Integration](./docs/AGENTSPACE-INTEGRATION.md) | ADK agent → Discovery Engine → Agentspace |
| [Data Sync](./docs/DATA-SYNC.md) | Google Directory sync, sync runs, change log diffs |
| [Known Issues](./docs/KNOWN-ISSUES.md) | Platform bugs, workarounds, cleanup items |
| [Production Checklist](./docs/PRODUCTION-CHECKLIST.md) | What a vendor needs to harden for production |
| [Commands Reference](./docs/COMMANDS-REFERENCE.md) | Copy-paste validated commands for all operations |

### Related Repositories

| Repo | Purpose |
|------|---------|
| [gub-agent](https://github.com/bpriddy/gub-agent) | ADK agent for Vertex AI Agent Engine / Agentspace |
| [gub-admin](https://github.com/bpriddy/gub-admin) | Next.js admin CMS for data management |

### Current Dev URLs

| Service | URL |
|---------|-----|
| GUB Backend | `https://gcp-universal-backend-dev-843516467880.us-central1.run.app` |
| GUB Admin CMS | `https://gub-admin-dev-843516467880.us-central1.run.app` |
| OAuth Relay | `https://us-central1-os-test-491819.cloudfunctions.net/oauth-relay` |
| JWKS | `https://gcp-universal-backend-dev-843516467880.us-central1.run.app/.well-known/jwks.json` |

---

## Using this in your app (start here)

This repo doubles as an installable SDK. One command gives any frontend or backend access to auth and org data.

### Install

```bash
# React frontend
npm install github:bpriddy/gcp-universal-backend @react-oauth/google

# Node backend (Express, Fastify, raw http, etc.)
npm install github:bpriddy/gcp-universal-backend jose
```

### Frontend (React)

```tsx
import { GUBProvider, useGUB } from 'gcp-universal-backend/frontend'

// 1. Wrap your app
export default function App() {
  return (
    <GUBProvider config={{
      gubUrl: 'https://gub.yourdomain.com',
      googleClientId: 'your-client-id.apps.googleusercontent.com',
      appId: 'your-app-id',
    }}>
      <YourApp />
    </GUBProvider>
  )
}

// 2. Use anywhere inside the provider
function Dashboard() {
  const { isAuthenticated, login, logout, user, fetch } = useGUB()

  if (!isAuthenticated) return <button onClick={login}>Sign in with Google</button>

  return <button onClick={logout}>Sign out ({user.email})</button>
}
```

### Backend (Node)

```ts
import { createGUBClient } from 'gcp-universal-backend/backend'

const gub = createGUBClient({
  gubUrl: process.env.GUB_URL,
  issuer: process.env.GUB_ISSUER,
  audience: process.env.GUB_AUDIENCE,
})

// Protect routes
app.use(gub.middleware())
app.get('/reports',   gub.requireRole('viewer'),      handler)
app.post('/campaigns', gub.requireRole('contributor'), handler)

// Access user in a handler
app.get('/me', gub.middleware(), (req, res) => {
  res.json({ email: req.gub.user.email })
})

// Fetch org data server-to-server. Pass the user's access token so the
// backend scopes results to their access_grants.
const org = gub.org(accessToken)
const [accounts, campaigns, offices, teams, staff] = await Promise.all([
  org.listAccounts(),
  org.listCampaigns({ status: 'active' }),     // every campaign the user can see
  org.listOffices({ activeOnly: true }),       // gated by office_* grants
  org.listTeams({ activeOnly: true }),         // gated by team_* grants
  org.listStaff(),                             // gated by staff_* grants
])
```

### Full usage guide

See [`sdk/USAGE.md`](./sdk/USAGE.md) for complete examples including:
- Environment variables reference
- Fastify and raw Node patterns
- TypeScript type declarations
- Role reference table
- Architecture diagram

> **Vibe coding / AI assistants:** Tell your AI — *"Install the GUB SDK with `npm install github:bpriddy/gcp-universal-backend` and read `sdk/USAGE.md` for implementation instructions."*

---

## How it works

```
Frontend
  │
  ├─ POST /auth/google { idToken }
  │     Verify token with Google → look up user in DB → check permissions
  │     Return: { accessToken (JWT), refreshToken (opaque), user }
  │
  ├─ Authorization: Bearer <accessToken>  (all subsequent requests)
  │     Verify RS256 signature → check app permission → attach DB pool
  │
  └─ POST /auth/refresh { refreshToken }
        Rotate token → issue new access + refresh tokens
        Reuse of a rotated token → entire session family revoked (theft detection)
```

The JWT payload includes the user's application permissions so downstream services can authorize without a database round-trip:

```json
{
  "sub": "user-uuid",
  "email": "user@example.com",
  "permissions": [
    { "appId": "analytics", "dbIdentifier": "analytics", "role": "editor" }
  ],
  "iss": "https://auth.yourcompany.com",
  "exp": 1234567890
}
```

---

## Project structure

```
gcp-universal-backend/
├── sdk/                              # ← Installable SDK (npm install github:bpriddy/gcp-universal-backend)
│   ├── frontend/
│   │   └── index.tsx                 # React: GUBProvider, useGUB(), GUBLoginButton
│   ├── backend/
│   │   └── index.ts                  # Node: createGUBClient(), middleware, orgClient
│   └── USAGE.md                      # Full usage guide (written for AI assistants)
├── src/                              # GUB server — deploy this to GCP
│   ├── app.ts                        # Express app factory
│   ├── server.ts                     # Entry point + graceful shutdown
│   ├── config/
│   │   ├── env.ts                    # Zod-validated environment config (fail-fast)
│   │   ├── database.ts               # Prisma auth DB + per-app pg.Pool registry
│   │   └── cors.ts                   # Origin whitelist
│   ├── middleware/
│   │   ├── authenticate.ts           # JWT Bearer verification + requireAppAccess()
│   │   ├── rateLimiter.ts            # General + auth-specific rate limits
│   │   ├── validate.ts               # Zod request body validator factory
│   │   └── errorHandler.ts           # Centralized error → HTTP response mapping
│   ├── modules/
│   │   ├── ai/                       # Gemini driver + prompt_presets runner
│   │   ├── auth/                     # Login, refresh, logout, JWKS endpoints
│   │   ├── health/                   # /health (readiness) + /health/live (liveness)
│   │   ├── integrations/
│   │   │   ├── google-directory/     # Google Workspace directory sync engine
│   │   │   ├── google-drive/         # Drive LLM extraction + review workflow
│   │   │   ├── sync-run.service.ts   # Shared sync run logging + stale-run sweeper
│   │   │   └── sync-runs.router.ts   # Sync run API endpoints
│   │   ├── mail/                     # Mail driver (console | Mailgun)
│   │   ├── mcp/                      # MCP server for AI agent tools
│   │   ├── org/                      # Staff, accounts, campaigns, offices, teams, users, access grants
│   │   ├── staff-classifier/         # LLM-backed is-this-a-person decision (source-agnostic)
│   │   └── workspace/                # X-Workspace-Token pass-through + SA fallback
│   ├── services/
│   │   ├── google.service.ts         # Google ID token verification
│   │   ├── jwt.service.ts            # RS256 sign/verify + JWKS export
│   │   ├── token.service.ts          # Refresh token lifecycle + reuse detection
│   │   └── user.service.ts           # User lookup + JIT provisioning
│   └── types/                        # Express augmentation, JWT payload types
├── prisma/
│   ├── schema.prisma                 # Full org schema — users, staff, accounts, campaigns
│   └── migrations/
├── cloudbuild/                       # CI/CD pipelines — dev, staging, prod
├── scripts/
│   ├── generate-keys.sh              # Generate RS256 key pair for local dev
│   └── setup-gcp.sh                  # One-time GCP resource provisioning
├── frontend/                         # Reference React frontend
├── Dockerfile                        # Multi-stage, non-root, healthcheck
└── .env.example
```

---

## Database schema

Three tables in the auth PostgreSQL database:

| Table | Purpose |
|---|---|
| `users` | Google-authenticated users (`google_sub` is the stable identifier) |
| `user_app_permissions` | Maps a user → `appId` + `dbIdentifier` + `role` |
| `refresh_tokens` | Hashed refresh tokens with rotation family tracking |

Application databases (defined in `APP_DB_CONNECTIONS`) are separate PostgreSQL instances owned by each downstream app. This service holds connection pools for them but does not manage their schemas.

---

## Security model

| Concern | Approach |
|---|---|
| Token signing | RS256 (asymmetric) — private key never leaves this service |
| Token verification | Downstream services use the JWKS endpoint (`GET /auth/jwks`) |
| Refresh token storage | Only SHA-256 hash stored in DB — raw token transmitted once over HTTPS |
| Refresh token rotation | Every use issues a new token; presenting a rotated token revokes the entire family |
| Access token TTL | 15 minutes — short enough to limit exposure without a revocation list |
| Rate limiting | 10 req/15 min on auth endpoints, 100 req/15 min globally |
| Input validation | Zod schemas on all request bodies and environment variables |
| Secret management | RS256 keys injected via GCP Secret Manager (file path or base64 env var) |

---

## API endpoints

### Auth

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/auth/google` | — | Exchange Google ID token for JWT + refresh token |
| `POST` | `/auth/refresh` | — | Rotate refresh token, get new token pair |
| `POST` | `/auth/logout` | — | Revoke current session (this device) |
| `POST` | `/auth/logout-all` | Bearer | Revoke all sessions (all devices) |
| `GET` | `/auth/jwks` | — | RS256 public key in JWKS format |

### Org data

All org routes require a valid Bearer JWT.

| Method | Path | Description |
|---|---|---|
| `GET` | `/org/accounts` | List all accounts with resolved current state |
| `GET` | `/org/accounts/:id` | Fetch a single account |
| `GET` | `/org/accounts/:id/campaigns` | List campaigns under a specific account. Requires **account** access grant in addition to campaign grants. Use when the caller is navigating account→campaign. |
| `GET` | `/org/campaigns` | List every campaign the caller can see. Gated only on **campaign** grants — a user with a direct campaign grant but no parent-account grant is visible here. (`?status=<s>` optional filter) |
| `GET` | `/org/campaigns/:id` | Fetch a single campaign |
| `GET` | `/org/offices` | List offices (gated by `office_all` / `office_active` / `office` grants; zero grants → empty) |
| `GET` | `/org/offices/:id` | Fetch a single office (same gate) |
| `GET` | `/org/teams` | List teams with members (gated by `team_all` / `team_active` / `team` grants) |
| `GET` | `/org/teams/:id` | Fetch a single team with members (same gate) |
| `GET` | `/org/users` | Admin-only list of GUB user identities (`?activeOnly=true` optional) |
| `GET` | `/org/users/:id` | Admin or self: fetch user identity |
| `GET` | `/org/staff` | List active staff (`?all=true` includes former) |
| `GET` | `/org/staff/:id` | Fetch a single staff member |

### Health

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Readiness probe — checks DB connectivity |
| `GET` | `/health/live` | Liveness probe — no dependencies |
| `GET` | `/.well-known/jwks.json` | RS256 public key — standard JWKS discovery URL |

### Protected routes (example pattern)

```ts
import { authenticate, requireAppAccess } from './middleware/authenticate';

router.get('/data', authenticate, requireAppAccess('analytics'), (req, res) => {
  // req.appDbPool  → pg.Pool for the analytics database
  // req.user       → verified JWT payload with permissions
});
```

---

## Getting started

### Prerequisites

- Node.js 20+
- PostgreSQL 14+ (local or via Docker)
- A Google Cloud project with an OAuth 2.0 Client ID

### 1. Clone and install

```bash
git clone https://github.com/bpriddy/gcp-universal-backend.git
cd gcp-universal-backend
npm install

# Wire the secret-scan pre-commit hook (required — refuses commit on
# detected API keys, tokens, JSON keys, etc.)
brew install gitleaks        # or see https://github.com/gitleaks/gitleaks#installation
git config core.hooksPath .githooks
```

### 2. Start PostgreSQL

```bash
docker run -d \
  --name gcp-auth-db \
  -e POSTGRES_USER=user \
  -e POSTGRES_PASSWORD=password \
  -e POSTGRES_DB=gcp_auth \
  -p 5432:5432 \
  postgres:16-alpine
```

### 3. Configure environment

```bash
cp .env.example .env
```

Minimum required values:

```env
DATABASE_URL=postgresql://user:password@localhost:5432/gcp_auth
APP_DB_CONNECTIONS={"analytics":"postgresql://user:password@localhost:5432/analytics_db"}
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
JWT_PRIVATE_KEY_PATH=./keys/private.pem
JWT_PUBLIC_KEY_PATH=./keys/public.pem
CORS_ALLOWED_ORIGINS=http://localhost:5173
```

### 4. Generate RS256 keys

```bash
npm run keys:generate
```

### 5. Run migrations

```bash
npm run db:migrate:dev
```

### 6. Start the server

```bash
npm run dev       # ts-node, hot-reload
npm run build && npm start   # compiled
```

Server starts on `http://localhost:3000`.

---

## Frontend example

A reference React + Vite frontend lives in `frontend/`. It demonstrates the complete auth flow:

- Google Sign-In button (Google Identity Services)
- Sending the ID token to `/auth/google`
- Access token stored **in memory only**; refresh token in `localStorage`
- Proactive token refresh 60 seconds before expiry
- Concurrent refresh de-duplication (single in-flight refresh shared across callers)
- Auto-retry on 401 with one refresh attempt
- Silent session restore on page load
- Per-application data fetch showing `200 OK` vs `403 FORBIDDEN`

```bash
cd frontend
cp .env.example .env    # set VITE_GOOGLE_CLIENT_ID
npm install
npm run dev             # http://localhost:5173 — proxies /auth and /api to :3000
```

---

## Adding a user permission

New users are JIT-provisioned on first login with zero permissions. Grant access via direct SQL or a future admin API:

```sql
INSERT INTO user_app_permissions (user_id, app_id, db_identifier, role)
VALUES (
  (SELECT id FROM users WHERE email = 'user@example.com'),
  'analytics',      -- appId the frontend passes
  'analytics',      -- key in APP_DB_CONNECTIONS
  'editor'
);
```

---

## Drive sync — incremental polling

The Drive sync uses **incremental polling** via Drive's `changes.list` API.
Cadence is admin-configurable in gub-admin under Data Sources → Google Drive,
which writes the cron expression onto a Cloud Scheduler job (the cron is
the source of truth — gub-admin reads live from the Scheduler on render).

### Endpoints

| Endpoint | Purpose |
|---|---|
| `POST /integrations/google-drive/poll` | Cloud Scheduler target. Calls `changes.list` with the saved page token; only kicks off a full sync when there are in-scope changes. 200/202/503 depending on outcome. |
| `POST /integrations/google-drive/run-full-sync` | Admin "Run sync now" + bootstrap path. Full discover + scan; on success persists a fresh start page token. 202 + syncRunId. |
| `POST /integrations/google-drive/run-full-sync/continue` | Self-call from the runner when a sync hits its chunk budget. Body: `{ syncRunId }`. |
| `POST /integrations/google-drive/notify` | On-demand reviewer email fan-out for pending+unnotified proposals. |
| `POST /integrations/google-drive/sweep-expired` | Cron target. Flips expired pending proposals to `state='expired'`. |

### State

Single-row `drive_sync_state` table:

| Column | Meaning |
|---|---|
| `page_token` | The opaque Drive token to pass on the next `changes.list` call. NULL = bootstrap required. |
| `last_polled_at` | Timestamp of the last poll attempt (any outcome). |
| `last_outcome` | `no_changes` \| `changes_dispatched` \| `changes_pending_existing_run` \| `bootstrap_required` \| `errored`. |
| `last_full_sync_run_id` | The most recent `sync_runs.id` that successfully completed a full sync (and thus refreshed `page_token`). |

### Bootstrap

Initial state ships with `page_token = NULL`, so the first poll returns
`bootstrap_required` (HTTP 503). Recovery — for both fresh installs and
post-token-expiry — is the same:

```bash
curl -X POST https://<gub-url>/integrations/google-drive/run-full-sync
```

`/run-full-sync` does the discover + scan, then captures a fresh start
page token at the end. Subsequent `/poll` calls have somewhere to start.

### Token expiry

Drive expires page tokens after ~7 days of inactivity. If a poll has been
broken for that long, the next call returns 410 / `INVALID_PAGE_TOKEN`.
The handler catches this, clears `page_token`, and surfaces
`bootstrap_required`. Recovery: same as bootstrap above.

### Chunking

A single `/run-full-sync` may take longer than a Cloud Run service
instance's reliable lifetime if many files arrived at once. The runner
enforces a **50-min wall-clock budget per chunk**, checked between
entities. When the budget trips:

1. Persists `chunk_phase` + `chunk_index` to `sync_runs`.
2. Sets `status='paused'`.
3. Self-POSTs to `/run-full-sync/continue` with the `syncRunId`.
4. The continuation runs in a fresh Cloud Run request (fresh ~60-min
   lifecycle, fresh 50-min budget).

**Operational scale this is sized for:** the only realistic large-scan
trigger is a new account or project being added with its existing
folder contents. Per-project folders top out around 100 files. A
**pathological** day — winning a new client with a batch of 10 rush
projects all kicked off at once — is ~1,000 files total across one
account + ten projects. Steady-state polling deltas are sub-minute
work. The 50-min chunk budget + 24h running-state ceiling (see
Recovery, below) cover this with comfortable margin.

**Math.** Per-file extraction averages ~20s (Gemini Flash + inter-file
delay). One chunk processes ~150 files. A typical single-project add
(~100 files) fits in **one chunk, ~33 minutes** — chunking never
trips. The pathological 1,000-file batch case takes **~7 chunks, ~6
hours wall time** — still has 4× margin against the 24h ceiling.

The chunking is mostly insurance against scenarios that won't materialize
at this org's scale. If per-file time turns out to be materially
different from 20s in practice, tune `CHUNK_BUDGET_MS` in
`drive.runner.ts`. Visibility on chunk count + elapsed via the
`sync_runs` table.

### Recovery — stale-sync reaper

The chunking design persists checkpoints between chunks and self-POSTs
to a continuation endpoint. If a Cloud Run instance dies between
checkpoint persist and self-call dispatch — or if the self-call itself
fails for any reason — the `sync_run` is left stuck in `running` or
`paused`, blocking subsequent syncs (the concurrency guard refuses to
start a new run while one is in flight).

A **stale-sync reaper** runs at the entry of `/poll`, `/run-full-sync`,
and `/run-full-sync/continue`. It detects stuck rows by their lack of
recent activity — `sync_runs.updated_at` is bumped on every row update
via a DB trigger and Prisma's `@updatedAt`. When a row's `updated_at`
is older than the threshold for its status, the reaper force-flips it
to `failed`, freeing the slot.

| Status | Threshold | Why |
|---|---|---|
| `paused` | 60 min | Self-call delivery is sub-second. An hour past pause is unambiguously a delivery failure. |
| `running` | 24 hours | Longer than any realistic legitimate sync at this scale (worst case ~6h, see chunking math above). 4× margin. |

**Cadence interaction.** The reaper runs at request entry, not on a
fixed schedule. Recovery time is `threshold + (time until next request)`.
If polling cadence is hourly and a `running` row hits 24h at 11:30, the
12:00 `/poll` reaps it. If polling is daily, recovery latency can be up
to 24h after the threshold. Pick polling cadence with this in mind.

**Why heartbeat, not start-time.** Using `started_at` would falsely reap
a legitimately-progressing 23.5h sync that pauses at hour 24. The
heartbeat (`updated_at`) bumps on every checkpoint persist and every
row update, so genuinely-stuck rows trip the threshold but actively-
progressing ones don't.

The reaper is idempotent (no-op when nothing matches) and transient-DB-
error-tolerant (logs and returns; does not fail the request that
triggered it).

### Drive API auth — STS impersonation chain

The Drive client (`drive.client.ts`) supports two auth paths and selects
between them at boot based on which env vars are set.

**Path A — legacy key-file (fallback for environments without Workspace
DWD set up).** A service account JSON key is mounted via Secret Manager.
Drive folders are shared directly with the SA's email. Optional DWD via
`GOOGLE_DRIVE_IMPERSONATE_EMAIL`. Selected when `GOOGLE_DRIVE_TARGET_SA`
is unset.

**Path B — STS impersonation chain (production posture).** Selected when
`GOOGLE_DRIVE_TARGET_SA` is set. The chain:

```
Cloud Run runtime SA  (via ADC — no key file)
  ↓ runtime SA has roles/iam.serviceAccountTokenCreator on the next hop
gdrive-scanner@os-test-491819.iam.gserviceaccount.com  (the dedicated Drive SA)
  ↓ Workspace admin granted DWD (scope drive.readonly) to this SA only
bot@anomaly.com  (the @anomaly.com proxy / bot user)
  ↓ shared by IT on each restricted Drive
[Client drive] [Internal drive] [...]
```

The token-mint flow:

1. Drive client uses ADC (runtime SA's ambient identity).
2. Calls `iamcredentials.signJwt` to sign a JWT *as*
   `GOOGLE_DRIVE_TARGET_SA`. The JWT carries `sub=GOOGLE_DRIVE_IMPERSONATE_EMAIL`.
3. Exchanges the signed JWT at `oauth2.googleapis.com/token` for an
   access token. The token represents the bot user, scoped to `drive.readonly`.
4. Caches the token until ~5 min before its 1-hour expiry.

**Why this design.** Anomaly's restricted shared drives only allow
`@anomaly.com` accounts to be added. A service account email can't be
added directly. The bot user is the workaround: a real Workspace user
that IT shares on each restricted Drive; the SA impersonates that user
via DWD. The dedicated `gdrive-scanner@` SA isolates DWD from the
runtime SA so revocation is surgical (one IAM grant flip kills Drive
access without touching the rest of the service).

**Egress filter (defense in depth).** All auth paths route through
`assertSubjectAllowed()` which checks the impersonation subject against
the boot-time configured `GOOGLE_DRIVE_IMPERSONATE_EMAIL`. The check is
tautological in the normal flow (we always pass the configured value)
— its purpose is to make any future code path that takes a subject from
elsewhere fail loudly rather than silently widen the impersonation
scope. Defends against future refactors, not against an attacker with
runtime code execution.

**Honest scope of the spoof defense.** A sufficiently capable attacker
with runtime code execution on the Cloud Run service can mint tokens
along the same chain (the runtime SA → impersonate the dedicated SA
via STS → call signJwt with any DWD subject). The chain adds an audit-
loggable hop and clean separation/revocation surface but does not
fundamentally prevent the spoof. The real protections at this layer
are: scope is locked to `drive.readonly` (no writes/deletes), the bot
user is only shared on intended drives, and the egress filter catches
intra-app sloppiness.

### Required GCP setup for Path B

| Step | Where | Action |
|---|---|---|
| 1 | GCP IAM | Provision SA `gdrive-scanner@os-test-491819.iam.gserviceaccount.com` |
| 2 | GCP IAM | Grant Cloud Run runtime SA `roles/iam.serviceAccountTokenCreator` on the new SA |
| 3 | Workspace Admin | Grant DWD to the new SA's client ID with scope `https://www.googleapis.com/auth/drive.readonly` |
| 4 | Workspace Admin | Provision the bot user `bot@anomaly.com` (or chosen name) |
| 5 | IT / Drive owners | Share the bot user on each restricted Drive as Viewer |
| 6 | Cloud Run env | Set `GOOGLE_DRIVE_TARGET_SA=gdrive-scanner@...` and `GOOGLE_DRIVE_IMPERSONATE_EMAIL=bot@anomaly.com` |

Steps 1-2 are GCP-side and can be Terraformed. Steps 3-5 are Workspace-
admin actions that don't have a Terraform surface. Step 6 is a
cloudbuild config change.

### Auth (debt — Item 7b)

All admin endpoints (`/poll`, `/run-full-sync`, `/run-full-sync/continue`,
`/cron`, `/notify`, `/sweep-expired`) currently accept any caller. Item 7b
adds OIDC ID-token verification at the gateway, scoped to a whitelist of
caller service-account emails (Cloud Scheduler's SA + gub-admin's runtime
SA). Until 7b lands, exposing GUB to the public internet without an
upstream gate (Cloud IAP / a load balancer ACL) would let arbitrary
callers spend Gemini credits.

---

## CORS allow-list — dev/staging tooling

> **⚠ Status (2026-04-30):** **No production environment, prod deploy
> pipeline, or CI/CD strategy has been planned in detail yet.**
> Everything labeled "prod" or "edge CORS" below is forward-looking
> design intent — describing what *should* happen when the prod
> environment, edge security mechanism, and deploy pipeline are
> eventually built. Today, the dev/staging system described in this
> section is the entire CORS protection that exists. The "two-layer"
> framing is a design contract that captures intent, not current
> implementation. When prod arrives, the choices around edge
> mechanism (Cloud Armor / LB / WAF), promotion flow, and CI/CD
> tooling all get made then — none of it is fixed today.

CORS protection in this system is **two-layer by design**, with each layer
intended for a different operational reality:

| Layer | Where | What it does | When it's the primary boundary |
|---|---|---|---|
| **App-layer middleware** | `src/middleware/originAllowList.ts`, backed by the `cors_allowed_origins` DB table | Reads the runtime-mutable allow-list, returns a structured 403 with actionable guidance for unknown origins | Dev + staging |
| **Edge CORS** | WAF / Cloud Armor / load balancer (NOT YET STOOD UP) | Blocks unknown origins before they reach the app | Production |

In dev/staging today, the app-layer middleware IS the protection. In
production, the edge will be the actual security boundary; the
middleware will stay mounted as defense-in-depth (cheap; redundant).
The two layers don't replace each other — they cover different
operational realities.

### Dev/staging — runtime-mutable allow-list

The `cors_allowed_origins` table is the source of truth. Each row:
`(id, origin, label, isActive, addedBy, createdAt, updatedAt)`. The
`originAllowList` middleware queries on every request that has an
`Origin` header (except public-by-design bypass paths: `/.well-known/*`
and `/health`).

Adding an origin:
1. A dev hits the wall — request blocked, browser console shows a
   structured 403 with the rejected origin.
2. Dev sends the origin to a GUB admin.
3. Admin opens **gub-admin → Settings → CORS allow-list**, pastes the
   origin, gives it a label, saves.
4. Change is live on the next request — no redeploy.

The audit log captures every add/remove via the Item 4 actor pattern.

### Production — edge CORS (planned, not built)

**No prod environment exists today.** The flow described here is forward
planning — written down now so when the prod environment + pipeline get
built, this is a fill-in-the-blanks task rather than a re-derivation:

```
Cloud Build (prod deploy) →
  1. SELECT origin FROM cors_allowed_origins WHERE is_active = true
  2. Transform to the edge CORS format (Cloud Armor policy / LB
     allow-list / whatever edge mechanism is chosen)
  3. Apply edge config update
  4. Continue with Cloud Run revision deploy
```

The middleware stays mounted in prod as defense-in-depth — redundant
once the edge is filtering, but cheap. The edge is the security
boundary; the middleware is the safety net.

**None of the above exists in code or infra today.** No prod project,
no edge mechanism chosen, no build step written. This whole subsection
is a design contract for a future iteration. When prod stands up, the
operator picks the edge mechanism (Cloud Armor / LB ACL / WAF / etc.),
writes the build step, and updates this section to "current state" —
with a Terraform module link or a runbook page replacing this prose.

### Why we don't allow wildcards

`https://*.replit.dev` and similar patterns were considered and
rejected. They turn an explicit-registration check into a near-anyone
check; the security trade-off doesn't carry its weight at the
defense-in-depth layer. The friendly 403 + admin self-service replaces
the original "redeploy per origin" friction without widening the gate.

---

## GCP deployment

### Cloud Run

```bash
# Build and push
docker build -t gcr.io/YOUR_PROJECT/gcp-universal-backend .
docker push gcr.io/YOUR_PROJECT/gcp-universal-backend

# Deploy
gcloud run deploy gcp-universal-backend \
  --image gcr.io/YOUR_PROJECT/gcp-universal-backend \
  --region us-central1 \
  --set-secrets JWT_PRIVATE_KEY_B64=jwt-private-key:latest \
  --set-secrets JWT_PUBLIC_KEY_B64=jwt-public-key:latest \
  --set-secrets DATABASE_URL=auth-db-url:latest \
  --set-secrets APP_DB_CONNECTIONS=app-db-connections:latest \
  --set-env-vars GOOGLE_CLIENT_ID=your-client-id,NODE_ENV=production
```

### Key rotation

See [Secrets & rotation](#secrets--rotation) below for full procedures
across all credentials this service uses.

---

## Environment variables reference

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | Yes | Auth database connection string |
| `APP_DB_CONNECTIONS` | Yes | JSON map of `{ dbIdentifier: connectionString }` |
| `GOOGLE_CLIENT_ID` | Yes | Google OAuth 2.0 Client ID |
| `JWT_PRIVATE_KEY_PATH` | One of | Path to PKCS#8 PEM private key |
| `JWT_PRIVATE_KEY_B64` | One of | Base64-encoded PKCS#8 PEM (for Secret Manager) |
| `JWT_PUBLIC_KEY_PATH` | One of | Path to SPKI PEM public key |
| `JWT_PUBLIC_KEY_B64` | One of | Base64-encoded SPKI PEM (for Secret Manager) |
| `JWT_ISSUER` | No | JWT `iss` claim (default: `https://auth.example.com`) |
| `JWT_AUDIENCE` | No | JWT `aud` claim (default: `https://api.example.com`) |
| `JWT_ACCESS_TOKEN_TTL` | No | Access token lifetime in seconds (default: `900`) |
| `JWT_REFRESH_TOKEN_TTL` | No | Refresh token lifetime in seconds (default: `2592000`) |
| `GOOGLE_ALLOWED_AUDIENCES` | No | Comma-separated list of Google Client IDs GUB will accept on `/auth/google`. `GOOGLE_CLIENT_ID` is always included implicitly. |
| `CORS_ALLOWED_ORIGINS` | No | Comma-separated allowed origins |
| `AUTH_RATE_LIMIT_MAX` | No | Max auth requests per window (default: `10`) |
| `PORT` | No | Server port (default: `3000`) |
| `NODE_ENV` | No | `development` \| `production` \| `test` |
| `GUB_ADMIN_BASE_URL` | No | URL of gub-admin (used for admin-link emails) |
| `GUB_REVIEW_BASE_URL` | No | URL of gub-review (public magic-link service). Falls back to `GUB_ADMIN_BASE_URL` when unset. |
| `GOOGLE_DIRECTORY_SA_KEY_PATH` / `_B64` | One of (for Directory sync) | Service account JSON for the Google Workspace Directory. Path in local dev; base64 via Secret Manager in prod. |
| `GOOGLE_DIRECTORY_IMPERSONATE_EMAIL` | Yes (for Directory sync) | Domain-wide delegation target. |
| `GEMINI_API_KEY` | No | When set, enables real LLM calls (Drive extraction + staff classification). Without it, both fall back to mock drivers — pipelines still run end-to-end in dev. |

---

## Secrets & rotation

Documents secrets/credentials this service uses, where they live, and how
to rotate them. This is **system-specific knowledge** — for the
company-wide incident-response process (escalation, post-mortem, comms),
see IT's canonical incident-response doc.

> **For the IT team:** this section + each consuming repo's matching
> section together form the rotation runbook. Per-repo sections:
> [gub-admin](https://github.com/bpriddy/gub-admin#secrets--rotation),
> [gub-agent](https://github.com/bpriddy/gub-agent#secrets--rotation),
> [gub-review](https://github.com/bpriddy/gub-review#secrets--rotation),
> [work-flows](https://github.com/bpriddy/work-flows#secrets--rotation).

### Inventory

All values live in GCP Secret Manager (project `os-test-491819`) and are
mounted into Cloud Run at deploy time via the `--set-secrets` flag in
`cloudbuild/<env>.yaml`. Naming convention is `<env>-<purpose>` (today
only `dev-` exists; prod will mirror as `prod-`).

| Credential | Where it lives | Issued by | Used for |
|---|---|---|---|
| `DATABASE_URL` | Secret Manager: `dev-database-url` | Self-managed (Cloud SQL) | App's runtime DB connection (gub_app role — DML only, no DDL) |
| `APP_DB_CONNECTIONS` | Secret Manager: `dev-app-db-connections` | Self-managed | JSON map of consuming-app connection strings (see `Database connection registry`) |
| `GOOGLE_CLIENT_ID` | Secret Manager: `dev-google-client-id` | GCP (OAuth 2.0 Client) | Google sign-in audience verification. **Not actually sensitive** — stored in Secret Manager for parity with other config; no client secret is paired with it because GUB only verifies ID tokens, never exchanges OAuth codes. |
| `JWT_PRIVATE_KEY_B64` | Secret Manager: `dev-jwt-private-key-b64` | Self-issued (RS256) | Signs GUB-issued JWTs (access + refresh tokens) |
| `JWT_PUBLIC_KEY_B64` | Secret Manager: `dev-jwt-public-key-b64` (also exposed at `/.well-known/jwks.json`) | Self-issued | Verification by consuming apps (gub-admin, gub-agent, work-flows) |
| `GOOGLE_DIRECTORY_SA_KEY_B64` | Secret Manager: `dev-google-directory-sa-key-b64` | GCP (Workspace SA with domain-wide delegation) | Reads Google Workspace directory for the staff sync engine |
| `GEMINI_API_KEY` | Secret Manager: `dev-gemini-api-key` | GCP (API key) | LLM calls for Drive extraction + staff classification. Falls back to mock driver when unset. |
| Cloud SQL connection | Auto-managed | GCP | Runtime DB access via Cloud SQL Auth Proxy (`--add-cloudsql-instances`) — no static credentials |
| IAP IAM binding (gub-admin) | Terraform: `terraform/gub_admin_iap.tf` (var `admin_emails`) | GCP IAP | Authoritative list of users who can reach gub-admin |

### Rotation procedures

#### `JWT_PRIVATE_KEY_B64` / `JWT_PUBLIC_KEY_B64`

Asymmetric RS256 key pair. Rotation is delicate because consuming apps
verify JWTs against the public key — old tokens must remain verifiable
for the access-token TTL after the new key is signed in.

**Preconditions.** No urgent in-flight deploys. You'll be modifying
Secret Manager versions and triggering a redeploy.

**Steps.**
1. Generate a new key pair locally:
   ```bash
   npm run keys:generate              # writes keys/private.pem + keys/public.pem
   ```
2. Base64-encode each PEM and add a new version to each secret:
   ```bash
   base64 -i keys/private.pem | gcloud secrets versions add dev-jwt-private-key-b64 --data-file=-
   base64 -i keys/public.pem  | gcloud secrets versions add dev-jwt-public-key-b64  --data-file=-
   ```
3. Bump `JWT_KEY_ID` (the `kid` claim) in `cloudbuild/<env>.yaml` so new
   tokens are signed under a new identifier. Commit + push to trigger a
   redeploy.
4. **Hold the old public key in JWKS for one access-token TTL window
   (default 15 min).** GUB serves both old and new public keys at
   `/.well-known/jwks.json` while both versions exist in the secret.
5. After the TTL window, disable the previous version of
   `dev-jwt-public-key-b64`:
   ```bash
   gcloud secrets versions disable <PREV_VERSION> --secret=dev-jwt-public-key-b64
   ```

**Verification.** `curl https://<service>/.well-known/jwks.json` returns
the new public key under the new `kid`. Issue a fresh token via
`/auth/google` and confirm consuming apps verify it (gub-admin /users
loads, work-flows authenticated calls succeed).

**Cleanup.** Disable old versions of both private and public secrets in
Secret Manager (don't destroy — disabled versions are recoverable for 30
days). The keys/private.pem and keys/public.pem files in your local
working tree are gitignored; delete them after upload.

#### `GEMINI_API_KEY`

**Preconditions.** None. Rotation is fast and non-disruptive — without
the key, GUB falls back to the mock LLM driver, which keeps pipelines
running end-to-end (just with empty observations).

**Steps.**
1. Issue a new API key in the GCP console under APIs & Services →
   Credentials, scoped to the Generative Language API.
2. Add a new version to Secret Manager:
   ```bash
   echo -n '<NEW_KEY>' | gcloud secrets versions add dev-gemini-api-key --data-file=-
   ```
3. Trigger a redeploy of `gcp-universal-backend-dev` (push an empty
   commit to `dev`, or re-run the latest Cloud Build trigger). Cloud Run
   resolves `:latest` at deploy time, so a new revision picks up the new
   version.

**Verification.** Run a Drive sync or staff-classifier batch and confirm
non-empty LLM observations in the `sync_runs` table. If results look
mock-like, check the new revision's secret resolution:
```bash
gcloud run revisions describe <REV> --region=us-central1 --format=json | grep gemini
```

**Cleanup.** Disable the previous secret version. Delete the old API key
in the GCP console under APIs & Services → Credentials.

#### `GOOGLE_DIRECTORY_SA_KEY_B64`

Service account JSON key with domain-wide delegation, used for the
Google Workspace Directory sync.

**Preconditions.** Confirm no Directory sync is mid-flight (check
`/data-sources` in gub-admin or query `sync_runs` table for
`status = 'running'`).

**Steps.**
1. In GCP IAM Console → Service Accounts → `<directory-sa>` → Keys, add
   a new JSON key. Download.
2. Base64-encode and upload as new secret version:
   ```bash
   base64 -i ~/Downloads/<key>.json | gcloud secrets versions add dev-google-directory-sa-key-b64 --data-file=-
   rm ~/Downloads/<key>.json   # do this immediately
   ```
3. Trigger a redeploy of `gcp-universal-backend-dev`.

**Verification.** Trigger a manual Directory sync from gub-admin
(`/data-sources/google_directory` → "Sync now"). Confirm the run
completes with `status='ok'` and counters > 0.

**Cleanup.** In GCP IAM Console, disable then delete the old key. Do
**not** disable the SA itself — that would break Drive sync (which falls
back to this SA's credentials).

#### `DATABASE_URL` / `APP_DB_CONNECTIONS`

Postgres connection strings. The runtime app uses `DATABASE_URL` (gub_app
role); migrations use a separate role injected only into the migration
job (`DATABASE_MIGRATOR_URL`, not stored in Secret Manager today — change
that before prod).

**Preconditions.** Confirm Cloud SQL is healthy. If rotating the
password (not just the connection string), have a maintenance window —
in-flight requests using the old password will 500 until the new
revision rolls out.

**Steps.**
1. Rotate the password in Cloud SQL → Users.
2. Build the new connection string and add as a new secret version:
   ```bash
   echo -n 'postgresql://gub_app:<NEW_PW>@<host>:5432/gub?sslmode=require' \
     | gcloud secrets versions add dev-database-url --data-file=-
   ```
3. Trigger a redeploy. Cloud Run does a rolling update by default.

**Verification.** Hit `/health` on the new revision and confirm the DB
check passes. Check Cloud SQL connection logs for new connections from
the new revision.

**Cleanup.** Disable the previous secret version after the new revision
has been serving for 5+ minutes (longer than any reasonable in-flight
request).

#### `GOOGLE_CLIENT_ID`

This is the OAuth 2.0 Client ID. **It is not a secret** in the
cryptographic sense — it ships in every Google sign-in flow's URL — but
it's stored in Secret Manager for config parity. There's no paired
`GOOGLE_CLIENT_SECRET` because GUB only verifies ID tokens; it never
performs an OAuth code exchange (consuming apps like work-flows handle
that side of OAuth).

To rotate (e.g., abandoning a compromised client and issuing a new one
under the same Workspace project):

**Steps.**
1. Create a new OAuth 2.0 Client ID in GCP Console → APIs & Services →
   Credentials. Whitelist the same redirect URIs as the old one.
2. Add it as a new version of `dev-google-client-id`. Trigger redeploy.
3. Update consuming apps to also accept the new client ID via their own
   `GOOGLE_ALLOWED_AUDIENCES` (or equivalent) — see each consuming repo's
   Secrets & rotation section.
4. Once consuming apps are caught up, delete the old OAuth client in
   GCP Console.

**Verification.** Sign in via the gub-admin login flow with a fresh
incognito browser. Confirm the JWT `aud` matches the new client ID.

**Cleanup.** Delete the old OAuth client in GCP Console after a window
long enough that no user has a session keyed to the old `aud` claim.

### Cut a user off (revoke admin access)

This procedure lives here because the IAP IAM binding is managed by this
repo's Terraform tree.

1. Edit `terraform/environments/<env>.tfvars` and remove the user's
   email from `admin_emails`.
2. From `terraform/`, run `terraform apply -var-file=environments/<env>.tfvars`.
   The authoritative `_binding` revokes the user's IAP grant on apply.
   Verify the apply log shows the binding being modified, not recreated.
3. **If the user has GCP roles beyond IAP** (project owner, billing
   admin, Secret Manager access, Cloud Run admin, etc.), revoke each
   separately from the GCP IAM console. Item 5's Terraform binding only
   covers the IAP front door.
4. **In-flight IAP cookies may persist briefly** (typically up to a few
   minutes — IAP caches IAM decisions). For immediate cutoff, escalate
   to GCP support to invalidate active IAP sessions for the user.
5. Audit Secret Manager bindings:
   ```bash
   gcloud secrets get-iam-policy <secret-name>
   ```
   Remove any direct grants the user had on individual secrets.
