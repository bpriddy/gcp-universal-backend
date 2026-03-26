import type { Request, Response, NextFunction } from 'express';
import { verifyAccessToken } from '../services/jwt.service';
import { getAppDbPool } from '../config/database';

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
 * Per-route middleware factory that checks the authenticated user has
 * permission for a specific appId and attaches the corresponding DB pool.
 *
 * Usage:  router.get('/data', authenticate, requireAppAccess('analytics'), handler)
 */
export function requireAppAccess(appId: string) {
  return function (req: Request, res: Response, next: NextFunction): void {
    if (!req.user) {
      res.status(401).json({ code: 'UNAUTHORIZED', message: 'Not authenticated' });
      return;
    }

    const permission = req.user.permissions.find((p) => p.appId === appId);

    if (!permission) {
      res.status(403).json({
        code: 'FORBIDDEN',
        message: `You do not have access to application '${appId}'`,
      });
      return;
    }

    const pool = getAppDbPool(permission.dbIdentifier);

    if (!pool) {
      res.status(503).json({
        code: 'DB_UNAVAILABLE',
        message: `Database pool for '${permission.dbIdentifier}' is not configured`,
      });
      return;
    }

    req.appDbPool = pool;
    req.appId = appId;
    next();
  };
}
