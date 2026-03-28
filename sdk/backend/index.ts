/**
 * GUB Backend SDK
 *
 * Vanilla Node.js SDK for the GCP Universal Backend.
 * Works with Express, Fastify, raw http, or any Node framework.
 *
 * Install:
 *   npm install github:bpriddy/gcp-universal-backend
 *
 * Usage:
 *   import { createGUBClient } from 'gcp-universal-backend/sdk/backend'
 */

import { createRemoteJWKSet, jwtVerify } from 'jose';

// ── Types ──────────────────────────────────────────────────────────────────

export interface TokenPermission {
  appId: string;
  dbIdentifier: string;
  role: string;
}

export interface GUBTokenPayload {
  /** User UUID — users.id in the GUB database */
  sub: string;
  email: string;
  displayName: string | null;
  /** Superuser flag — bypasses all access_grants checks on GUB */
  isAdmin: boolean;
  permissions: TokenPermission[];
  iss: string;
  aud: string | string[];
  iat: number;
  exp: number;
  jti: string;
}

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
  /** Permission entry for the app this backend serves, if present */
  appPermission: TokenPermission | undefined;
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

// ── Role ranking ───────────────────────────────────────────────────────────

const ROLE_RANK: Record<string, number> = {
  viewer: 0,
  contributor: 1,
  manager: 2,
  admin: 3,
};

type Role = 'viewer' | 'contributor' | 'manager' | 'admin';

// ── GUB Client factory ─────────────────────────────────────────────────────

/**
 * Create a GUB client for your backend service.
 * Call once at startup and import the result wherever needed.
 *
 * @example
 * // gub.ts
 * import { createGUBClient } from 'gcp-universal-backend/sdk/backend'
 *
 * export const gub = createGUBClient({
 *   gubUrl:   process.env.GUB_URL!,
 *   issuer:   process.env.GUB_ISSUER!,
 *   audience: process.env.GUB_AUDIENCE!,
 * })
 */
export function createGUBClient(config: GUBClientConfig) {
  const { gubUrl, issuer, audience } = config;
  const baseUrl = gubUrl.replace(/\/$/, '');

  // JWKS fetched from GUB's standard discovery endpoint and cached locally.
  // Auto-refreshes when the key rotates — no manual intervention needed.
  const JWKS = createRemoteJWKSet(
    new URL(`${baseUrl}/.well-known/jwks.json`),
    { cacheMaxAge: 10 * 60 * 1000 }, // 10 minutes
  );

  // ── Token verification ───────────────────────────────────────────────────

  /**
   * Verify a JWT and return its typed payload.
   * Use this for programmatic access when middleware is not appropriate.
   *
   * @example
   * const payload = await gub.verifyToken(token)
   * console.log(payload.email, payload.isAdmin)
   */
  async function verifyToken(token: string): Promise<GUBTokenPayload> {
    const { payload } = await jwtVerify(token, JWKS, {
      issuer,
      audience,
      algorithms: ['RS256'],
    });
    return payload as unknown as GUBTokenPayload;
  }

  // ── Middleware ───────────────────────────────────────────────────────────

  /**
   * Express/Connect middleware that verifies the Bearer JWT and attaches
   * req.gub = { user, appPermission } for use in route handlers.
   *
   * @example
   * // Protect all routes
   * app.use(gub.middleware())
   *
   * // Protect a single route and scope to a specific app
   * app.get('/data', gub.middleware('my-app-id'), handler)
   */
  function middleware(appId?: string) {
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
        const resolvedAppId = appId ?? audience;

        (req as GUBRequest & { gub: GUBRequestContext }).gub = {
          user,
          appPermission: user.permissions.find((p) => p.appId === resolvedAppId),
        };

        next();
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Invalid token';
        res.status(401).json({ code: 'INVALID_TOKEN', error: message });
      }
    };
  }

  // ── Role gate ────────────────────────────────────────────────────────────

  /**
   * Require a minimum role. Must be used after gub.middleware().
   * isAdmin users bypass all role checks.
   *
   * Role order: viewer < contributor < manager < admin
   *
   * @example
   * app.get('/reports',    gub.requireRole('viewer'),      handler)
   * app.post('/campaigns', gub.requireRole('contributor'), handler)
   * app.delete('/data',    gub.requireRole('admin'),       handler)
   */
  function requireRole(minimumRole: Role) {
    return function roleMiddleware(
      req: GUBRequest,
      res: GUBResponse,
      next: GUBNextFunction,
    ): void {
      const ctx = (req as GUBRequest & { gub?: GUBRequestContext }).gub;

      if (!ctx) {
        res.status(401).json({ code: 'UNAUTHORIZED', error: 'Not authenticated' });
        return;
      }

      // Admins bypass all role checks
      if (ctx.user.isAdmin) {
        next();
        return;
      }

      if (!ctx.appPermission) {
        res.status(403).json({ code: 'NO_APP_PERMISSION', error: 'No permission for this application' });
        return;
      }

      const userRank = ROLE_RANK[ctx.appPermission.role] ?? -1;
      const requiredRank = ROLE_RANK[minimumRole];

      if (userRank < requiredRank) {
        res.status(403).json({
          code: 'INSUFFICIENT_ROLE',
          error: `Requires '${minimumRole}' role or higher`,
        });
        return;
      }

      next();
    };
  }

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
      /** List all accounts the user has access to */
      listAccounts: () =>
        get<GUBAccount[]>('/org/accounts'),

      /** Fetch a single account by ID */
      getAccount: (id: string) =>
        get<GUBAccount>(`/org/accounts/${id}`),

      /** List campaigns for an account */
      listCampaigns: (accountId: string) =>
        get<GUBCampaign[]>(`/org/accounts/${accountId}/campaigns`),

      /** Fetch a single campaign by ID */
      getCampaign: (id: string) =>
        get<GUBCampaign>(`/org/campaigns/${id}`),

      /** List active staff members. Pass { all: true } to include former staff */
      listStaff: (opts?: { all?: boolean }) =>
        get<GUBStaff[]>(`/org/staff${opts?.all ? '?all=true' : ''}`),

      /** Fetch a single staff member by ID */
      getStaffMember: (id: string) =>
        get<GUBStaff>(`/org/staff/${id}`),
    };
  }

  return { verifyToken, middleware, requireRole, org };
}

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
