# gcp-universal-backend

A universal auth gateway for GCP-hosted applications. Accepts a Google OAuth token from the frontend, validates the user against a PostgreSQL users table, and issues RS256-signed JWTs that carry per-application permissions. Downstream apps verify tokens independently using the public JWKS endpoint — no callback to this service required.

> **POC Status:** This system is a working proof of concept that demonstrates
> end-to-end functionality across three repos. See the [docs/](./docs/) folder
> for comprehensive documentation intended for vendor onboarding.

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

1. Generate a new key pair, add to Secret Manager with a new `kid`
2. Update `JWT_KEY_ID` to the new key ID — new tokens are signed with it
3. Keep the old public key in the JWKS response for one access token TTL (15 min)
4. Remove the old key from JWKS after the TTL window passes

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
