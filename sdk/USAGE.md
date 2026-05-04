# GUB SDK — Usage Guide

> **AI assistants and vibe coding platforms (Replit, Cursor, Bolt, etc.)**
> This file is the complete reference for integrating with GUB.
> Copy the relevant sections below and adapt to the project.
> Everything needed to implement auth end-to-end is here.

---

## What is GUB?

GUB (GCP Universal Backend) is the authentication and organisation data service for this agency.
It handles:
- Google OAuth login for all apps
- JWT issuance and verification
- Org data (accounts, campaigns, staff) with per-user access control

All agency apps authenticate through GUB. Frontends get a JWT. Backends verify it locally.

---

## Install

One command. No registry token needed.

```bash
npm install github:bpriddy/gcp-universal-backend
```

---

## Configuration — one declaration, used everywhere

GUB uses a single config helper that the frontend and backend both consume.
Two env vars + one code constant; nothing is duplicated.

### Environment variables

```env
# Frontend (use whatever prefix your build tool requires —
# VITE_*, NEXT_PUBLIC_*, REACT_APP_*, etc.):
VITE_GUB_URL=https://gub.yourdomain.com
VITE_GOOGLE_CLIENT_ID=your-google-client-id.apps.googleusercontent.com

# Backend:
GUB_URL=https://gub.yourdomain.com
GOOGLE_CLIENT_ID=your-google-client-id.apps.googleusercontent.com
```

That's it. **No `GUB_ISSUER`, no `GUB_AUDIENCE`, no `APP_ID` env var.** The
issuer and JWKS URI come from GUB's `/.well-known/oauth-authorization-server`
discovery doc; the audience is your `appId` declared once in code.

### Shared config helper

Create one file your frontend and backend both import:

```ts
// src/gub.ts
import { defineGUBConfig } from 'gcp-universal-backend/sdk/config'

export const GUB = defineGUBConfig({
  // Use whichever your environment exposes:
  url:            import.meta.env.VITE_GUB_URL ?? process.env.GUB_URL!,
  googleClientId: import.meta.env.VITE_GOOGLE_CLIENT_ID ?? process.env.GOOGLE_CLIENT_ID!,
  // appId is identity, not config — same string in dev/staging/prod.
  // Pick a stable identifier and hardcode it here.
  appId: 'workflows-dashboard',
})
```

The helper:
- Validates the URL (https only, except loopback) and the Google client_id shape.
- Fetches GUB's discovery doc lazily on first use, validates `discovery.issuer === url`.
- Fails loudly on misconfiguration at startup, before any user-facing auth call.

---

## Frontend — React

### 1. Wrap your app with GUBProvider

```tsx
// main.tsx or App.tsx
import { GUBProvider } from 'gcp-universal-backend/sdk/frontend'
import { GUB } from './gub'

export default function App() {
  return (
    <GUBProvider config={GUB}>
      <YourApp />
    </GUBProvider>
  )
}
```

### 2. Use the hook in any component

```tsx
import { useGUB } from 'gcp-universal-backend/sdk/frontend'

export default function Dashboard() {
  const { isAuthenticated, isLoading, login, logout, user } = useGUB()

  if (isLoading) return <p>Loading...</p>

  if (!isAuthenticated) {
    return <button onClick={login}>Sign in with Google</button>
  }

  return (
    <div>
      <p>Welcome, {user.displayName ?? user.email}</p>
      <button onClick={logout}>Sign out</button>
    </div>
  )
}
```

### 3. Make authenticated API calls to your app backend

```tsx
import { useGUB } from 'gcp-universal-backend/sdk/frontend'

export default function ReportsList() {
  const { fetch, isAuthenticated } = useGUB()
  const [reports, setReports] = useState([])

  useEffect(() => {
    if (!isAuthenticated) return
    // fetch() automatically attaches the JWT and handles silent token refresh
    fetch('https://your-app-backend.com/api/reports')
      .then(r => r.json())
      .then(setReports)
  }, [isAuthenticated])

  return <ul>{reports.map(r => <li key={r.id}>{r.name}</li>)}</ul>
}
```

### 4. Pre-built login button

```tsx
import { GUBLoginButton } from 'gcp-universal-backend/sdk/frontend'

// Renders "Sign in with Google" when logged out, "Sign out (email)" when logged in
<GUBLoginButton className="btn btn-primary" />
```

### Available values from useGUB()

