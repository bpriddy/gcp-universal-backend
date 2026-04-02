/**
 * setUserContext.ts
 *
 * Express middleware that populates the AsyncLocalStorage user context for
 * the duration of each request. Must be applied AFTER the authenticate
 * middleware so that req.user is guaranteed to be set.
 *
 * Applied only to the org router — auth routes intentionally have no context
 * (they're generating the session, not consuming it).
 */

import type { Request, Response, NextFunction } from 'express';
import { userContextStorage } from '../context/userContext';

export function setUserContext(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) {
    // Should not happen on authenticated routes — authenticate runs first.
    // Fall through without context rather than throwing.
    next();
    return;
  }

  userContextStorage.run(
    { userId: req.user.sub, isAdmin: req.user.isAdmin },
    next,
  );
}
