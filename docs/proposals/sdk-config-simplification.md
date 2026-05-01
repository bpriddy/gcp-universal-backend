# GUB SDK Configuration Simplification — Proposal

**Status:** Proposal, not yet implemented. Seeking security review before code changes.
**Scope:** SDK ergonomics for consuming apps. **No changes to the GUB trust model.**

## TL;DR

Today an implementer sets up to **6 environment variables** to consume GUB. Three of them carry the same string. One (`GUB_AUDIENCE`) is a value they shouldn't be choosing at all. We propose collapsing the implementer-supplied surface to **2 env vars + 1 code constant**, with everything else derived from GUB's existing `/.well-known/oauth-authorization-server` discovery document.

The signing keys, JWKS, trusted apps registry, strict same-row pairing, and audit logging all continue to work exactly as they do today.

## Current state

What an implementer types today:

```env
GUB_URL=https://gub-dev.example.com
VITE_GUB_URL=https://gub-dev.example.com         # build-tool prefix forces duplication
GUB_ISSUER=https://gub-dev.example.com           # same value, different name
GUB_AUDIENCE=https://gub-dev.example.com         # same value again
GOOGLE_CLIENT_ID=12345-abc.apps.googleusercontent.com
VITE_GOOGLE_CLIENT_ID=12345-abc.apps.googleusercontent.com
```

Plus `APP_ID` set somewhere (treated as another env var by some implementers).

### Three failure modes this creates

1. **Repetition.** The same string declared up to 4 times. Drift across them produces auth failures whose root cause is impossible to spot from any single error message.
2. **Implementer-typed values that already live in our discovery doc.** GUB serves `/.well-known/oauth-authorization-server` with issuer, JWKS URI, supported flows. Implementers shouldn't be re-typing these.
3. **Env-varring identity, not just config.** `app_id` is a stable string an app picks once; it does not vary across dev / staging / prod. Putting it in env invites it to drift.

## Proposed target state

### What an implementer types

```env
GUB_URL=https://gub-dev.example.com
GOOGLE_CLIENT_ID=12345-abc.apps.googleusercontent.com
```

### What an implementer declares once in code

```ts
// gub.config.ts
import { defineGUBConfig } from 'gcp-universal-backend/sdk';

export const GUB = defineGUBConfig({
  url:            envOrThrow('GUB_URL'),
  googleClientId: envOrThrow('GOOGLE_CLIENT_ID'),
  appId:          'workflows-dashboard',   // identity, not config
});
```

Both the implementer's frontend and backend import `GUB` from this single file. The helper:

- Resolves `VITE_*` / `NEXT_PUBLIC_*` / `REACT_APP_*` prefix variants automatically (one canonical name; helper handles framework conventions).
- Lazily fetches `${GUB_URL}/.well-known/oauth-authorization-server` on first use.
- Validates `discovery.issuer === GUB_URL` at startup; throws loudly on mismatch (catches typos before any auth call).
- Exposes typed accessors: `GUB.issuer`, `GUB.jwksUri`, `GUB.appId`, etc.

### What gets eliminated

| Variable | Why it goes away |
|---|---|
| `GUB_ISSUER` | Equals `GUB_URL`. Derived. |
| `GUB_AUDIENCE` | Token's `aud` is `appId`. Derived. |
| `VITE_*` / `NEXT_PUBLIC_*` duplicates | Helper resolves prefix variants. Implementer sets one canonical name. |

## Security review — what's preserved, what changes, where to push back

### Preserved (unchanged trust boundaries)

- JWT signing — same RS256 private key in Secret Manager, same rotation policy.
- JWKS distribution — same `/.well-known/jwks.json`, same caching semantics.
- Trusted apps registry — strict same-row pairing of origin + Google client_id at `/auth/google/exchange` is unchanged.
- Audit logging — all `trusted_apps`/`oauth_clients` writes still attribute to an actor via the IAP identity.
- Discovery doc itself — already exists, already served, no new endpoint. The change is that the SDK consumes it instead of asking implementers to retype the values.

### Changes that warrant review

**1. `GUB_URL` becomes a single critical anchor.**

Today an implementer can typo `GUB_ISSUER` and the typo gets caught at JWT verification time (mismatch). After the change, `GUB_URL` is the one anchor. If an implementer typos it to a domain an attacker controls, they fetch the attacker's discovery doc, the attacker's JWKS, and attacker-signed tokens verify as valid.

*Mitigation:* helper validates `discovery.issuer === GUB_URL` at startup. The attack now requires (a) the implementer to typo to an attacker-controlled domain AND (b) the attacker to serve a discovery doc whose `issuer` claim matches that typo — a much more deliberate setup than today's "implementer didn't update one of four duplicate env vars."

