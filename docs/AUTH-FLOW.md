# Authentication Flow

## Overview

GUB uses RS256 asymmetric JWT signing. The backend holds the private key;
downstream services verify tokens using the public JWKS endpoint. There are
three authentication paths depending on the client type, plus a separate
pass-through layer for Google Workspace API calls (Path 4).

**Identity vs. Workspace access are separate concerns:**
- Paths 1–3 establish *who* the user is (GUB JWT).
- Path 4 carries *what the user can do in Google Workspace* (Gmail,
  Calendar, per-user Drive) on behalf of the client app that already holds
  the user's refresh token. GUB never stores Google refresh tokens.

## Path 1: Browser Client (Frontend SDK)

Standard Google Sign-In → GUB JWT exchange.

```
Browser                              GUB Backend                   Google
  │                                      │                           │
  │──[1] Google Sign-In SDK──────────────┼──────────────────────────▶│
  │                                      │                           │
  │◀─────────────────────────────────────┼───[2] Google ID token ───│
  │                                      │                           │
  │──[3] POST /auth/google/exchange─────▶│                           │
  │       { idToken, appId? }            │                           │
  │                                      │──[4] Verify with Google──▶│
  │                                      │◀─── token payload ───────│
  │                                      │                           │
  │                                      │──[5] Find or create user  │
  │                                      │──[6] Check app access     │
  │                                      │──[7] Sign RS256 JWT       │
  │                                      │──[8] Issue refresh token  │
  │                                      │                           │
  │◀─[9] { accessToken, refreshToken }──│                           │
  │                                      │                           │
  │──[10] API calls with Bearer token──▶│                           │
```

**Token lifecycle:**
- Access token: 15-minute TTL, stored in memory only
- Refresh token: 30-day TTL, stored in localStorage
- Proactive refresh 60 seconds before expiry
- Single-use rotation: each refresh issues a new token pair
- Reuse detection: presenting a rotated token revokes the entire family

**Endpoints:**
- `POST /auth/google/exchange` — Initial login
- `POST /auth/refresh` — Token rotation
- `POST /auth/logout` — Revoke token + family
- `POST /auth/logout-all` — Revoke all devices (requires Bearer)
- `GET /.well-known/jwks.json` — Public key for downstream verification

## Path 2: ADK Agent via Agentspace (Current POC Flow)

This is the flow used in the POC for the AI agent in Agentspace.

```
User                Agentspace           OAuth Relay        Google        Agent Engine       gub-agent         GUB Backend
  │                     │                    │                 │               │                  │                 │
  │──[1] Chat msg──────▶│                    │                 │               │                  │                 │
  │                     │                    │                 │               │                  │                 │
  │  (if no token cached for gub-oauth-3)    │                 │               │                  │                 │
  │◀─[2] OAuth popup───│                    │                 │               │                  │                 │
  │                     │                    │                 │               │                  │                 │
  │──[3] Redirect──────▶│──[4] Redirect────▶│                 │               │                  │                 │
  │                     │                    │──[5] 302───────▶│               │                  │                 │
  │                     │                    │  (preserves QS) │               │                  │                 │
  │◀────────────────────┼────────────────────┼──[6] Consent──│               │                  │                 │
  │──[7] Approve───────▶│                    │                 │               │                  │                 │
  │                     │◀───────────────────┼──[8] Auth code─│               │                  │                 │
  │                     │                    │                 │               │                  │                 │
  │                     │──[9] widgetStoreUserAuthorization────│               │                  │                 │
  │                     │   (exchanges code, stores token)     │               │                  │                 │
  │                     │                    │                 │               │                  │                 │
  │                     │──[10] Route msg to agent────────────▶│               │                  │                 │
  │                     │                    │                 │               │                  │                 │
  │                     │                    │                 │  ┌────────────┤                  │                 │
  │                     │                    │                 │  │ Inject     │                  │                 │
  │                     │                    │                 │  │ Google     │                  │                 │
  │                     │                    │                 │  │ access     │                  │                 │
  │                     │                    │                 │  │ token into │                  │                 │
  │                     │                    │                 │  │ state      │                  │                 │
  │                     │                    │                 │  └────────────┤                  │                 │
  │                     │                    │                 │               │──[11] Tool call─▶│                 │
  │                     │                    │                 │               │                  │                 │
  │                     │                    │                 │               │                  │──[12] Exchange──▶│
  │                     │                    │                 │               │                  │  Google token    │
  │                     │                    │                 │               │                  │  for GUB JWT     │
  │                     │                    │                 │               │                  │◀─── GUB JWT ────│
  │                     │                    │                 │               │                  │                 │
  │                     │                    │                 │               │                  │──[13] API call──▶│
  │                     │                    │                 │               │                  │  Bearer: GUB JWT │
  │                     │                    │                 │               │                  │◀─── data ───────│
  │                     │                    │                 │               │◀─ result ───────│                 │
  │                     │◀─── response ──────┼─────────────────┼───────────────│                  │                 │
  │◀─── chat reply ────│                    │                 │               │                  │                 │
```

