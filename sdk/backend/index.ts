/**
 * GUB Backend SDK
 *
 * Vanilla Node.js SDK for the GCP Universal Backend.
 * Works with Express, Fastify, raw http, or any Node framework.
 *
 * Install:
 *   npm install github:bpriddy/gcp-universal-backend
 *
 * Usage (new shape — recommended):
 *   import { defineGUBConfig } from 'gcp-universal-backend/sdk/config'
 *   import { createGUBClient } from 'gcp-universal-backend/sdk/backend'
 *
 *   const GUB = defineGUBConfig({
 *     url:            process.env.GUB_URL!,
 *     googleClientId: process.env.GOOGLE_CLIENT_ID!,
 *     appId:          'workflows-dashboard',
 *   });
 *   export const gub = createGUBClient(GUB);
 *
 * Legacy shape still accepted (deprecation warning logged):
 *   createGUBClient({ gubUrl, issuer, audience })
 *
 * Migration: see sdk/USAGE.md "Migrating from <0.x>".
 */

import { createRemoteJWKSet, errors as joseErrors, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { defineGUBConfig, type GUBConfig, type GUBConfigInput } from '../config';

// ── Types ──────────────────────────────────────────────────────────────────

/**
 * Decoded GUB JWT payload.
 *
 * Note (2026-05-04): the `permissions` field was removed. App-level
 * authorization belongs in each consuming app, not in GUB-issued tokens.
 * Implementers needing role/permission gating should source those from
 * their own backend on top of the JWT identity claims. See
 * docs/proposals/remove-app-access-gating.md.
 */
export interface GUBTokenPayload {
  /** User UUID — users.id in the GUB database */
  sub: string;
  email: string;
  displayName: string | null;
  /** Superuser flag — bypasses all access_grants checks on GUB's own org-data API */
  isAdmin: boolean;
  iss: string;
  /**
   * Multi-audience: includes both `gub.appId` (for the consumer's verifier)
   * and `JWT_AUDIENCE` (so the consumer's `gub.org()` server-to-server
   * calls back to GUB still pass GUB's verifier).
   */
  aud: string | string[];
  iat: number;
  exp: number;
  jti: string;
}

/**
 * @deprecated Use `defineGUBConfig({ url, googleClientId, appId })` and
 * pass the result to `createGUBClient` instead. This shape will be
 * removed in a future major version. See sdk/USAGE.md.
 */
export interface GUBClientConfig {
  /** GUB backend URL — e.g. https://gub.yourdomain.com */
  gubUrl: string;
  /** Must match JWT_ISSUER env var on the GUB server */
  issuer: string;
  /** Must match JWT_AUDIENCE env var on the GUB server */
  audience: string;
}

// Minimal framework-agnostic request/response types
// Compatible with Express, Fastify, and raw http.IncomingMessage
export interface GUBRequest {
  headers: Record<string, string | string[] | undefined>;
  [key: string]: unknown;
}
export interface GUBResponse {
  status: (code: number) => GUBResponse;
  json: (body: unknown) => void;
}
export type GUBNextFunction = (err?: unknown) => void;

/** Attached to req.gub after successful JWT verification */
export interface GUBRequestContext {
  user: GUBTokenPayload;
}

// ── Org data types ─────────────────────────────────────────────────────────
// Mirror of the shapes returned by GUB's /org/* endpoints.

export interface GUBAccountCurrentState {
  [property: string]: string | null;
}

export interface GUBAccount {
  id: string;
  name: string;
  parentId: string | null;
  /** Resolved current state from account_changes EAV log */
  currentState: GUBAccountCurrentState;
  createdAt: string;
  updatedAt: string;
}

export interface GUBCampaign {
  id: string;
  accountId: string;
  name: string;
  status: string;
  /** Serialized as string to preserve decimal precision — parse with a decimal library */
  budget: string | null;
  assetsUrl: string | null;
  awardedAt: string | null;
  liveAt: string | null;
  endsAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GUBStaff {
  id: string;
  fullName: string;
  email: string;
  title: string | null;
  department: string | null;
  status: string;
  startedAt: string;
  endedAt: string | null;
}

export interface GUBOfficeCurrentState {
  [property: string]: string | null;
}

export interface GUBOffice {
  id: string;
  name: string;
  syncCity: string | null;
  isActive: boolean;
  startedAt: string | null;
  /** Resolved current state from office_changes */
  currentState: GUBOfficeCurrentState;
  createdAt: string;
  updatedAt: string;
}

export interface GUBTeamCurrentState {
  [property: string]: string | null;
}

export interface GUBTeamMember {
  staffId: string;
  fullName: string;
  email: string;
  title: string | null;
}

export interface GUBTeam {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
  startedAt: string | null;
  members: GUBTeamMember[];
  /** Resolved current state from team_changes */
  currentState: GUBTeamCurrentState;
  createdAt: string;
  updatedAt: string;
}

/**
 * A GUB user record — the Google OAuth identity (distinct from Staff, which
 * is the employment-side record). Users may exist without a Staff profile
 * and vice versa.
 *
 * Sensitive fields (googleSub, refresh tokens, external ids) are
 * deliberately NOT exposed here.
 */
export interface GUBUserRecord {
  id: string;
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
  role: string;
  isAdmin: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

// ── Verification error classification ─────────────────────────────────────

/**
 * Map a verifyToken failure to a structured response. The point is to
 * preserve jose's typed errors instead of flattening every failure to a
 * generic "INVALID_TOKEN" — consumers (and platform observability) can
 * then tell user-recoverable failures (expired token, refresh fixes it)
 * apart from real attack signals (signature mismatch) apart from
 * availability issues (JWKS fetch timeout).
 *
 * Codes mirror RFC 7519 / 7515 vocabulary where there's a clean fit, and
 * fall back to 'INVALID_TOKEN' for anything we don't recognize. Status
 * is always 401 today; that may evolve (e.g. JWKS_FETCH_TIMEOUT could
 * arguably be 503).
 */
interface VerifyErrorClassification {
  code: string;
  status: number;
  message: string;
}

function classifyVerifyError(err: unknown): VerifyErrorClassification {
  const message = err instanceof Error ? err.message : 'Invalid token';

  if (err instanceof joseErrors.JWTExpired) {
    // User-recoverable: a fresh token from refresh will work. The SDK
    // frontend's silent refresh handles this automatically; consumers
    // who roll their own auth can branch on this code.
    return { code: 'TOKEN_EXPIRED', status: 401, message };
  }

  if (err instanceof joseErrors.JWTClaimValidationFailed) {
    // Issuer mismatch (wrong GUB instance), audience mismatch (config
    // drift between frontend and backend appId), or some other claim
    // check failed. The `claim` and `reason` fields on the jose error
    // pinpoint which one. Distinct from signature failure, which is a
    // genuine attack signal.
    const claim = (err as { claim?: string }).claim;
    return {
      code: 'CLAIM_INVALID',
      status: 401,
      message: claim ? `Claim '${claim}' validation failed: ${message}` : message,
    };
  }

  if (err instanceof joseErrors.JWSSignatureVerificationFailed) {
    // Signature didn't verify against any key in the JWKS. Either the
    // token wasn't signed by GUB (forgery attempt) or by a key whose
    // rotation hasn't reached this consumer's JWKS cache yet. Worth
    // logging at WARN+ in consuming apps' observability.
    return { code: 'SIGNATURE_INVALID', status: 401, message };
  }

  if (err instanceof joseErrors.JWKSNoMatchingKey) {
    // Token's `kid` doesn't match any key in JWKS. Usually a key
    // rotation lag — the JWKS cache (10 min) hasn't picked up the new
    // key yet. Should self-resolve on retry after cache TTL.
    return { code: 'KEY_NOT_FOUND', status: 401, message };
  }

  if (err instanceof joseErrors.JWKSTimeout) {
    // GUB's JWKS endpoint didn't respond. Availability issue at GUB or
    // the network path. Distinct from a token issue.
    return { code: 'JWKS_FETCH_TIMEOUT', status: 401, message };
  }

  if (err instanceof joseErrors.JWTInvalid || err instanceof joseErrors.JWSInvalid) {
    // Token isn't a syntactically valid JWT/JWS. Almost always a bug
    // (sending the wrong header, double-Bearer prefix, etc.) rather
    // than an attack.
    return { code: 'TOKEN_MALFORMED', status: 401, message };
  }

  if (err instanceof joseErrors.JOSEError) {
    // Catch-all for jose errors not specifically handled above
    // (JOSEAlgNotAllowed, JWKSInvalid, etc.). Surface the jose error
    // code as our code prefix so triage stays specific.
    return {
      code: `JOSE_${(err as { code?: string }).code ?? 'ERROR'}`,
      status: 401,
      message,
    };
  }

  // Non-jose throw (network failure during JWKS fetch, etc.). Keep
  // the generic INVALID_TOKEN for backward compatibility.
  return { code: 'INVALID_TOKEN', status: 401, message };
}

// ── GUB Client factory ─────────────────────────────────────────────────────

/**
 * Create a GUB client for your backend service.
 * Call once at startup and import the result wherever needed.
 *
 * Three input shapes are accepted:
 *
 *   1. A {@link GUBConfig} from `defineGUBConfig({ url, googleClientId, appId })`.
 *      Recommended. Issuer + JWKS URI are discovered from GUB; audience is
 *      pinned to `appId` with no override.
 *
 *   2. The raw {@link GUBConfigInput} — the same `{ url, googleClientId, appId }`
 *      shape `defineGUBConfig` takes. Convenience for callers who don't
 *      need to use the config object elsewhere.
 *
 *   3. The legacy `{ gubUrl, issuer, audience }` shape, accepted with a
 *      deprecation warning. Will be removed in a future major version.
 *
 * @example
 *   // Recommended:
 *   import { defineGUBConfig } from 'gcp-universal-backend/sdk/config';
 *   import { createGUBClient } from 'gcp-universal-backend/sdk/backend';
 *
 *   const GUB = defineGUBConfig({
 *     url:            process.env.GUB_URL!,
 *     googleClientId: process.env.GOOGLE_CLIENT_ID!,
 *     appId:          'workflows-dashboard',
 *   });
 *   export const gub = createGUBClient(GUB);
 */
export function createGUBClient(config: GUBConfig | GUBConfigInput | GUBClientConfig) {
  const gub = normalizeConfig(config);
  const baseUrl = gub.url;

  // JWKS construction is lazy — needs the discovery doc to know jwks_uri.
  // First verifyToken call triggers discovery fetch + JWKS init; reused
  // for every subsequent verification.
  let jwksGetter: JWTVerifyGetKey | null = null;
  async function getJwksGetter(): Promise<JWTVerifyGetKey> {
    if (!jwksGetter) {
      const jwksUri = await gub.getJwksUri();
      jwksGetter = createRemoteJWKSet(new URL(jwksUri), { cacheMaxAge: 10 * 60 * 1000 });
    }
    return jwksGetter;
  }

  // ── Token verification ───────────────────────────────────────────────────

  /**
   * Verify a JWT and return its typed payload.
   *
   * Audience verification is **baked in** against `gub.appId` — there is
   * no `audience` parameter, no `skipAudienceCheck` flag, no "trusted
   * audiences" array. If a real cross-app verification need surfaces,
   * design a token-exchange endpoint at GUB rather than reaching for a
   * runtime SDK escape hatch.
   *
   * @example
   *   const payload = await gub.verifyToken(token)
   *   console.log(payload.email, payload.isAdmin)
   */
  async function verifyToken(token: string): Promise<GUBTokenPayload> {
    const issuer = await gub.getIssuer();
    const jwks = await getJwksGetter();
    const { payload } = await jwtVerify(token, jwks, {
      issuer,
      audience: gub.appId,
      algorithms: ['RS256'],
    });
    return payload as unknown as GUBTokenPayload;
  }

  // ── Middleware ───────────────────────────────────────────────────────────

  /**
   * Express/Connect middleware that verifies the Bearer JWT and attaches
   * `req.gub = { user }` for use in route handlers.
   *
   * Note (2026-05-04): the previous `appPermission` field on the context
   * was removed along with the per-app authorization gate at GUB. App-
   * level "can this user use my app?" decisions now belong in your own
   * app — typically as a check on `req.gub.user` against your own DB.
   * See docs/proposals/remove-app-access-gating.md.
   *
   * @example
   *   app.use(gub.middleware())
   *   app.get('/me', (req, res) => res.json(req.gub.user))
   */
  function middleware() {
    return async function gubMiddleware(
      req: GUBRequest,
      res: GUBResponse,
      next: GUBNextFunction,
    ): Promise<void> {
      const authHeader = req.headers['authorization'];
      const token =
        typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
          ? authHeader.slice(7)
          : null;

      if (!token) {
        res.status(401).json({ code: 'MISSING_TOKEN', error: 'Authorization: Bearer <token> required' });
        return;
      }

      try {
        const user = await verifyToken(token);
        (req as GUBRequest & { gub: GUBRequestContext }).gub = { user };
        next();
      } catch (err) {
        // Preserve jose's typed error so consumers (and observability)
        // can distinguish recoverable failures (expired token → trigger
        // refresh) from real signals (signature mismatch → possible
        // attack) from availability issues (JWKS fetch timeout).
        const { code, status, message } = classifyVerifyError(err);
        res.status(status).json({ code, error: message });
      }
    };
  }

  // requireRole was here. Removed (2026-05-04): no per-app role data
  // lives in GUB JWTs anymore. Implementers needing role-tier gating
  // should source roles from their own DB on top of req.gub.user
  // (identity) and write a thin middleware in their own codebase. See
  // docs/proposals/remove-app-access-gating.md.

  // ── Org data client ──────────────────────────────────────────────────────
  // Server-to-server calls to GUB for org data (accounts, campaigns, staff).
  // Pass the user's access token so GUB scopes results to their grants.

  /**
   * Create an org data client scoped to a user's access token.
   *
   * @example
   * app.get('/dashboard', gub.middleware(), async (req, res) => {
   *   const token = req.headers.authorization.split(' ')[1]
   *   const org = gub.org(token)
   *   const accounts = await org.listAccounts()
   *   res.json({ accounts })
   * })
   */
  function org(accessToken: string) {
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    };

    async function get<T>(path: string): Promise<T> {
      const res = await fetch(`${baseUrl}${path}`, { headers });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { message?: string };
        throw new Error(err.message ?? `GUB request failed: ${res.status} ${path}`);
      }
      return res.json() as Promise<T>;
    }

    return {
      // ── Accounts ────────────────────────────────────────────────────────
      /** List all accounts the user has access to */
      listAccounts: () =>
        get<GUBAccount[]>('/org/accounts'),

      /** Fetch a single account by ID */
      getAccount: (id: string) =>
        get<GUBAccount>(`/org/accounts/${id}`),

      // ── Campaigns ───────────────────────────────────────────────────────
      /**
       * List every campaign the user can see — across all accounts.
       *
       * Gated by `campaign` access_grants (admin bypasses). This endpoint
       * intentionally does NOT require account access: a user can have a
       * direct campaign grant without having access to the parent account,
       * and that access should still be visible here.
       *
       * For by-account filtering, filter on `.accountId` client-side:
       *   const campaigns = (await org.listCampaigns()).filter(c => c.accountId === id)
       *
       * There is a separate backend endpoint (`/org/accounts/:id/campaigns`)
       * that lists campaigns *within* an account — it requires account
       * access by design. If you want that semantic, hit it directly; the
       * SDK doesn't wrap it to avoid implying it's the default "list
       * campaigns" path.
       */
      listCampaigns: (opts?: { status?: string }) => {
        const qs = opts?.status ? `?status=${encodeURIComponent(opts.status)}` : '';
        return get<GUBCampaign[]>(`/org/campaigns${qs}`);
      },

      /** Fetch a single campaign by ID */
      getCampaign: (id: string) =>
        get<GUBCampaign>(`/org/campaigns/${id}`),

      // ── Offices ─────────────────────────────────────────────────────────
      /**
       * List offices the user has access to.
       * Returns `[]` if the user has no `office_all` / `office_active` /
       * per-office grants — this is not an error, just an empty result.
       * Pass `{ activeOnly: true }` to filter server-side to `is_active=true`.
       */
      listOffices: (opts?: { activeOnly?: boolean }) => {
        const qs = opts?.activeOnly ? '?activeOnly=true' : '';
        return get<GUBOffice[]>(`/org/offices${qs}`);
      },

      /** Fetch a single office by ID. Throws if the caller lacks access. */
      getOffice: (id: string) =>
        get<GUBOffice>(`/org/offices/${id}`),

      // ── Teams ───────────────────────────────────────────────────────────
      /**
       * List teams the user has access to (with members).
       * Returns `[]` if the user has no `team_all` / `team_active` / per-team
       * grants — same semantics as `listOffices`.
       */
      listTeams: (opts?: { activeOnly?: boolean }) => {
        const qs = opts?.activeOnly ? '?activeOnly=true' : '';
        return get<GUBTeam[]>(`/org/teams${qs}`);
      },

      /** Fetch a single team by ID (with members). */
      getTeam: (id: string) =>
        get<GUBTeam>(`/org/teams/${id}`),

      // ── Staff ───────────────────────────────────────────────────────────
      /** List active staff members. Pass `{ all: true }` to include former staff. */
      listStaff: (opts?: { all?: boolean }) =>
        get<GUBStaff[]>(`/org/staff${opts?.all ? '?all=true' : ''}`),

      /** Fetch a single staff member by ID */
      getStaffMember: (id: string) =>
        get<GUBStaff>(`/org/staff/${id}`),

      // ── Users (GUB identities) ─────────────────────────────────────────
      /**
       * List GUB user records. Admin-only — throws for non-admin callers.
       * Note: this is the OAuth-identity table, distinct from Staff.
       */
      listUsers: (opts?: { activeOnly?: boolean }) => {
        const qs = opts?.activeOnly ? '?activeOnly=true' : '';
        return get<GUBUserRecord[]>(`/org/users${qs}`);
      },

      /**
       * Fetch a user record by ID.
       * Admin can fetch any user; non-admins can only fetch themselves.
       */
      getUser: (id: string) =>
        get<GUBUserRecord>(`/org/users/${id}`),
    };
  }

  return { verifyToken, middleware, org };
}

// ── Config normalization ───────────────────────────────────────────────────

/**
 * Accept any of the three input shapes and return a canonical {@link GUBConfig}.
 * Centralizes the legacy-shape detection + deprecation warning so the
 * verifyToken / middleware code paths only ever see the new shape.
 */
function normalizeConfig(
  input: GUBConfig | GUBConfigInput | GUBClientConfig,
): GUBConfig {
  // Already a GUBConfig (from defineGUBConfig). Both legacy and input
  // shapes lack the `getDiscovery` method, so this is a reliable check.
  if (typeof (input as GUBConfig).getDiscovery === 'function') {
    return input as GUBConfig;
  }

  // Legacy shape: { gubUrl, issuer, audience }. We've kept supporting it
  // for one release so existing implementers don't break on upgrade,
  // but it's deprecated and will be removed in a future major version.
  if ('gubUrl' in input) {
    const legacy = input as GUBClientConfig;
    // eslint-disable-next-line no-console
    console.warn(
      '[gub-sdk] createGUBClient({ gubUrl, issuer, audience }) is deprecated. ' +
        'Use defineGUBConfig({ url, googleClientId, appId }) and pass the ' +
        'result to createGUBClient. See sdk/USAGE.md "Migrating from <0.x>".',
    );
    // We don't have a googleClientId in the legacy shape — synthesize a
    // placeholder. It's only used by the frontend SDK; backends never
    // reference it. The `audience` field becomes the `appId` since
    // historically that's how implementers used it.
    return defineGUBConfig({
      url: legacy.gubUrl,
      googleClientId: '0-deprecated.apps.googleusercontent.com',
      appId: legacy.audience,
    });
  }

  // Raw input shape: { url, googleClientId, appId }. Wrap it.
  return defineGUBConfig(input as GUBConfigInput);
}

// Re-export defineGUBConfig + types so backend consumers can import
// everything they need from one path if they prefer.
export { defineGUBConfig } from '../config';
export type { GUBConfig, GUBConfigInput, DiscoveryDoc, GUBConfigError } from '../config';

// ── Express type augmentation ──────────────────────────────────────────────
// Add this to your project's type declarations to get req.gub typed:
//
// declare global {
//   namespace Express {
//     interface Request {
//       gub: import('gcp-universal-backend/sdk/backend').GUBRequestContext
//     }
//   }
// }
