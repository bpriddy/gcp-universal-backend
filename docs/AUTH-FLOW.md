# Authentication Flow

## Overview

GUB uses RS256 asymmetric JWT signing. The backend holds the private key;
downstream services verify tokens using the public JWKS endpoint. There are
three authentication paths depending on the client type.

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
| CORS | Origin whitelist from env var |
| Secret management | GCP Secret Manager, injected at runtime |
| Container security | Non-root user (`nodeuser`, uid 1001) |
