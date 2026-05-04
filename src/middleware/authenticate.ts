import type { Request, Response, NextFunction } from 'express';
import { verifyAccessToken } from '../services/jwt.service';

/**
 * JWT Bearer token authentication middleware.
 * Attaches the verified token payload to req.user.
 */
export async function authenticate(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const authHeader = req.headers['authorization'];

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({
      code: 'MISSING_TOKEN',
      message: 'Authorization header with Bearer token is required',
    });
    return;
  }

  const token = authHeader.slice(7);

  if (!token) {
    res.status(401).json({ code: 'MISSING_TOKEN', message: 'Bearer token is empty' });
    return;
  }

  try {
    req.user = await verifyAccessToken(token);
    next();
  } catch (err) {
    // Pass to the error handler which maps Jose errors to 401 responses
    next(err);
  }
}

/**
 * Middleware that requires the authenticated user to have isAdmin = true.
 * Must be used after the `authenticate` middleware.
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ code: 'UNAUTHORIZED', message: 'Not authenticated' });
    return;
  }
  if (!req.user.isAdmin) {
    res.status(403).json({ code: 'FORBIDDEN', message: 'Admin access required' });
    return;
  }
  next();
}

// Removed (2026-05-04): requireAppAccess middleware. App-level "can this
// user use this app?" decisions belong to each consuming app, not GUB —
// see docs/proposals/remove-app-access-gating.md. The middleware was
// unused at the time of removal; gub-admin uses requireAdmin for its
// own admin-only routes, which is a different (platform-wide) check.
