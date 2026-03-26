import type { Pool } from 'pg';
import type { AccessTokenPayload } from './jwt';

declare global {
  namespace Express {
    interface Request {
      /** Populated by the authenticate middleware after JWT verification */
      user?: AccessTokenPayload;
      /** Populated by the requireAppAccess middleware for the requested app's DB pool */
      appDbPool?: Pool;
      /** The resolved appId for the current request */
      appId?: string;
    }
  }
}

export {};
