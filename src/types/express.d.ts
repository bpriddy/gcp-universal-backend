import type { Pool } from 'pg';
import type { AccessTokenPayload } from './jwt';

declare module 'express-serve-static-core' {
  interface Request {
    user?: AccessTokenPayload;
    appDbPool?: Pool;
    appId?: string;
  }
}

export {};