**Question for the team:** Is a single anchor with discovery validation acceptable? Or do you want `GUB_ISSUER` retained as a redundant backstop the helper cross-checks?

**2. Discovery doc fetched at SDK init.**

Adds a network call on app startup. Failure modes:

- **Network failure:** SDK can't fetch discovery → can't verify tokens. Proposed: fail loudly, retry on backoff, never silently degrade.
- **Slow GUB:** Implementer's startup is slow. Proposed: 5s timeout, then loud failure.
- **MITM on the implementer's network:** HTTPS protects against tampering; helper rejects non-`https://` URLs except for loopback.

**Question for the team:** Cache discovery on disk between app starts (faster cold start, but a tampered cache becomes the trust anchor) or always fetch fresh?

**3. `app_id` becomes a code constant, not an env var.**

Net security-positive: prevents per-environment drift (dev's `app_id` accidentally matching prod's), and removes a class of "I forgot to update the env var when promoting" bugs. But it does mean `app_id` is visible in source repos.

`app_id` is **identity, not credential** — knowing one doesn't let you mint tokens for it. Source visibility is fine. Worth stating explicitly so an implementer doesn't treat it as a secret.

**4. Helper convenience could become blast radius.**

`defineGUBConfig` is a thin wrapper but every implementer routes through it. A bug in the helper (e.g., accepting `http://`, misparsing the discovery doc) hits every consuming app at once.

*Mitigation:* keep the helper minimal — URL validation, env-prefix resolution, discovery fetch + validate. No clever logic. Test exhaustively. Pin SDK version per consuming app.

**5. Removing `GUB_AUDIENCE` shifts the audience check from explicit-arg to auto-derived.**

Today: implementer's backend calls `verify({ audience: process.env.GUB_AUDIENCE })`. Two values that have to match.

Tomorrow: SDK auto-verifies `aud === GUB.appId`. One value, declared once, verified inside the SDK.

This is **net more secure** — fewer typo paths, harder to forget passing `audience`. But it shifts responsibility from "implementer types the right value" to "SDK applies the right check." If you'd rather preserve the explicitness, we keep `audience` as a required arg to `verifyGUBToken({ audience })` and just stop env-varring it.

## Migration plan

Three phases, each independently shippable:

**Phase 1 — Helper + discovery (additive, no breakage).** Ship `defineGUBConfig`. Helper supports the new shape AND reads the existing env vars as fallback. Discovery doc fetched + validated. No implementer changes required; existing setups keep working.

**Phase 2 — Migrate one consuming app + document.** Migrate work-flows (the active implementer) to the new shape. Update `sdk/USAGE.md` to lead with the new shape; show the old shape under a "Migrating from <0.x>" subsection. Verify in dev. Watch for unexpected behavior over a week.

**Phase 3 — Deprecate the duplicate env vars.** Helper logs a warning when `GUB_ISSUER` / `GUB_AUDIENCE` / `VITE_GUB_URL` etc. are set (ignored but visible). Next minor SDK version: helper throws if they're set, with migration text. Eventually: drop the fallback paths entirely.

## Open questions

1. **Discovery doc validation rigor.** Beyond `issuer === GUB_URL`, what should the helper enforce? Supported algorithms, response_types_supported, etc.?
2. **Caching strategy.** In-memory only, or also disk? TTL?
3. **Failure mode at startup.** Fail closed (refuse to boot) vs. fail open with loud warning + auth disabled?
4. **Backward-compat window.** How long do we keep the duplicate-env-var fallback before deleting it?
5. **Lock-file pattern?** A `gub.lock.json` checked into the implementer's repo containing the resolved discovery doc + GUB key fingerprints. Any mid-flight change to GUB's discovery would loudly fail verification on the implementer side. Probably overkill for current trust model, but worth flagging.

## Out of scope

- Changes to the trusted apps registry, strict same-row pairing, or `/auth/google/exchange` contract.
- Changes to JWT signing keys, rotation, or JWKS shape.
- Refresh-token flow.
- Production CORS / edge enforcement (separate prod-environment design).

## Asks for the security team

1. Sign off (or push back) on the consolidated config shape.
2. Decide between fail-closed and fail-open at SDK startup if discovery can't be fetched.
3. Decide on the caching strategy.
4. Confirm `app_id`-as-code-constant is acceptable (identity, not credential).
5. Confirm SDK auto-verifying `aud === appId` is acceptable in place of implementer-typed `GUB_AUDIENCE`.
