/**
 * originAllowList — origin-based gate with a readable rejection.
 *
 * Why this lives at the application layer, not the CORS layer:
 *   The cors library's built-in rejection (returning an Error from the
 *   origin callback) sends a response with no Access-Control-Allow-Origin
 *   header. The browser blocks it and surfaces an opaque
 *   "blocked by CORS policy" error in the dev console. The dev has no
 *   idea what step they missed.
 *
 *   By moving the gate here — after the CORS layer has already attached
 *   ACAO + Allow-Credentials to the response — the rejection body is
 *   readable to the browser, and we can put actionable guidance in it.
 *
 * What this middleware does:
 *   1. If there's no Origin header, pass through. Server-to-server
 *      callers, curl, Postman, Cloud Scheduler — all originless. They
 *      hit auth checks downstream; this middleware doesn't gate them.
 *   2. If the path is in BYPASS_PATHS, pass through. Public discovery
 *      endpoints (JWKS, OAuth server metadata) and health checks must
 *      be reachable from any origin by design.
 *   3. If the origin matches an entry in CORS_ALLOWED_ORIGINS, pass
 *      through. Strict equality match — same security posture as
 *      before, no wildcards.
 *   4. Otherwise: 403 with a structured JSON body that names the
 *      rejected origin and tells the dev exactly which file to edit.
 *
 * What this middleware deliberately does NOT do:
 *   - Wildcard / pattern matching. Discussed and rejected: ephemeral
 *     subdomain wildcards (e.g. `*.replit.dev`) widen the attack surface
 *     for what is, ultimately, a defense-in-depth layer. The right
 *     trade is "explicit list, friendly rejection" — not "permissive
 *     list, no friction."
 *   - Auto-registration. A future enhancement could let unknown origins
 *     register themselves into a "pending" status, viewable in gub-admin
 *     for manual approval. Out of scope for this fix.
 */

import type { Request, Response, NextFunction } from 'express';
import { config } from '../config/env';
import { logger } from '../services/logger';

/**
 * Paths that are public-by-design — discovery endpoints + healthchecks.
 * These must be reachable from any origin (consuming-app SDKs fetch the
 * JWKS to verify GUB JWTs; load balancers + uptime checks hit /health).
 *
 * Match by exact path or path prefix — adding a trailing `*` enables
 * prefix matching for nested paths.
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

export function originAllowList(req: Request, res: Response, next: NextFunction): void {
  const origin = req.headers.origin;

  // Originless requests: server-to-server, curl, Postman. CORS doesn't
  // apply to these; auth middleware downstream handles trust.
  if (!origin) {
    next();
    return;
  }

  // Public-by-design endpoints.
  if (isBypassPath(req.path)) {
    next();
    return;
  }

  // Strict equality match. No wildcards by design — see file header.
  if (config.CORS_ALLOWED_ORIGINS.includes(origin)) {
    next();
    return;
  }

  // Origin not allowed — return a readable 403 with actionable guidance.
  // The cors layer has already attached ACAO + Allow-Credentials, so the
  // browser CAN read this body (unlike a CORS-layer rejection, which it
  // cannot).
  logger.warn(
    { origin, path: req.path, method: req.method },
    '[originAllowList] origin not in CORS_ALLOWED_ORIGINS — rejecting with 403',
  );

  res.status(403).json({
    error: 'ORIGIN_NOT_ALLOWED',
    origin,
    message:
      `The origin '${origin}' is not registered as a consumer of this GUB instance. ` +
      `If you're a developer setting up a new app, ask the GUB operator to add your ` +
      `origin to the CORS_ALLOWED_ORIGINS list. In dev, that means editing ` +
      `cloudbuild/dev.yaml's _CORS_ALLOWED_ORIGINS substitution and pushing to the ` +
      `dev branch to trigger a redeploy.`,
    fix: {
      file: 'cloudbuild/<env>.yaml',
      key: '_CORS_ALLOWED_ORIGINS',
      action: `Append '${origin}' to the comma-separated list, then push to the deploy branch.`,
    },
  });
}
