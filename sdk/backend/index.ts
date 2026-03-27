/**
 * GUB Backend SDK
 *
 * Vanilla Node.js SDK for the GCP Universal Backend.
 * Works with Express, Fastify, raw http, or any Node framework.
 *
 * Install:
 *   npm install github:bpriddy/gcp-universal-backend jose
 *
 * Usage:
 *   import { createGUBClient } from 'gcp-universal-backend/backend'
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
  /** Must match JWT_AUDIENCE env var on the GUB server — usually your appId */
  audience: string;
}

// Express-compatible request/response/next types without requiring @types/express
export interface Request {
  headers: Record<string, string | string[] | undefined>;
  [key: string]: unknown;
}
export interface Response {
  status: (code: number) => Response;
  json: (body: unknown) => void;
}
export type NextFunction = (err?: unknown) => void;

// Attached to req.gub after successful verification
export interface GUBRequestContext {
  user: GUBTokenPayload;
  /** Convenience: permission for the app this backend serves */
  appPermission: TokenPermission | undefined;
}

// ── Org data types ─────────────────────────────────────────────────────────

export interface GUBAccount {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GUBCampaign {
  id: string;
  accountId: string;
  name: string;
  status: string;
  budget: number | null;
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

// ── GUB Client factory ─────────────────────────────────────────────────────

/**
 * Create a GUB client for your backend service.
 *
 * @example
 * const gub = createGUBClient({
 *   gubUrl: process.env.GUB_URL,
 *   issuer: process.env.GUB_ISSUER,
 *   audience: process.env.APP_ID,
 * })
 *
 * // Express
 * app.use(gub.middleware())
 * app.get('/data', gub.requireRole('viewer'), (req, res) => {
 *   const { user } = req.gub
 *   res.json({ hello: user.email })
 * })
 */
export function createGUBClient(config: GUBClientConfig) {
  const { gubUrl, issuer, audience } = config;

  // JWKS fetched from GUB and cached — auto-refreshes when key rotates
  const JWKS = createRemoteJWKSet(
    new URL(`${gubUrl}/.well-known/jwks.json`),
    { cacheMaxAge: 10 * 60 * 1000 }, // 10 minutes
  );

  // ── Token verification ───────────────────────────────────────────────────

  /**
   * Verify a JWT and return its payload.
   * Use this when you need programmatic access outside middleware.
   *
   * @example
   * const payload = await gub.verifyToken(req.headers.authorization?.split(' ')[1])
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
   * Express/Connect middleware that verifies the Bearer token and
   * attaches req.gub = { user, appPermission }.
   *
   * @example
   * app.use(gub.middleware())
   */
  function middleware(appId?: string) {
    return async function gubMiddleware(
      req: Request,
      res: Response,
      next: NextFunction,
    ) {
      const authHeader = req.headers['authorization'];
      const token =
        typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
          ? authHeader.slice(7)
          : null;

      if (!token) {
        res.status(401).json({ error: 'Missing authorization token' });
        return;
      }

      try {
        const user = await verifyToken(token);
        const resolvedAppId = appId ?? audience;

        (req as Request & { gub: GUBRequestContext }).gub = {
          user,
          appPermission: user.permissions.find(
            (p) => p.appId === resolvedAppId,
          ),
        };

        next();
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Invalid token';
        res.status(401).json({ error: message });
      }
    };
  }

  /**
   * Require a minimum role on the app permission.
   * Must be used after gub.middleware().
   *
   * Roles in order: viewer < contributor < manager < admin
   *
   * @example
   * app.get('/reports', gub.requireRole('viewer'), handler)
   * app.post('/campaigns', gub.requireRole('contributor'), handler)
   * app.delete('/accounts', gub.requireRole('admin'), handler)
   */
  function requireRole(minimumRole: 'viewer' | 'contributor' | 'manager' | 'admin') {
    const ROLE_RANK: Record<string, number> = {
      viewer: 0,
      contributor: 1,
      manager: 2,
      admin: 3,
    };

    return function roleMiddleware(
      req: Request,
      res: Response,
      next: NextFunction,
    ) {
      const ctx = (req as Request & { gub?: GUBRequestContext }).gub;

      if (!ctx) {
        res.status(401).json({ error: 'Not authenticated' });
        return;
      }

      if (!ctx.appPermission) {
        res.status(403).json({ error: 'No permission for this app' });
        return;
      }

      const userRank = ROLE_RANK[ctx.appPermission.role] ?? -1;
      const requiredRank = ROLE_RANK[minimumRole];

      if (userRank < requiredRank) {
        res
          .status(403)
          .json({ error: `Requires ${minimumRole} role or higher` });
        return;
      }

      next();
    };
  }

  // ── Org data client ──────────────────────────────────────────────────────
  // Server-to-server calls to GUB for org data.
  // Pass the user's access token so GUB can scope results appropriately.

  function orgClient(accessToken: string) {
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    };

    async function get<T>(path: string): Promise<T> {
      const res = await fetch(`${gubUrl}${path}`, { headers });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { message?: string };
        throw new Error(err.message ?? `GUB request failed: ${res.status}`);
      }
      return res.json() as Promise<T>;
    }

    return {
      /**
       * Fetch an account by ID.
       * @example
       * const account = await gub.orgClient(accessToken).getAccount(accountId)
       */
      getAccount: (id: string) => get<GUBAccount>(`/org/accounts/${id}`),

      /**
       * List all accounts the user has access to.
       * @example
       * const accounts = await gub.orgClient(accessToken).listAccounts()
       */
      listAccounts: () => get<GUBAccount[]>('/org/accounts'),

      /**
       * List campaigns for an account.
       * @example
       * const campaigns = await gub.orgClient(accessToken).listCampaigns(accountId)
       */
      listCampaigns: (accountId: string) =>
        get<GUBCampaign[]>(`/org/accounts/${accountId}/campaigns`),

      /**
       * Fetch a campaign by ID.
       * @example
       * const campaign = await gub.orgClient(accessToken).getCampaign(campaignId)
       */
      getCampaign: (id: string) => get<GUBCampaign>(`/org/campaigns/${id}`),

      /**
       * List staff members.
       * @example
       * const staff = await gub.orgClient(accessToken).listStaff()
       */
      listStaff: () => get<GUBStaff[]>('/org/staff'),

      /**
       * Fetch a staff member by ID.
       * @example
       * const member = await gub.orgClient(accessToken).getStaffMember(staffId)
       */
      getStaffMember: (id: string) => get<GUBStaff>(`/org/staff/${id}`),
    };
  }

  return { verifyToken, middleware, requireRole, orgClient };
}

// ── Type augmentation helper ───────────────────────────────────────────────
// Add this to your project's type declarations to get req.gub typed:
//
// declare global {
//   namespace Express {
//     interface Request {
//       gub: import('gcp-universal-backend/backend').GUBRequestContext
//     }
//   }
// }
