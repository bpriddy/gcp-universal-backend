/**
 * workspace.creds.test.ts — Unit tests for the Workspace creds resolver.
 *
 * Covers:
 *   - User token present → 'user' creds
 *   - "Bearer " prefix is handled upstream by the middleware, not here
 *   - Missing token + fallback disallowed → WorkspaceTokenRequiredError (401)
 *   - Missing token + fallback allowed + SA configured → 'service_account'
 *   - Missing token + fallback allowed + SA NOT configured → WorkspaceServiceAccountUnconfiguredError (500)
 *   - buildGoogleAuthClient produces the right client kind
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Request } from 'express';

// Mock config BEFORE importing the module under test. vi.mock is hoisted to
// the top of the file, so the factory can't close over a regular `const`.
// vi.hoisted() lets us co-hoist a mutable holder that individual tests can
// mutate to toggle SA configuration.
const { configMock } = vi.hoisted(() => ({
  configMock: {
    GOOGLE_DRIVE_SA_KEY_PATH: undefined as string | undefined,
    GOOGLE_DRIVE_SA_KEY_B64: undefined as string | undefined,
    GOOGLE_DIRECTORY_SA_KEY_PATH: undefined as string | undefined,
    GOOGLE_DIRECTORY_SA_KEY_B64: undefined as string | undefined,
  },
}));

vi.mock('../../config/env', () => ({
  config: configMock,
}));

import {
  resolveWorkspaceCreds,
  buildGoogleAuthClient,
  hasServiceAccountConfigured,
} from './workspace.creds';
import {
  WorkspaceTokenRequiredError,
  WorkspaceServiceAccountUnconfiguredError,
} from './workspace.types';

function fakeReq(token?: string): Request {
  // Minimal cast — resolveWorkspaceCreds only reads workspaceAccessToken.
  return { workspaceAccessToken: token } as unknown as Request;
}

beforeEach(() => {
  configMock.GOOGLE_DRIVE_SA_KEY_PATH = undefined;
  configMock.GOOGLE_DRIVE_SA_KEY_B64 = undefined;
  configMock.GOOGLE_DIRECTORY_SA_KEY_PATH = undefined;
  configMock.GOOGLE_DIRECTORY_SA_KEY_B64 = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolveWorkspaceCreds — user token path', () => {
  it('returns user creds when req.workspaceAccessToken is set', () => {
    const req = fakeReq('ya29.FAKE_USER_TOKEN');
    const creds = resolveWorkspaceCreds(req);
    expect(creds).toEqual({ kind: 'user', accessToken: 'ya29.FAKE_USER_TOKEN' });
  });

  it('user token wins over SA fallback even when SA is configured', () => {
    configMock.GOOGLE_DRIVE_SA_KEY_PATH = '/tmp/sa.json';
    const req = fakeReq('ya29.USER');
    const creds = resolveWorkspaceCreds(req, { allowServiceAccountFallback: true });
    expect(creds.kind).toBe('user');
  });

  it('empty string is treated as no token', () => {
    const req = fakeReq('');
    expect(() => resolveWorkspaceCreds(req)).toThrow(WorkspaceTokenRequiredError);
  });
});

describe('resolveWorkspaceCreds — SA fallback', () => {
  it('throws WorkspaceTokenRequiredError (401) when no token and fallback not allowed', () => {
    const req = fakeReq();
    try {
      resolveWorkspaceCreds(req);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(WorkspaceTokenRequiredError);
      expect((err as WorkspaceTokenRequiredError).httpStatus).toBe(401);
      expect((err as WorkspaceTokenRequiredError).code).toBe('WORKSPACE_TOKEN_REQUIRED');
    }
  });

  it('returns SA creds when no token, fallback allowed, Drive SA path configured', () => {
    configMock.GOOGLE_DRIVE_SA_KEY_PATH = '/tmp/sa.json';
    const req = fakeReq();
    const creds = resolveWorkspaceCreds(req, { allowServiceAccountFallback: true });
    expect(creds).toEqual({ kind: 'service_account' });
  });

  it('returns SA creds when only Directory SA path configured (fallback for single-SA dev)', () => {
    configMock.GOOGLE_DIRECTORY_SA_KEY_PATH = '/tmp/sa.json';
    const req = fakeReq();
    const creds = resolveWorkspaceCreds(req, { allowServiceAccountFallback: true });
    expect(creds).toEqual({ kind: 'service_account' });
  });

  it('throws WorkspaceServiceAccountUnconfiguredError (500) when fallback allowed but no SA configured', () => {
    const req = fakeReq();
    try {
      resolveWorkspaceCreds(req, { allowServiceAccountFallback: true });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(WorkspaceServiceAccountUnconfiguredError);
      expect((err as WorkspaceServiceAccountUnconfiguredError).httpStatus).toBe(500);
      expect((err as WorkspaceServiceAccountUnconfiguredError).code).toBe(
        'WORKSPACE_SA_UNCONFIGURED',
      );
    }
  });
});

describe('hasServiceAccountConfigured', () => {
  it('returns false when no SA env vars set', () => {
    expect(hasServiceAccountConfigured()).toBe(false);
  });

  it('returns true when any of the four SA env vars are set', () => {
    configMock.GOOGLE_DRIVE_SA_KEY_PATH = '/tmp/sa.json';
    expect(hasServiceAccountConfigured()).toBe(true);
    configMock.GOOGLE_DRIVE_SA_KEY_PATH = undefined;

    configMock.GOOGLE_DRIVE_SA_KEY_B64 = 'eyJ...';
    expect(hasServiceAccountConfigured()).toBe(true);
    configMock.GOOGLE_DRIVE_SA_KEY_B64 = undefined;

    configMock.GOOGLE_DIRECTORY_SA_KEY_PATH = '/tmp/sa.json';
    expect(hasServiceAccountConfigured()).toBe(true);
    configMock.GOOGLE_DIRECTORY_SA_KEY_PATH = undefined;

    configMock.GOOGLE_DIRECTORY_SA_KEY_B64 = 'eyJ...';
    expect(hasServiceAccountConfigured()).toBe(true);
  });
});

describe('buildGoogleAuthClient', () => {
  it('builds an OAuth2Client with the access token set for user creds', () => {
    const auth = buildGoogleAuthClient(
      { kind: 'user', accessToken: 'ya29.USER' },
      { scopes: ['https://www.googleapis.com/auth/drive.readonly'] },
    );
    // Duck-type the OAuth2Client shape instead of importing the concrete class
    // (which is wrapped in a factory on google.auth.OAuth2).
    expect(auth).toBeDefined();
    // OAuth2Client exposes credentials via .credentials
    const credsBag = (auth as unknown as { credentials: { access_token?: string } }).credentials;
    expect(credsBag?.access_token).toBe('ya29.USER');
  });

  it('builds a GoogleAuth with keyFile + scopes for SA creds', () => {
    configMock.GOOGLE_DRIVE_SA_KEY_PATH = '/tmp/sa.json';
    const auth = buildGoogleAuthClient(
      { kind: 'service_account' },
      { scopes: ['https://www.googleapis.com/auth/drive.readonly'] },
    );
    expect(auth).toBeDefined();
    // GoogleAuth stashes scopes on _scopes / scopes depending on version; be tolerant.
    const scopes =
      (auth as unknown as { scopes?: string | string[] }).scopes ??
      (auth as unknown as { _scopes?: string | string[] })._scopes;
    expect(scopes).toContain('https://www.googleapis.com/auth/drive.readonly');
  });

  it('throws WorkspaceServiceAccountUnconfiguredError for SA creds when no SA env set', () => {
    expect(() =>
      buildGoogleAuthClient(
        { kind: 'service_account' },
        { scopes: ['https://www.googleapis.com/auth/drive.readonly'] },
      ),
    ).toThrow(WorkspaceServiceAccountUnconfiguredError);
  });

  it('passes impersonate subject through to GoogleAuth clientOptions', () => {
    configMock.GOOGLE_DRIVE_SA_KEY_PATH = '/tmp/sa.json';
    const auth = buildGoogleAuthClient(
      { kind: 'service_account' },
      {
        scopes: ['https://www.googleapis.com/auth/drive.readonly'],
        impersonate: 'sync-bot@example.com',
      },
    );
    // GoogleAuth stores the subject inside clientOptions.
    const clientOptions =
      (auth as unknown as { clientOptions?: { subject?: string } }).clientOptions ??
      {};
    expect(clientOptions.subject).toBe('sync-bot@example.com');
  });
});
