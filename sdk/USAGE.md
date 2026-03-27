# GUB SDK Usage Guide

This SDK connects any frontend or backend service to the GCP Universal Backend (GUB).
GUB handles Google OAuth, user validation, and organisation data for all apps in the agency.

---

## Install

```bash
# Frontend (React)
npm install github:bpriddy/gcp-universal-backend @react-oauth/google

# Backend (Node)
npm install github:bpriddy/gcp-universal-backend jose
```

---

## Environment variables required

### Frontend
```env
VITE_GUB_URL=https://gub.yourdomain.com
VITE_GOOGLE_CLIENT_ID=your-google-client-id.apps.googleusercontent.com
VITE_APP_ID=your-app-id
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
import { GUBProvider } from 'gcp-universal-backend/frontend'

const gubConfig = {
  gubUrl: import.meta.env.VITE_GUB_URL,
  googleClientId: import.meta.env.VITE_GOOGLE_CLIENT_ID,
  appId: import.meta.env.VITE_APP_ID,
}

export default function App() {
  return (
    <GUBProvider config={gubConfig}>
      <YourApp />
    </GUBProvider>
  )
}
```

### 2. Use the hook in any component

```tsx
import { useGUB } from 'gcp-universal-backend/frontend'

export default function Dashboard() {
  const { isAuthenticated, isLoading, login, logout, user, fetch } = useGUB()

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

### 3. Make authenticated API calls

```tsx
import { useGUB } from 'gcp-universal-backend/frontend'

export default function ReportsList() {
  const { fetch, isAuthenticated } = useGUB()
  const [reports, setReports] = useState([])

  useEffect(() => {
    if (!isAuthenticated) return
    // fetch() automatically attaches the JWT and handles token refresh
    fetch('https://your-app-backend.com/api/reports')
      .then(r => r.json())
      .then(setReports)
  }, [isAuthenticated])

  return <ul>{reports.map(r => <li key={r.id}>{r.name}</li>)}</ul>
}
```

### 4. Pre-built login button

```tsx
import { GUBLoginButton } from 'gcp-universal-backend/frontend'

// Renders "Sign in with Google" or "Sign out (email)" automatically
<GUBLoginButton className="btn btn-primary" />
```

---

## Backend — Node (Express example)

### 1. Create the GUB client

```ts
// gub.ts — create once, import everywhere
import { createGUBClient } from 'gcp-universal-backend/backend'

export const gub = createGUBClient({
  gubUrl: process.env.GUB_URL!,
  issuer: process.env.GUB_ISSUER!,
  audience: process.env.GUB_AUDIENCE!,
})
```

### 2. Protect routes with middleware

```ts
import express from 'express'
import { gub } from './gub'

const app = express()

// Verify JWT on all routes
app.use(gub.middleware())

// Role-gated routes
app.get('/api/reports',   gub.requireRole('viewer'),      reportsHandler)
app.post('/api/campaigns', gub.requireRole('contributor'), campaignsHandler)
app.delete('/api/accounts', gub.requireRole('admin'),     deleteHandler)
```

### 3. Access user context in a route

```ts
app.get('/api/me', gub.middleware(), (req, res) => {
  const { user, appPermission } = req.gub

  res.json({
    userId: user.sub,
    email: user.email,
    role: appPermission?.role ?? 'none',
  })
})
```

### 4. Fetch org data from GUB

```ts
app.get('/api/dashboard', gub.middleware(), async (req, res) => {
  const token = req.headers.authorization!.split(' ')[1]
  const org = gub.orgClient(token)

  // Fetch accounts and campaigns for the logged-in user
  const [accounts, campaigns] = await Promise.all([
    org.listAccounts(),
    org.listCampaigns(req.query.accountId as string),
  ])

  res.json({ accounts, campaigns })
})
```

### 5. Standalone token verification (non-Express)

```ts
import { createGUBClient } from 'gcp-universal-backend/backend'

const gub = createGUBClient({ gubUrl, issuer, audience })

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
  if (!token) { res.writeHead(401); res.end(); return }
  const user = await gub.verifyToken(token)
  // ...
})
```

---

## Type declarations (TypeScript projects)

Add this to a `types/gub.d.ts` file to get `req.gub` typed in Express:

```ts
import type { GUBRequestContext } from 'gcp-universal-backend/backend'

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

Roles are assigned per-user per-app in the GUB database.

| Role | Can do |
|---|---|
| `viewer` | Read access |
| `contributor` | Read + write |
| `manager` | Read + write + manage users |
| `admin` | Full access |

`requireRole('viewer')` allows viewer and above.
`requireRole('manager')` allows manager and admin only.

---

## How it works

```
Frontend                    GUB                         Your Backend
   │                         │                               │
   │── POST /auth/google ────▶│ validate Google token         │
   │                         │ look up user in DB             │
   │◀── { accessToken } ─────│ issue signed JWT               │
   │                         │                               │
   │── GET /api/data ────────────────────────────────────────▶│
   │   Authorization: Bearer <token>                          │
   │                         │                 verify JWT     │
   │                         │             (JWKS, no call)    │
   │◀── { data } ───────────────────────────────────────────────
   │                         │                               │
   │                         │◀── GET /org/accounts ─────────│ (optional org data)
   │                         │─── { accounts } ─────────────▶│
```