| Value | Type | Description |
|---|---|---|
| `user` | `GUBUser \| null` | Authenticated user or null |
| `user.sub` | `string` | User UUID |
| `user.email` | `string` | User email |
| `user.displayName` | `string \| null` | Display name from Google |
| `user.isAdmin` | `boolean` | Superuser flag (bypasses GUB org-data access checks; not an app-level role) |
| `isAuthenticated` | `boolean` | True when logged in |
| `isLoading` | `boolean` | True during any auth op (restore, login, refresh, logout). Initialized to `true` on first render when `initialRefreshToken` is present, so `!isLoading && !isAuthenticated` safely means "user is logged out" without a false-positive flash on reload. |
| `isRestoring` | `boolean` | True only while the initial-mount session restoration is in flight. Becomes false after the restore settles; does not flip true again later. Use this to distinguish a page-reload session check from an interactive login. |
| `login()` | `() => void` | Triggers Google sign-in |
| `logout()` | `() => Promise<void>` | Clears session |
| `fetch()` | `(url, init?) => Promise<Response>` | Authenticated fetch |
| `accessToken` | `string \| null` | Raw JWT (prefer fetch()) |

### Session restoration pattern

If you pass `initialRefreshToken` to `GUBProvider` from a server-side cookie,
the provider will attempt to restore the session on mount. During that window
`isLoading` is `true` (so a naive `if (!isLoading && !isAuthenticated) redirect()`
won't fire prematurely). The provider signals failure via `onTokensChange(null)`:

```tsx
<GUBProvider
  config={GUB}
  initialRefreshToken={sessionCookie.refreshToken}
  onTokensChange={(tokens) => {
    if (tokens === null) {
      // Restore failed (server rejected the refresh token) OR user logged out.
      // Clear your cookie so the next reload doesn't loop on a bad token.
      clearSessionCookie();
    } else {
      // Persist the fresh pair so reload picks them up next time.
      saveSessionCookie(tokens);
    }
  }}
>
  <App />
</GUBProvider>
```

Transient network failures during restoration do NOT trigger `onTokensChange(null)` —
the cookie stays intact, and the next reload tries again.

---

## Backend — Node.js

Works with Express, Fastify, raw http, or any Node framework.

### 1. Create the GUB client (once at startup)

```ts
// gub-client.ts — create once, import everywhere
import { createGUBClient } from 'gcp-universal-backend/sdk/backend'
import { GUB } from './gub'  // the shared config from above

export const gub = createGUBClient(GUB)
```

The client's `verifyToken(token)` takes one argument — the token. Audience
verification is pinned to `GUB.appId` and cannot be overridden. There is no
`audience` parameter, no `skipAudienceCheck` flag, no "trusted audiences"
array. If you ever need cross-app verification, that gets designed as a
GUB-side token-exchange endpoint, not a runtime SDK escape hatch.

### 2. Protect routes with middleware (Express)

```ts
import { gub } from './gub'

// Verify JWT — attaches req.gub = { user }
app.use(gub.middleware())
```

GUB's middleware verifies the token and exposes the authenticated user.
**App-level role/permission gating is your app's job**, not GUB's.
Sketch: keep your own roles in your own DB (or a config file), and
write a thin middleware that checks them against `req.gub.user.email`
or `req.gub.user.sub`:

```ts
// your-app's authorize.ts
import type { Request, Response, NextFunction } from 'express'

const ADMIN_EMAILS = new Set(['alice@yourcompany.com', 'bob@yourcompany.com'])

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  // GUB's req.gub.user.isAdmin is platform-level (org-data access on GUB).
  // Define your own per-app admin set for app-level decisions.
  if (!ADMIN_EMAILS.has(req.gub.user.email)) {
    res.status(403).json({ error: 'Admin only' })
    return
  }
  next()
}

app.delete('/api/data', gub.middleware(), requireAdmin, handler)
```

### 3. Access user context in a route handler

```ts
app.get('/api/me', gub.middleware(), (req, res) => {
  const { user } = req.gub

  res.json({
    userId:  user.sub,
    email:   user.email,
    // user.isAdmin is GUB's superuser flag — bypasses GUB's org-data
    // access_grants. NOT a per-app role; define those yourself.
    isAdmin: user.isAdmin,
  })
})
```

### 4. Fetch org data from GUB (server-to-server)

```ts
app.get('/api/dashboard', gub.middleware(), async (req, res) => {
  // Pass the user's token so GUB scopes results to their access grants
  const token = req.headers.authorization!.split(' ')[1]
  const org = gub.org(token)

  const [accounts, staff] = await Promise.all([
    org.listAccounts(),
    org.listStaff(),
  ])

  // Every campaign the user can see, across accounts.
  // (Access is gated on campaign grants — a user CAN have direct campaign
  //  access without account access, and this lists everything they can see.)
  const campaigns = await org.listCampaigns({ status: 'active' })

  // If you need campaigns under a specific account, filter client-side:
  const acmeCampaigns = campaigns.filter((c) => c.accountId === accounts[0].id)

  // Offices + teams gated by access_grants — empty array means the user
  // has no `office_*` / `team_*` grants yet, NOT an error.
  const [offices, teams] = await Promise.all([
    org.listOffices({ activeOnly: true }),
    org.listTeams({ activeOnly: true }),
  ])

  res.json({ accounts, campaigns, offices, teams, staff })
})
```

### 5. Standalone token verification (Fastify / raw http)

```ts
// Fastify
fastify.addHook('preHandler', async (request, reply) => {
  const token = request.headers.authorization?.split(' ')[1]
  if (!token) return reply.status(401).send({ error: 'Unauthorized' })
  try {
    request.gubUser = await gub.verifyToken(token)
  } catch {
    return reply.status(401).send({ error: 'Invalid token' })
  }
})

// Raw Node http
http.createServer(async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1]
  if (!token) { res.writeHead(401); res.end('Unauthorized'); return }
  try {
    const user = await gub.verifyToken(token)
    // use user.sub, user.email, user.isAdmin ...
  } catch {
    res.writeHead(401); res.end('Invalid token')
  }
})
```

### Available org data methods

| Method | Returns | Gate |
|---|---|---|
| `org.listAccounts()` | `GUBAccount[]` | Grants |
| `org.getAccount(id)` | `GUBAccount` | Grants |
| `org.listCampaigns({ status? })` | `GUBCampaign[]` | Grants — campaign-scoped. Does NOT require account access; filter by `accountId` client-side if needed. |
| `org.getCampaign(id)` | `GUBCampaign` | Grants |
| `org.listOffices({ activeOnly? })` | `GUBOffice[]` | `office_all` / `office_active` / per-office grant |
| `org.getOffice(id)` | `GUBOffice` | Same |
| `org.listTeams({ activeOnly? })` | `GUBTeam[]` (with members) | `team_all` / `team_active` / per-team grant |
| `org.getTeam(id)` | `GUBTeam` | Same |
| `org.listStaff({ all? })` | `GUBStaff[]` | `staff_all` / `staff_current` / `staff_office` / `staff_team` grant |
| `org.getStaffMember(id)` | `GUBStaff` | Same |
| `org.listUsers({ activeOnly? })` | `GUBUserRecord[]` | **Admin only** |
| `org.getUser(id)` | `GUBUserRecord` | Admin or self |

**On access grants:** for offices, teams, and staff, calling the list
method with no matching grants returns `[]` — this is intentional, not an
error. The backend's `access_grants` table is the only gate; to give a
user access to a team they manually add a `team` / `team_all` /
`team_active` row. See the admin UI at `/grants/new`.

### Account current state

Accounts use an append-only change log. `currentState` is resolved by GUB and returned
as a flat object of the latest value per property:

```ts
account.currentState['account_exec_staff_id']        // staff.id UUID
account.currentState['day_to_day_contact_staff_id']  // staff.id UUID
account.currentState['status']                       // 'active' | 'paused' etc.
```

---

## TypeScript — Express type declarations

Add this to `types/gub.d.ts` to get `req.gub` typed across your project:

```ts
import type { GUBRequestContext } from 'gcp-universal-backend/sdk/backend'

declare global {
  namespace Express {
    interface Request {
      gub: GUBRequestContext
    }
  }
}
```

---

## Roles — your app's responsibility

GUB no longer carries per-app roles in tokens. App-level role/permission
hierarchies belong in each consuming app, where the rules can be specific
to that app's domain (Editor vs. Viewer for a CMS, Tier 1 vs. Tier 2 for
a customer support tool, etc.).

