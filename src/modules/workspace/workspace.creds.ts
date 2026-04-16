/**
 * workspace.creds.ts — Resolve Google Workspace credentials for an outbound call.
 *
 * Two runtime helpers:
 *
 *   resolveWorkspaceCreds(req, opts)
 *     Picks between the per-request user token (X-Workspace-Token, attached
 *     to req by the workspace middleware) and the service-account fallback.
 *     Pure decision — does not touch the network.
 *
 *   buildGoogleAuthClient(creds, { scopes, impersonate })
 *     Materializes the decision into an auth client suitable for googleapis
 *     (OAuth2Client for user, GoogleAuth for SA).
 *
 * Usage pattern in a route:
 *
 *   const creds = resolveWorkspaceCreds(req, { allowServiceAccountFallback: false });
 *   const auth = buildGoogleAuthClient(creds, {
 *     scopes: ['https://www.googleapis.com/auth/drive.readonly'],
 *   });
 *   const drive = google.drive({ version: 'v3', auth });
 *
 * Admin/cron path (SA allowed):
 *
 *   const creds = resolveWorkspaceCreds(req, { allowServiceAccountFallback: true });
 *   const auth = buildGoogleAuthClient(creds, {
 *     scopes: ['https://www.googleapis.com/auth/drive.readonly'],
 *     impersonate: 'sync-bot@example.com',
 *   });
 */

import type { Request } from 'express';
import { OAuth2Client, GoogleAuth } from 'google-auth-library';
import { config } from '../../config/env';
import {
  type WorkspaceCreds,
  type ResolveWorkspaceCredsOptions,
  type BuildGoogleAuthClientOptions,
  type GoogleApiAuthClient,
  WorkspaceTokenRequiredError,
  WorkspaceServiceAccountUnconfiguredError,
} from './workspace.types';

/**
 * Decide whether to use the user-provided Workspace access token or the
 * service account for an outbound Google call.
 *
 * Precedence:
 *   1. If req.workspaceAccessToken is set (middleware populated it from the
 *      X-Workspace-Token header), use the user token.
 *   2. Else if allowServiceAccountFallback is true, use the SA.
 *   3. Else throw WorkspaceTokenRequiredError (401).
 */
export function resolveWorkspaceCreds(
  req: Request,
  opts: ResolveWorkspaceCredsOptions = {},
): WorkspaceCreds {
  const userToken = req.workspaceAccessToken;
  if (typeof userToken === 'string' && userToken.length > 0) {
    return { kind: 'user', accessToken: userToken };
  }

  if (opts.allowServiceAccountFallback) {
    if (!hasServiceAccountConfigured()) {
      throw new WorkspaceServiceAccountUnconfiguredError();
    }
    return { kind: 'service_account' };
  }

  throw new WorkspaceTokenRequiredError();
}

/**
 * Materialize resolved creds into a googleapis-compatible auth client.
 *
 * - User token → OAuth2Client with the access token set as credentials
 * - Service account → GoogleAuth with keyFile/credentials + scopes + optional impersonation
 */
export function buildGoogleAuthClient(
  creds: WorkspaceCreds,
  opts: BuildGoogleAuthClientOptions,
): GoogleApiAuthClient {
  if (creds.kind === 'user') {
    return buildUserOAuth2Client(creds.accessToken);
  }
  return buildServiceAccountAuthClient(opts);
}

/**
 * Public check: is a service-account fallback configured in this environment?
 * Useful for startup diagnostics.
 */
export function hasServiceAccountConfigured(): boolean {
  return Boolean(
    config.GOOGLE_DRIVE_SA_KEY_PATH ||
      config.GOOGLE_DRIVE_SA_KEY_B64 ||
      config.GOOGLE_DIRECTORY_SA_KEY_PATH ||
      config.GOOGLE_DIRECTORY_SA_KEY_B64,
  );
}

// ── Internals ────────────────────────────────────────────────────────────────

function buildUserOAuth2Client(accessToken: string): OAuth2Client {
  const client = new OAuth2Client();
  client.setCredentials({ access_token: accessToken });
  return client;
}

function buildServiceAccountAuthClient(opts: BuildGoogleAuthClientOptions): GoogleAuth {
  const keyFileOrCredentials = resolveServiceAccountKey();
  if (!keyFileOrCredentials) {
    // Guarded against upstream by resolveWorkspaceCreds, but defend here too —
    // buildGoogleAuthClient is exported and callable independently.
    throw new WorkspaceServiceAccountUnconfiguredError();
  }

  return new GoogleAuth({
    ...keyFileOrCredentials,
    scopes: opts.scopes,
    ...(opts.impersonate ? { clientOptions: { subject: opts.impersonate } } : {}),
  });
}

type KeyFileOrCredentials =
  | { keyFile: string }
  | { credentials: Record<string, unknown> }
  | null;

function resolveServiceAccountKey(): KeyFileOrCredentials {
  // Prefer Drive-specific keys when set; fall back to Directory keys so a single
  // SA can be reused in dev without doubling the env config.
  const pathCandidate =
    config.GOOGLE_DRIVE_SA_KEY_PATH || config.GOOGLE_DIRECTORY_SA_KEY_PATH;
  if (pathCandidate) {
    return { keyFile: pathCandidate };
  }
  const b64Candidate =
    config.GOOGLE_DRIVE_SA_KEY_B64 || config.GOOGLE_DIRECTORY_SA_KEY_B64;
  if (b64Candidate) {
    return {
      credentials: JSON.parse(
        Buffer.from(b64Candidate, 'base64').toString('utf-8'),
      ) as Record<string, unknown>,
    };
  }
  return null;
}
