import type { Pool } from 'pg';
import type { AccessTokenPayload } from './jwt';

declare module 'express-serve-static-core' {
  interface Request {
    user?: AccessTokenPayload;
    appDbPool?: Pool;
    appId?: string;
    /**
     * Short-lived Google Workspace access token forwarded from the client
     * app via the X-Workspace-Token header. Populated by the workspace
     * middleware. Routes resolve usage (vs. SA fallback) through
     * `resolveWorkspaceCreds` — never read this field directly.
     */
    workspaceAccessToken?: string;
  }
}

export {};