The JWT exposes:
- `user.sub`, `user.email`, `user.displayName` — identity
- `user.isAdmin` — GUB's platform-wide superuser flag, useful for
  bypassing GUB's org-data access checks. **Not** a per-app role.

Your app decides what to do with that identity. A common pattern is a
thin middleware that consults your own DB (see "Protect routes" above).

---

## How it works

```
Frontend                    GUB                         Your App Backend
   │                         │                               │
   │── POST /auth/google ────▶│ verify Google ID token        │
   │                         │ look up user in DB             │
   │                         │ check is_active                │
   │◀── { accessToken,  ─────│ issue signed RS256 JWT         │
   │      refreshToken }      │                               │
   │                         │                               │
   │── GET /api/data ────────────────────────────────────────▶│
   │   Authorization: Bearer <jwt>                            │
   │                         │              verify JWT locally │
   │                         │         (JWKS cached, no call) │
   │                         │                               │
   │                         │◀── GET /org/accounts ─────────│ optional: fetch org data
   │                         │─── [{ id, name, ... }] ───────▶│
   │                         │                               │
   │◀── { data } ───────────────────────────────────────────────
```

Token refresh happens silently in the frontend SDK — the user never sees it.
Backends verify tokens locally using the cached JWKS public key.
The only time a backend talks to GUB is for org data reads.

