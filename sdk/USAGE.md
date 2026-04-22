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

## Environment variables

### Frontend
```env
VITE_GUB_URL=https://gub.yourdomain.com
VITE_GOOGLE_CLIENT_ID=your-google-client-id.apps.googleusercontent.com
```

### Backend
```env
GUB_URL=https://gub.yourdomain.com
GUB_ISSUER=https://gub.yourdomain.com
GUB_AUDIENCE=your-app-id
```

---

## Frontend — React

### 1. Wrap your app with GUBProvider

```tsx
// main.tsx or App.tsx
import { GUBProvider } from 'gcp-universal-backend/sdk/frontend'

export default function App() {
  return (
    <GUBProvider config={{
      gubUrl: import.meta.env.VITE_GUB_URL,
      googleClientId: import.meta.env.VITE_GOOGLE_CLIENT_ID,
    }}>
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
| `user.isAdmin` | `boolean` | Superuser flag |
| `user.permissions` | `TokenPermission[]` | App-level permissions |
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
  config={{ gubUrl: '...', googleClientId: '...' }}
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
// gub.ts — create once, import everywhere
import { createGUBClient } from 'gcp-universal-backend/sdk/backend'

export const gub = createGUBClient({
  gubUrl:   process.env.GUB_URL!,
  issuer:   process.env.GUB_ISSUER!,
  audience: process.env.GUB_AUDIENCE!,
})
```

### 2. Protect routes with middleware (Express)

```ts
import { gub } from './gub'

// Verify JWT — attaches req.gub = { user, appPermission }
app.use(gub.middleware())

// Role-gated routes
app.get('/api/reports',    gub.requireRole('viewer'),      handler)
app.post('/api/campaigns', gub.requireRole('contributor'), handler)
app.delete('/api/data',    gub.requireRole('admin'),       handler)
```

### 3. Access user context in a route handler

```ts
app.get('/api/me', gub.middleware(), (req, res) => {
  const { user, appPermission } = req.gub

  res.json({
    userId:    user.sub,
    email:     user.email,
    isAdmin:   user.isAdmin,
    role:      appPermission?.role ?? 'none',
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

  // Campaigns under a specific account
  const campaigns = await org.listCampaignsByAccount(accounts[0].id)

  // Or every campaign the user can see, across accounts
  const allCampaigns = await org.listCampaigns({ status: 'active' })

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
| `org.listCampaigns({ status? })` | `GUBCampaign[]` | Grants |
| `org.listCampaignsByAccount(accountId)` | `GUBCampaign[]` | Grants |
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

## Roles

Roles are assigned per-user per-app in the GUB database via `grantAccountAccess()`.
`isAdmin` users bypass all role checks automatically.

| Role | Intended for |
|---|---|
| `viewer` | Read-only access |
| `contributor` | Read + write |
| `manager` | Read + write + manage access |
| `admin` | Full access |

`requireRole('viewer')` allows viewer and above.
`requireRole('manager')` allows manager and admin only.

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
