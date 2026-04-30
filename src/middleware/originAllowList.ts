/**
 * originAllowList — origin-based gate with a readable rejection.
 *
 * ── Layer split (read this first) ───────────────────────────────────────────
 * This middleware is **dev/staging tooling**, not production CORS hardening.
 * Production CORS should be handled at the edge — a WAF, Cloud Armor, or
 * load-balancer-level origin policy — that blocks bad origins before they
 * ever reach this app. This middleware staying mounted in prod is
 * defense-in-depth, not the primary boundary.
 *
 * The dev/staging job: let admins add new allowed origins at runtime
 * (without a redeploy) when implementers spin up new consuming-app forks
 * or preview environments. The cors_allowed_origins table is the live
 * source of truth; gub-admin's UI does CRUD; this middleware queries on
 * each request.
 *
 * ── Why this gate runs at the application layer, not the cors lib ──────────
 * The cors library's built-in rejection (origin callback returning an
 * Error) sends a response with no Access-Control-Allow-Origin header.
 * The browser blocks it and surfaces an opaque "blocked by CORS policy"
 * error in the dev console. The dev has no idea what step they missed.
 *
 * By moving the gate here — after the CORS layer has already attached
 * ACAO + Allow-Credentials to the response — the rejection body is
 * readable to the browser, and we put actionable guidance in it ("the
 * origin '...' isn't registered, ask the admin to add it via the
 * gub-admin CORS settings page").
 *
 * ── What this middleware does ──────────────────────────────────────────────
 *   1. No Origin header → pass through. Server-to-server, curl, Postman,
 *      Cloud Scheduler — all originless. Auth middleware downstream
 *      handles their trust.
 *   2. Path in BYPASS_PATHS → pass through. Public discovery endpoints
 *      (JWKS, OAuth server metadata) and healthchecks must be reachable
 *      from any origin by design.
 *   3. Origin in cors_allowed_origins (with is_active=true) → pass through.
 *      Strict equality match — no wildcards, no fuzzy logic.
 *   4. Otherwise → 403 with a structured JSON body that names the
 *      rejected origin and tells the dev exactly how to get unblocked.
 *
 * ── What this deliberately does NOT do ─────────────────────────────────────
 *   - Wildcard / pattern matching. Discussed and rejected: ephemeral
 *     subdomain wildcards widen the attack surface for a defense-in-depth
 *     layer. The right trade is "explicit list, friendly rejection,
 *     admin self-service" — not "permissive list, no friction."
 *   - In-memory caching. Single-row index lookup per request; sub-ms.
 *     Add caching if profiling ever shows it matters.
 *   - Auto-registration. Could let unknown origins register themselves
 *     into a "pending" status for admin approval. Out of scope today;
 *     would be a future enhancement.
 */

import type { Request, Response, NextFunction } from 'express';
import { prisma } from '../config/database';
import { logger } from '../services/logger';

/**
 * Paths that are public-by-design — discovery endpoints + healthchecks.
 * Reachable from any origin so SDK verifiers (consuming apps fetch JWKS)
 * and load balancers / uptime checks stay functional.
 */
const BYPASS_PATHS = new Set<string>([
  '/.well-known/jwks.json',
  '/.well-known/oauth-authorization-server',
  '/health',
  '/health/live',
]);

function isBypassPath(path: string): boolean {
  return BYPASS_PATHS.has(path);
}

export async function originAllowList(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const origin = req.headers.origin;

  // Originless requests: server-to-server, curl, Postman. CORS doesn't
  // apply; auth middleware downstream handles trust.
  if (!origin) {
    next();
    return;
  }

  // Public-by-design endpoints.
  if (isBypassPath(req.path)) {
    next();
    return;
  }

  // DB lookup. Single-row, indexed on (origin, is_active).
  let allowed = false;
  try {
    const row = await prisma.corsAllowedOrigin.findFirst({
      where: { origin, isActive: true },
      select: { id: true },
    });
    allowed = !!row;
  } catch (err) {
    // DB outage. Fail closed for unknown origins (rejecting with 403
    // is correct — the alternative is silently allowing any origin).
    // Note: DB-dependent endpoints would be failing anyway in this
    // scenario, so this isn't a meaningful availability regression.
    logger.error(
      { err, origin },
      '[originAllowList] DB lookup failed — rejecting request',
    );
    res.status(503).json({
      error: 'CORS_LOOKUP_UNAVAILABLE',
      message: 'CORS allow-list is temporarily unavailable. Try again shortly.',
    });
    return;
  }

  if (allowed) {
    next();
    return;
  }

  // Origin not allowed — return a readable 403 with actionable guidance.
  // The cors layer has already attached ACAO + Allow-Credentials, so the
  // browser CAN read this body (unlike a CORS-layer rejection).
  logger.warn(
    { origin, path: req.path, method: req.method },
    '[originAllowList] origin not in allow-list — rejecting with 403',
  );

  res.status(403).json({
    error: 'ORIGIN_NOT_ALLOWED',
    origin,
    message:
      `The origin '${origin}' is not registered as a consumer of this GUB instance. ` +
      `Ask a GUB admin to add it via the gub-admin CORS settings page. ` +
      `The change takes effect on the next request — no redeploy needed.`,
    fix: {
      surface: 'gub-admin → Settings → CORS allow-list',
      action: `Click "Add origin", paste '${origin}', save.`,
    },
  });
}