---

## Migrating from <0.x>

Earlier SDK versions asked implementers to declare 4–6 environment variables, several of which carried the same value:

```env
# OLD shape — still accepted with a deprecation warning, will be removed in a future major version.
GUB_URL=https://gub-dev.example.com
VITE_GUB_URL=https://gub-dev.example.com
GUB_ISSUER=https://gub-dev.example.com
GUB_AUDIENCE=workflows-dashboard
GOOGLE_CLIENT_ID=...
VITE_GOOGLE_CLIENT_ID=...
```

…and configured the SDK like this:

```tsx
// OLD frontend
<GUBProvider config={{ gubUrl: '...', googleClientId: '...' }}>

// OLD backend
createGUBClient({ gubUrl, issuer, audience })
```

The new shape is two env vars + one shared config file (see "Configuration — one declaration, used everywhere" at the top). Migration is mechanical:

| Old | New |
|---|---|
| `GUB_URL` (and `VITE_GUB_URL`, `GUB_ISSUER`) | `GUB_URL` (one canonical name; declare with whatever build-tool prefix your env requires) |
| `GUB_AUDIENCE` env var | `appId` field in `defineGUBConfig`, hardcoded |
| `<GUBProvider config={{ gubUrl, googleClientId }}>` | `<GUBProvider config={GUB}>` where `GUB = defineGUBConfig({ url, googleClientId, appId })` |
| `createGUBClient({ gubUrl, issuer, audience })` | `createGUBClient(GUB)` |
| `gub.verifyToken(token, options?)` | `gub.verifyToken(token)` — audience pinned to `appId`, no override |

### What stays the same

- The `useGUB()` hook contract for `user`, `login`, `logout`, `fetch`, `accessToken`, `isLoading`, `isRestoring`, `isAuthenticated`.
- `gub.middleware()` and `gub.org()` are unchanged.
- JWT signing keys, JWKS endpoint, refresh-token flow.
- The `/auth/google/exchange` request contract on the wire.

### What's removed (separate from this proposal — see [remove-app-access-gating](remove-app-access-gating.md))

- `gub.requireRole()` middleware. App-level role gating now belongs in your own app.
- `appPermission` field on `req.gub`. Same reason.
- `user.permissions[]` on `useGUB()`. Same reason.

### Deprecation timeline

| Phase | Behavior |
|---|---|
| Now | Old shape works, prints `console.warn(…)` once at construction. New shape recommended. |
| Next minor | Old shape works, warning becomes more prominent. |
| Future major | Old shape is removed. Type errors at compile time direct you to `defineGUBConfig`. |

### Why the change

Three problems with the old shape:

1. **Repetition.** The same string declared up to 4 times (`GUB_URL` / `VITE_GUB_URL` / `GUB_ISSUER`) created drift opportunities with no benefit.
2. **Implementer-typed values that come from discovery.** `issuer`, `jwks_uri`, etc. live in GUB's `/.well-known/oauth-authorization-server` document. The SDK now consumes that doc instead of asking implementers to retype.
3. **Env-varring identity.** `appId` is a stable string that doesn't vary across environments. Putting it in env invited drift; it belongs in code.

See `docs/proposals/sdk-config-simplification.md` in the GUB repo for the full reasoning, including the security review and decisions log.
