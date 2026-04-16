/**
 * workspace.types.ts — Shared types for the Google Workspace pass-through layer.
 *
 * Architectural principle (locked 2026-04-16):
 *   GUB does not own Google Workspace permissions. Client applications hold
 *   their own Google refresh tokens and pass a short-lived access token on
 *   each request via the `X-Workspace-Token` header. GUB uses that token
 *   directly for the outbound call. When there is no user in the request
 *   (cron, admin batch jobs, system sync), GUB falls back to the
 *   Drive/Directory service account.
 *
 * GUB never:
 *   - Performs the OAuth consent flow for Workspace scopes
 *   - Persists Google refresh tokens
 *   - Persists Workspace access tokens (they ride on a single request only)
 *
 * This file owns the types. The runtime lives in workspace.creds.ts and the
 * Express wiring lives in workspace.middleware.ts.
 */

import type { GoogleAuth, OAuth2Client } from 'google-auth-library';

/**
 * What the caller receives from resolveWorkspaceCreds.
 *
 * - 'user' means a client-provided Workspace access token is present on
 *   the request. The outbound Google call should act as that user.
 * - 'service_account' means no user token was provided (or the caller opted
 *   into SA-only mode) and the Drive/Directory service account is being
 *   used instead. The caller MUST be on a path that is authorized to run
 *   as the SA — typically admin, cron, or background sync paths.
 */
export type WorkspaceCreds =
  | { kind: 'user'; accessToken: string }
  | { kind: 'service_account' };

/**
 * Options for resolveWorkspaceCreds.
 */
export interface ResolveWorkspaceCredsOptions {
  /**
   * Allow falling back to the service account when no X-Workspace-Token is
   * present on the request.
   *
   * - true  → SA-allowed paths (cron, admin batch, background sync)
   * - false → User-required paths (per-user Gmail/Calendar/Drive reads)
   *
   * Defaults to false. Callers must explicitly opt in to SA fallback.
   */
  allowServiceAccountFallback?: boolean;
}

/**
 * Options for buildGoogleAuthClient.
 *
 * - scopes: OAuth scopes (e.g. 'https://www.googleapis.com/auth/drive.readonly').
 *   Required for SA paths; ignored for user-token paths (scopes are baked into
 *   the token by whoever minted it).
 * - impersonate: email address to impersonate via domain-wide delegation.
 *   SA-only. Leave undefined to act as the SA directly.
 */
export interface BuildGoogleAuthClientOptions {
  scopes: string[];
  impersonate?: string;
}

/**
 * An auth client suitable for passing as the `auth` option to any googleapis
 * client (e.g. google.drive({ version: 'v3', auth })).
 *
 * Both OAuth2Client (user-token) and GoogleAuth (service-account) are accepted
 * by google-api-nodejs-client.
 */
export type GoogleApiAuthClient = OAuth2Client | GoogleAuth;

/**
 * Error thrown when the request requires a user Workspace token but none was
 * provided (and SA fallback was not opted into).
 */
export class WorkspaceTokenRequiredError extends Error {
  readonly code = 'WORKSPACE_TOKEN_REQUIRED';
  readonly httpStatus = 401;
  constructor(
    message = 'This endpoint requires a Workspace access token. Pass it via the X-Workspace-Token header.',
  ) {
    super(message);
    this.name = 'WorkspaceTokenRequiredError';
  }
}

/**
 * Error thrown when SA fallback is allowed but no service-account credentials
 * are configured in the environment. This is an operator misconfiguration,
 * not a user-facing issue — returned as 500.
 */
export class WorkspaceServiceAccountUnconfiguredError extends Error {
  readonly code = 'WORKSPACE_SA_UNCONFIGURED';
  readonly httpStatus = 500;
  constructor(
    message = 'Service-account fallback was requested but no Workspace SA credentials are configured (GOOGLE_DRIVE_SA_KEY_* or GOOGLE_DIRECTORY_SA_KEY_*).',
  ) {
    super(message);
    this.name = 'WorkspaceServiceAccountUnconfiguredError';
  }
}
