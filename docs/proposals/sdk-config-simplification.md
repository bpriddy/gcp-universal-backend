# GUB SDK Configuration Simplification — Proposal

**Status:** Approved, ready for implementation. Security review complete (2026-05-01); decisions captured in the log at the bottom.
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

**5. Removing `GUB_AUDIENCE` shifts the audience check from explicit-arg to auto-derived.** ✅ **DECIDED — see Decisions log.**

Today: implementer's backend calls `verify({ audience: process.env.GUB_AUDIENCE })`. Two values that have to match.

Tomorrow: SDK auto-verifies `aud === GUB.appId`. One value, declared once, verified inside the SDK. The `verifyGUBToken` signature is exactly `verifyGUBToken(token: string): Promise<VerifiedClaims>` — **no `audience` parameter, no `skipAudienceCheck` flag, no "trusted audiences" array.** If a real cross-app verification need ever surfaces, it gets designed as a token-exchange endpoint at GUB (where audit + access controls live), not a runtime SDK escape hatch.

## Migration plan

Three phases, each independently shippable:

**Phase 1 — Helper + discovery (additive, no breakage).** Ship `defineGUBConfig`. Helper supports the new shape AND reads the existing env vars as fallback. Discovery doc fetched + validated. No implementer changes required; existing setups keep working.

**Phase 2 — Migrate one consuming app + document.** Migrate work-flows (the active implementer) to the new shape. Update `sdk/USAGE.md` to lead with the new shape; show the old shape under a "Migrating from <0.x>" subsection. Verify in dev. Watch for unexpected behavior over a week.

**Phase 3 — Deprecate the duplicate env vars.** Helper logs a warning when `GUB_ISSUER` / `GUB_AUDIENCE` / `VITE_GUB_URL` etc. are set (ignored but visible). Next minor SDK version: helper throws if they're set, with migration text. Eventually: drop the fallback paths entirely.

## Open questions

1. **Discovery doc validation rigor.** Beyond `issuer === GUB_URL`, what should the helper enforce? Supported algorithms, response_types_supported, etc.? (Implementation detail; team approved the consolidated shape and we'll pick conservative defaults.)
2. **Backward-compat window.** How long do we keep the duplicate-env-var fallback before deleting it? (Operational; pick during Phase 3.)

## Considered and deferred

### `gub.lock.json` lock-file pattern

**Original idea:** an implementer-side file pinning GUB's JWKS thumbprints, checked on every JWKS fetch. Any mid-flight change to GUB's keys would loudly fail verification on the implementer side.

**Decision: defer indefinitely.** The threat model and operational risk profile is essentially HPKP-for-JWKS, and the industry deprecated HPKP for these reasons:

- The narrow attack it defends against — substitution of GUB's JWKS at the network layer, where the attacker can't compromise GUB itself — is exotic given HTTPS + certificate transparency.
- Operational cost is paid continuously: every GUB signing-key rotation requires every implementer to re-lock and ship, with the failure mode being "auth broken in prod until they notice." HPKP's death was driven by exactly these rotation outages.
- For our shape (small set of internal implementers, GUB owns signing keys and the per-request access control, implementers' apps mostly read data from GUB rather than relying on local trust in token claims), the lock file's expected value is below the maintenance cost.
- The security team's framing was that the lock file's job is to defend JWKS authenticity specifically, with explicit acknowledgment that **GUB's per-request access control is the deepest defense**. That framing argues for spending engineering time on tightening GUB-side controls, not adding implementer-side ceremony.

**What we're doing instead:**
- Tightening discovery-doc validation (HTTPS-only, `issuer === GUB_URL`, fail-closed on fetch failure).
- Adding GUB-side operational monitoring on JWKS changes that aren't part of a planned rotation — catches the realistic compromise scenario from where it actually belongs.
- Documenting the trust model clearly so implementers understand HTTPS + discovery validation is the boundary; no false sense of security.

**Conditions to revisit:** if we onboard external implementers we don't operationally control (third parties, paying customers), or if a real JWKS-substitution incident surfaces in threat reporting.

## Out of scope

- Changes to the trusted apps registry, strict same-row pairing, or `/auth/google/exchange` contract.
- Changes to JWT signing keys, rotation, or JWKS shape.
- Refresh-token flow.
- Production CORS / edge enforcement (separate prod-environment design).

## Asks for the security team

All resolved — see Decisions log.

1. ~~Sign off on the consolidated config shape.~~ ✅
2. ~~Fail-closed vs. fail-open at SDK startup if discovery can't be fetched.~~ ✅
3. ~~Caching strategy.~~ ✅
4. ~~Confirm `app_id`-as-code-constant is acceptable.~~ ✅
5. ~~Confirm SDK auto-verifying `aud === appId` is acceptable.~~ ✅
6. ~~Lock-file pattern.~~ ⛔ Deferred — see "Considered and deferred."

## Decisions log

| Date | Topic | Decision | Source |
|---|---|---|---|
| 2026-05-01 | Consolidated config shape | Approved. Two env vars (`GUB_URL`, `GOOGLE_CLIENT_ID`) + one code constant (`appId`). Helper `defineGUBConfig` resolves framework prefix variants and fetches the discovery doc lazily. | Security team |
| 2026-05-01 | Startup failure mode | Fail closed. If the SDK can't fetch + validate the discovery doc at first use, it refuses to verify tokens and surfaces a loud error. Retries with backoff during the fetch attempt itself; never silently degrades. | Security team |
| 2026-05-01 | Caching strategy | In-memory only. Discovery doc + JWKS are refetched on cold start; no on-disk cache (a tampered cache would become the trust anchor). | Security team |
| 2026-05-01 | `app_id` as code constant | Approved. `app_id` is identity, not credential — source-repo visibility is fine. Putting it in code prevents per-environment drift. | Security team |
| 2026-05-01 | Audience verification API | `verifyGUBToken(token)` is the entire signature. Audience verification is baked in against `GUB.appId`. **No `audience` parameter, no `skipAudienceCheck` flag, no "trusted audiences" array.** Future cross-app verification needs get designed as a GUB-side token-exchange endpoint, not a runtime SDK escape hatch. | Security team recommendation |
| 2026-05-01 | Lock-file pattern (`gub.lock.json`) | **Deferred indefinitely.** Same shape and operational risk as HPKP, which the industry deprecated. Threat model doesn't fit our setup; engineering time better spent tightening GUB-side controls (discovery validation, JWKS-change monitoring). Revisit if external implementers or a real incident surface. See "Considered and deferred" for full reasoning. | Discussion w/ security team |
