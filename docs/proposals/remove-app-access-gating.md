# Remove app-level access gating from GUB

**Status:** Decided 2026-05-04. Implementing in this branch.
**Scope:** Architectural simplification of GUB's role. Touches GUB backend, SDK, and gub-admin.

## TL;DR

> GUB does auth, and data access, not app access.

GUB has been doing three different access checks layered on each other. We're removing the middle one — the per-user, per-app gate at `/auth/google/exchange` — because it duplicates the cryptographic check the JWT audience claim already performs, centralizes a decision that belongs at each consuming app, and creates onboarding friction with no security upside.

A consuming app's "can this user use my app?" question is the consuming app's question. GUB's answer is now: "here is the authenticated identity, and here are the org-data resources they can see — what *you* let them do with that is your call."

## What's changing

### Removed

| Artifact | Reason |
|---|---|
| `user_app_permissions` table | Its only consumers are the gate we're removing and a JWT claim we're stopping. |
| `app_access_requests` table | The request/approval flow only existed because of the gate. |
| `apps.auto_access` column | Was an escape hatch for the gate's onboarding pain; without the gate, it has no purpose. |
| `apps.is_active` column | Same — used to gate access. The audience registry doesn't need an "active" flag. |
| `checkOrProvisionAppAccess()` (`user.service.ts`) | The gate function. |
| `pending_approval` branch in `googleLogin` + `exchangeGoogleAccessToken` | The 202 response that surfaced the gate to the SDK. |
| `PendingApprovalResponse` type | No longer reachable. |
| `permissions[]` claim in JWT access tokens | App-role data sourced from the table we're dropping. Consuming apps roll their own roles. |
| `requireRole` middleware in `sdk/backend` | Gated on the JWT permissions claim we're dropping; no clean equivalent at the GUB layer. |
| `appPermission` field on `GUBRequestContext` | Same. |
| `GUBPendingApprovalError` in `sdk/frontend` | Hotfix from `6404a7a` — pre-emptive handling of a code path that no longer exists. |
| `/apps` write surface in gub-admin (autoAccess + isActive editing) | Page becomes a read-only registry view. |
| `/app-access-requests` page + API in gub-admin | No requests since no gate. |

### Kept

| Artifact | Why |
|---|---|
| `apps` table (id, appId, name, createdAt) | Useful as a registry — gives appIds friendly names in gub-admin. Not a gate. |
| `access_grants` (and the cascade machinery) | Per-resource access to GUB-owned org data. This is genuinely platform-level — the resources live on GUB, the grants enforce who sees them. |
| `isAdmin` flag on `User` | A single platform-wide bypass for org-data access. Cheap, useful. |
| `trusted_apps` registry | Cryptographic trust boundary for `/auth/google/exchange` and CORS. Different concern from app access. |
| JWT `aud` claim | Now bound to the appId the consumer requested (see below). |

### New / fixed

| Artifact | Why |
|---|---|
| `signAccessToken({ ..., audience })` | Pre-existing bug: the signer always used `config.JWT_AUDIENCE` while the SDK's verifier expected `aud === appId`. Fixed by accepting per-call audience. |
| `googleLogin` passes `audience: appId ?? config.JWT_AUDIENCE` | Tokens are now bound to the consumer they were issued for. Cheap cross-app replay defense; not a gate. |

## Threat model — what this changes, what it doesn't

### Preserved trust boundaries

- **Authentication.** Google OAuth → JWT signed by GUB's RS256 private key. Unchanged.
- **Token verification.** Consuming apps verify against GUB's published JWKS (and now the JWT's `aud` matches the appId, which the SDK helper enforces).
- **Trusted apps.** Strict same-row pairing of origin + Google client_id at `/auth/google/exchange` is unchanged. An untrusted origin or Google client_id still cannot get tokens out of GUB.
- **Org-data access.** `access_grants` checks at `/org/*` endpoints are unchanged. A user with no grants for an account/campaign/staff/team still cannot see them.
- **Admin bypass.** `isAdmin` users bypass `access_grants` exactly as before.

### What the removed gate did vs. what stops doing it

The removed gate used to answer: *"is this user allowed to use app X at all?"*

That answer is now the consuming app's responsibility. Before:

1. User signs in
2. GUB checks `user_app_permissions` for `(user, appId)`
3. If no row → 202 pending_approval, no token issued

After:

1. User signs in
2. GUB issues a JWT bound to `aud = appId`
3. Consuming app's backend reads identity from the JWT, decides on its own terms whether the user gets in

The substantive change is **where the "no" comes from**. It still comes — just from the app, on the app's terms, with the app's data, instead of from a centralized gate that didn't actually know what the app's policy was anyway. The escape hatch (`autoAccess=true`) was already a tell that the centralization wasn't earning its weight.

### Net security delta

- **No regression** in cryptographic trust. JWT signing, JWKS, audience binding, trusted_apps, all unchanged or strengthened (audience bug fixed).
- **No regression** in org-data access. `access_grants` unchanged.
- **Improvement** in implementer ergonomics. The error surface a consuming app sees from GUB is now identity-only — no opaque "your account is pending" responses that surface as crashes when the SDK doesn't handle them.

## Migration plan

Single coordinated change, three repos, three PRs:

1. **gcp-universal-backend** (this branch): migration drops the tables + columns; auth code drops the gate + fixes the audience signing; JWT stops emitting `permissions[]`. Type-check + smoke-test locally.
2. **gcp-universal-backend SDK** (same branch, separate PR): revert `PENDING_APPROVAL` hotfix; drop `requireRole` + `appPermission`; drop `permissions` from `GUBUser`; rewrite `sdk/USAGE.md` examples.
3. **gub-admin**: drop `/app-access-requests`; simplify `/apps` to read-only; remove `apps` write API; update Prisma schema.

Deploy order: backend first (so the SDK doesn't fail verification on stale-audience tokens), SDK second (consumers re-pull), admin third.

## Heads-up for the work-flows implementer

After re-pulling the SDK they get:

- No more `pending_approval` crash, no more `pending_approval` typed error to handle.
- No more `requireRole` middleware. Replace any `gub.requireRole('viewer')` with their own role logic on top of the JWT identity claims — typically a check against their own DB.
- No more `user.permissions[]` in the SDK types. The JWT carries identity (sub, email, displayName, isAdmin, iss, aud, iat, exp, jti) and that's it.

## Why we're not doing security review for this one

This is removal, not addition. We're shrinking GUB's surface area, not expanding it. The trust boundaries that used to matter (signing keys, JWKS, trusted apps, access grants) are unchanged. The team will see this in commit + this doc; if there are concerns, they're easy to raise after.

## Decision log

| Date | Topic | Decision |
|---|---|---|
| 2026-05-04 | Remove `user_app_permissions` and the `/auth/google/exchange` gate | Approved by user. "GUB does auth, and data access, not app access." |
| 2026-05-04 | Keep `apps` as thin registry | Approved by user. "The known apps is good." |
| 2026-05-04 | Stop emitting `permissions[]` JWT claim | Stop emitting (no graceful window). Only consumer is our own SDK; no third parties depend on it. |
| 2026-05-04 | Drop `requireRole` middleware | Drop hard. TypeScript error at the call site is the right kind of breakage. |
| 2026-05-04 | JWT audience signing | Sign with `aud = appId ?? config.JWT_AUDIENCE`. Pre-existing mismatch with the SDK verifier; fixing as part of this work. |