### Token Injection Detail

Agentspace stores the user's Google OAuth access token in the ADK
`tool_context.state` dictionary under the authorization ID key. The
agent reads it with:

```python
state_dict = tool_context.state.to_dict()
google_access_token = state_dict.get("gub-oauth-3")
```

**Critical:** `State.get()` prepends prefixes (`app:`, `temp:`) to keys.
The token is stored under the raw key (no prefix). Always use
`to_dict()` to access it.

The agent then exchanges the Google access token for a GUB JWT:

```
POST /auth/google/access-token-exchange
{ "accessToken": "<google_access_token>" }

Response: { "accessToken": "<gub_jwt>", "refreshToken": "...", ... }
```

The GUB JWT is cached in `tool_context.state["gub_jwt"]` for subsequent
tool calls in the same session.

### OAuth Relay Workaround

Discovery Engine strips query parameters from URLs on the
`accounts.google.com` domain. This breaks OAuth because
`response_type=code` is required.

**Workaround:** A Cloud Function at
`https://us-central1-os-test-491819.cloudfunctions.net/oauth-relay`
receives the OAuth request and 302-redirects to Google's endpoint with
the full query string preserved.

The authorization resource in Agentspace is configured to use the relay
URL as the authorization endpoint instead of Google's directly.

### Agentspace Authorization Configuration

The Discovery Engine authorization resource (`gub-oauth-3`) is configured via
the `v1alpha` API:

```
projects/843516467880/locations/global/authorizations/gub-oauth-3
```

**Key settings:**
- Auth type: `OAUTH`
- OAuth client ID: `843516467880-crbjjtkp9ri8em139i03rf3gmgr95l8m.apps.googleusercontent.com`
- Authorization endpoint: `https://us-central1-os-test-491819.cloudfunctions.net/oauth-relay` (relay)
- Token endpoint: `https://oauth2.googleapis.com/token`
- Scopes: `openid email profile`
- Redirect URIs (on Google OAuth client):
  - `https://vertexaisearch.cloud.google.com/oauth-redirect`
  - `https://vertexaisearch.cloud.google.com/static/oauth/oauth.html`

## Path 3: OAuth 2.0 Broker (Server-Side Flow)

For headless clients that need server-side auth (not used in current POC,
but available for future integrations).

```
Client App              GUB Backend              Google
  │                         │                       │
  │──[1] Redirect to────── │                       │
  │  /auth/google/broker/   │                       │
  │  authorize?client_id=X  │                       │
  │                         │──[2] Create pending──│
  │                         │──[3] Redirect to─────▶│
  │                         │      Google OAuth     │
  │◀────────────────────────┼───────────────────────│
  │──[4] User consents─────▶│                       │
  │                         │◀─[5] Google code ────│
  │                         │──[6] Verify + issue──│
  │                         │      GUB auth code    │
  │◀─[7] Redirect with─────│                       │
  │      GUB auth code      │                       │
  │                         │                       │
  │──[8] POST /broker/token▶│                       │
  │  { code, client_secret } │                       │
  │                         │──[9] Issue tokens────│
  │◀─[10] { accessToken,───│                       │
  │         refreshToken }  │                       │
```

OAuth clients are registered via the admin CMS or the admin-only
API endpoints (`POST /auth/google/broker/clients`).

## Path 4: Workspace Pass-Through (Client-Owned OAuth)

Used for GUB endpoints that need to call Google Workspace APIs on behalf of
a specific user (Gmail, Calendar, per-user Drive, etc.). The client app
owns the Workspace OAuth consent flow and refresh tokens; GUB receives only
a short-lived access token per request.

