/**
 * workspace module — Pass-through Google Workspace auth.
 *
 * Client applications hold their own Google refresh tokens and pass a
 * short-lived access token per-request via `X-Workspace-Token`. GUB uses
 * that token for the outbound call, with a service-account fallback on
 * admin/cron/sync paths that have no user in the request.
 *
 * Barrel export — keep routes importing from here, not from individual files.
 */

export {
  resolveWorkspaceCreds,
  buildGoogleAuthClient,
  hasServiceAccountConfigured,
} from './workspace.creds';

export {
  attachWorkspaceToken,
  WORKSPACE_TOKEN_HEADER,
} from './workspace.middleware';

export {
  type WorkspaceCreds,
  type ResolveWorkspaceCredsOptions,
  type BuildGoogleAuthClientOptions,
  type GoogleApiAuthClient,
  WorkspaceTokenRequiredError,
  WorkspaceServiceAccountUnconfiguredError,
} from './workspace.types';
