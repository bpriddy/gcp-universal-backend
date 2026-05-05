# Heads-up for the work-flows implementer (and any future GUB SDK consumers)

**Date:** 2026-05-04
**What changed:** GUB's per-app access gate is gone. SDK is simpler.
**Action required from you:** small. Re-pull the SDK; remove a few things if you wired them up.

---

## TL;DR

We removed the user_app_permissions table and the `pending_approval`
branch from `/auth/google/exchange`. **GUB no longer decides whether
your users are allowed to use your app — that's now your call,
on your terms, in your codebase.**

Your existing code probably keeps working as-is, especially if you
never used `requireRole` or read `user.permissions[]` from the JWT.
A few tweaks make it cleaner.

## Re-pull the SDK

```bash
npm install github:bpriddy/gcp-universal-backend
```

This brings the trim-down + a JWT audience fix that you'd have hit as
soon as you got past the `pending_approval` crash.

## What changes for you

### 1. The `pending_approval` crash is fixed

Before: GUB returned 202 with `{ status: 'pending_approval', userId, appId }`
when a user authenticated successfully but lacked an `access_grant` for
your `appId`. The old SDK crashed on this; the hotfix throws a typed
error.

After: that path is gone. GUB returns 200 with tokens for any
authenticated active user. Whether that user gets to *do* anything in
your app is your decision.

If you wrote a `try/catch` around `login()` that handled
`GUBPendingApprovalError`: that branch is now unreachable; safe to remove.

### 2. The JWT audience now matches what the SDK verifies against

Before (broken): GUB signed tokens with `aud = JWT_AUDIENCE` (the GUB URL).
SDK verifier expected `aud = your.appId`. Verification would have failed
the first time you hit it.

After: tokens are signed with `aud = [your.appId, JWT_AUDIENCE]`
(multi-audience). Both your verifier and GUB's own `/org/*` verifier
accept the same token.

You don't have to do anything for this — the SDK handles it. Just be
aware tokens have two audiences now; that's intentional.

### 3. `gub.requireRole()` is gone

If you used it:

```ts
// before
app.delete('/api/data', gub.requireRole('admin'), handler)

// after — write your own
const ADMIN_EMAILS = new Set(['alice@example.com'])
function requireAdmin(req, res, next) {
  if (!ADMIN_EMAILS.has(req.gub.user.email)) {
    return res.status(403).json({ error: 'Admin only' })
  }
  next()
}
app.delete('/api/data', gub.middleware(), requireAdmin, handler)
```

If you didn't use it: nothing to do.

### 4. `user.permissions[]` is gone from the JWT

The `permissions` array (the `viewer/contributor/manager/admin` ladder
GUB used to ship) isn't in tokens anymore. If you read it anywhere —
typically in a hook or middleware — replace with your own role lookup
based on `user.email` or `user.sub`.

If you didn't read it: nothing to do.

### 5. `req.gub.appPermission` is gone

Same story as `permissions[]`. If you read `req.gub.appPermission.role`
in a route handler, swap to your own check.

## What stays exactly the same

- `<GUBProvider config={GUB}>` — same.
- `useGUB()` returning `user`, `login`, `logout`, `fetch`,
  `accessToken`, `isLoading`, `isRestoring`, `isAuthenticated` — all
  unchanged.
- `gub.middleware()` and `gub.org()` — unchanged.
- `defineGUBConfig({ url, googleClientId, appId })` — unchanged.
- Your env vars (`GUB_URL`, `GOOGLE_CLIENT_ID`) — unchanged.
- The audience claim mechanic from the SDK simplification proposal —
  same; the multi-audience fix is what makes it work end-to-end.
- JWT signing keys, JWKS endpoint, refresh-token flow — unchanged.

## Why we did this

GUB is the **identity provider** + the **org-data resource server**.
Per-user, per-app authorization is neither of those — it's a question
each consuming app can answer better than a centralized table can,
because each app knows its own access rules.

Centralizing it created onboarding friction (every user × every app =
a row), forced apps to bend to a fixed `viewer/contributor/manager/admin`
hierarchy that didn't match their domain, and (most painfully for you
last week) caused crashes the SDK had no graceful path through.

Stripping it out makes GUB smaller, makes your auth flow simpler, and
puts the access logic where it actually belongs.

The decision doc lives at `docs/proposals/remove-app-access-gating.md`
in the gcp-universal-backend repo. There's a Decision log section at
the bottom for traceability.

## Questions or breakage?

Ping back — happy to walk through any specific use case where you
need help mapping the old shape to the new one.