```
Client app                              GUB Backend                Google Workspace
  │                                         │                              │
  │──[1] OAuth consent flow with Google ───────────────────────────────────▶│
  │◀─────[2] access_token + refresh_token ─────────────────────────────────│
  │       (client stores refresh_token)     │                              │
  │                                         │                              │
  │──[3] Request with two headers──────────▶│                              │
  │     Authorization: Bearer <GUB JWT>     │                              │
  │     X-Workspace-Token: <Google access>  │                              │
  │                                         │                              │
  │                                         │──[4] Verify GUB JWT           │
  │                                         │──[5] resolveWorkspaceCreds    │
  │                                         │──[6] Call Workspace with     │
  │                                         │      X-Workspace-Token──────▶│
  │                                         │◀──[7] Workspace response─────│
  │                                         │                              │
  │◀─[8] GUB response──────────────────────│                              │
```

**Why pass-through instead of GUB owning the flow:**
- Refresh tokens stay with the client app that obtained consent
- GUB never persists Google credentials (smaller blast radius)
- Different client apps can request different Workspace scopes without
  coordinating through GUB
- GUB stays a stateless identity + org-data gateway

**Middleware wiring** (`src/app.ts`):
- `attachWorkspaceToken` extracts `X-Workspace-Token` and attaches it to
  `req.workspaceAccessToken`. Permissive — never 401s on its own.
- `req.headers["x-workspace-token"]` is in the pino-http redact list; the
  token never appears in application logs.
- CORS `allowedHeaders` includes `X-Workspace-Token` for browser preflight.

**Route usage:**

```ts
// User-required endpoint (per-user Gmail/Calendar/Drive)
import { resolveWorkspaceCreds, buildGoogleAuthClient } from '../workspace';

router.get('/my-calendars', authenticate, async (req, res) => {
  const creds = resolveWorkspaceCreds(req); // throws 401 if no X-Workspace-Token
  const auth = buildGoogleAuthClient(creds, {
    scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
  });
  const calendar = google.calendar({ version: 'v3', auth });
  ...
});

// Admin/cron endpoint (service-account fallback allowed)
router.post('/admin/run-sync', authenticate, requireAdmin, async (req, res) => {
  const creds = resolveWorkspaceCreds(req, { allowServiceAccountFallback: true });
  const auth = buildGoogleAuthClient(creds, {
    scopes: ['https://www.googleapis.com/auth/directory.readonly'],
    impersonate: 'sync-bot@example.com',
  });
  ...
});
```

Fail-closed by default: `allowServiceAccountFallback: false` means "this
endpoint requires a user's Workspace token; no silent cross-over to the
service account."

**What GUB deliberately does NOT do:**
- Perform Workspace OAuth consent
- Store Google refresh tokens
- Cache Workspace access tokens across requests

**Service-account exceptions (by design):**
- Google Directory sync (`directory.client.ts`) — domain-wide read of all
  staff; no user in the request
- Google Drive sync (`drive.client.ts`) — batch scan over shared folders;
  SA is explicitly added as a viewer on each folder

These two modules deliberately do not use `resolveWorkspaceCreds`. They run
in the background with no HTTP request context and are SA-only.

See also: `src/modules/workspace/` (the module) and the internal
architecture doc `project_workspace_passthrough.md`.

## JWT Payload Structure

```json
{
  "sub": "user-uuid",
  "email": "user@example.com",
  "displayName": "User Name",
  "isAdmin": false,
  "permissions": [
    { "appId": "my-app", "role": "contributor" }
  ],
  "iss": "https://auth.example.com",
  "aud": "https://api.example.com",
  "iat": 1712500000,
  "exp": 1712500900,
  "jti": "random-uuid"
}
```

## Identity Resolution

When a Google token is presented, user lookup follows this priority:

1. **By `googleSub`** (immutable Google identifier) — safest match
2. **By email where `googleSub` IS NULL** — claims a pre-created stub
   account (admin created the user before their first login)
3. **JIT provisioning** — creates a new user with zero permissions

This allows admins to pre-provision users and access grants before the
person has ever logged in.

## Security Notes

| Concern | Current State |
|---------|--------------|
| Token signing | RS256 asymmetric — private key in Secret Manager |
| Refresh token storage | SHA-256 hash only; raw token transmitted once |
| Reuse detection | Rotated token reuse revokes entire family |
| Rate limiting | 10 req/15min on auth, 100 req/15min global |
| CORS | Origin whitelist from env var (+ `X-Workspace-Token` allowed header) |
| Secret management | GCP Secret Manager, injected at runtime |
| Container security | Non-root user (`nodeuser`, uid 1001) |
| Workspace tokens | Pass-through only — never stored, redacted in logs, fail-closed by route |
