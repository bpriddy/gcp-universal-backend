# gcp-universal-backend

A universal auth gateway for GCP-hosted applications. Accepts a Google OAuth ID token from the frontend, validates the user against a PostgreSQL users table, and issues RS256-signed JWTs that carry per-application database permissions. Downstream apps verify tokens independently using the public JWKS endpoint and receive a pre-authorized database connection pool.

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
├── src/
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
│   │   ├── auth/                     # Login, refresh, logout, JWKS endpoints
│   │   └── health/                   # /health (readiness) + /health/live (liveness)
│   ├── services/
│   │   ├── google.service.ts         # Google ID token verification
│   │   ├── jwt.service.ts            # RS256 sign/verify + JWKS export
│   │   ├── token.service.ts          # Refresh token lifecycle + reuse detection
│   │   └── user.service.ts           # User lookup + JIT provisioning
│   └── types/                        # Express augmentation, JWT payload types
├── prisma/
│   ├── schema.prisma                 # users, user_app_permissions, refresh_tokens
│   └── migrations/
├── frontend/                         # React + Vite reference frontend (see below)
├── scripts/
│   └── generate-keys.sh             # Generate RS256 key pair for local dev
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

### Health

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Readiness probe — checks DB connectivity |
| `GET` | `/health/live` | Liveness probe — no dependencies |

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
| `CORS_ALLOWED_ORIGINS` | No | Comma-separated allowed origins |
| `AUTH_RATE_LIMIT_MAX` | No | Max auth requests per window (default: `10`) |
| `PORT` | No | Server port (default: `3000`) |
| `NODE_ENV` | No | `development` \| `production` \| `test` |
