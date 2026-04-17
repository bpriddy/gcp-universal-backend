/**
 * workspace.middleware.ts — Extract the Workspace access token from the
 * request and attach it to req for downstream handlers.
 *
 * Header: X-Workspace-Token
 * Value:  A short-lived Google OAuth access token the client already holds
 *         (obtained by the client via its own OAuth consent flow).
 *
 * Behavior:
 *   - Header present + non-empty  → sets req.workspaceAccessToken
 *   - Header missing/empty        → no-op (downstream decides whether to
 *                                   require it via resolveWorkspaceCreds)
 *   - Header present but with the literal "Bearer " prefix → prefix is stripped
 *
 * This middleware is intentionally permissive. It never 401s or 400s on its
 * own — authorization decisions belong to the route via resolveWorkspaceCreds,
 * which can require the token or fall back to the SA depending on the path.
 *
 * Mount order: after pino-http (so the header is redacted in logs) and
 * typically before authenticate (so it's available on authenticated routes,
 * but the middleware itself doesn't require authentication — the Workspace
 * token and the GUB access token are independent credentials).
 */

import type { Request, Response, NextFunction } from 'express';

export const WORKSPACE_TOKEN_HEADER = 'x-workspace-token';

export function attachWorkspaceToken(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const raw = req.headers[WORKSPACE_TOKEN_HEADER];
  if (typeof raw !== 'string') {
    next();
    return;
  }

  let token = raw.trim();
  // Be lenient: some clients will mirror the Authorization pattern.
  if (token.toLowerCase().startsWith('bearer ')) {
    token = token.slice(7).trim();
  }

  if (token.length > 0) {
    req.workspaceAccessToken = token;
  }
  next();
}
