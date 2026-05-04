/**
 * broker.service.ts
 * GUB OAuth 2.0 Authorization Server — server-side flow for headless clients.
 *
 * Flow overview:
 *   1. Client redirects user to GET /auth/google/broker/authorize
 *      → GUB saves state, redirects to Google with its own credentials
 *   2. Google redirects to GET /auth/google/broker/callback with `code` + `state`
 *      → GUB validates state, exchanges code with Google for an ID token,
 *        upserts GUB user, issues a short-lived auth code, redirects to client
 *   3. Client POSTs to POST /auth/google/broker/token with the auth code
 *      → GUB validates code, issues GUB access + refresh tokens
 *
 * No new npm packages — uses google-auth-library (already installed) for both
 * ID token verification and server-side code exchange.
 */

import crypto from 'crypto';
import { OAuth2Client } from 'google-auth-library';
import { prisma } from '../../config/database';
import { config } from '../../config/env';
import { logger } from '../../services/logger';
import { findOrCreateUser, getUserIdentity } from '../../services/user.service';
import { signAccessToken } from '../../services/jwt.service';
import {
  issueInitialRefreshToken,
} from '../../services/token.service';
import type { AuthResponse } from './auth.types';

// ── Errors ────────────────────────────────────────────────────────────────

export class BrokerError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number = 400,
  ) {
    super(message);
    this.name = 'BrokerError';
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

function sha256(plain: string): string {
  return crypto.createHash('sha256').update(plain).digest('hex');
}

function getOAuth2Client(): OAuth2Client {
  if (!config.GOOGLE_CLIENT_SECRET) {
    throw new BrokerError(
      'BROKER_NOT_CONFIGURED',
      'OAuth broker is not configured — set GOOGLE_CLIENT_SECRET and GOOGLE_BROKER_REDIRECT_URI',
      503,
    );
  }
  return new OAuth2Client(
    config.GOOGLE_CLIENT_ID,
    config.GOOGLE_CLIENT_SECRET,
    config.GOOGLE_BROKER_REDIRECT_URI,
  );
}

// ── Client registry ───────────────────────────────────────────────────────

export interface RegisterClientInput {
  name: string;
  redirectUris: string[];
}

export interface RegisterClientResult {
  clientId: string;
  clientSecret: string; // returned ONCE, plaintext — never stored
}

/**
 * Create a new OAuth client. Returns the plaintext secret once; only the hash
 * is persisted. Store it securely (Secret Manager, etc.).
 */
export async function registerClient(input: RegisterClientInput): Promise<RegisterClientResult> {
  const clientId = `gub_${crypto.randomBytes(12).toString('hex')}`;
  const clientSecret = crypto.randomBytes(32).toString('base64url');

  await prisma.oAuthClient.create({
    data: {
      clientId,
      clientSecretHash: sha256(clientSecret),
      name: input.name,
      redirectUris: input.redirectUris,
    },
  });

  logger.info({ clientId, name: input.name }, 'OAuth client registered');
  return { clientId, clientSecret };
}

export async function listClients() {
  return prisma.oAuthClient.findMany({
    select: {
      id: true,
      clientId: true,
      name: true,
      redirectUris: true,
      isActive: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'asc' },
  });
}

export async function deactivateClient(clientId: string): Promise<void> {
  await prisma.oAuthClient.update({
    where: { clientId },
    data: { isActive: false },
  });
}

// ── Step 1: authorize ─────────────────────────────────────────────────────

export interface AuthorizeInput {
  clientId: string;
  redirectUri: string;
  state?: string;        // client-supplied state, echoed back in final redirect
  responseType: string;  // must be 'code'
}

/**
 * Validate the incoming authorize request, persist a state record, and return
 * the Google OAuth URL the browser should be redirected to.
 */
export async function buildGoogleAuthorizeUrl(input: AuthorizeInput): Promise<string> {
  if (input.responseType !== 'code') {
    throw new BrokerError('UNSUPPORTED_RESPONSE_TYPE', 'Only response_type=code is supported');
  }

  // Validate client
  const client = await prisma.oAuthClient.findUnique({ where: { clientId: input.clientId } });
  if (!client || !client.isActive) {
    throw new BrokerError('INVALID_CLIENT', 'Unknown or inactive client', 401);
  }
  if (!client.redirectUris.includes(input.redirectUri)) {
    throw new BrokerError('INVALID_REDIRECT_URI', 'Redirect URI not registered for this client');
  }

  // Persist state record — its UUID IS the state param forwarded to Google
  const pending = await prisma.oAuthPendingAuth.create({
    data: {
      clientId: input.clientId,
      redirectUri: input.redirectUri,
      clientState: input.state ?? null,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    },
  });

  const oauthClient = getOAuth2Client();
  const url = oauthClient.generateAuthUrl({
    access_type: 'online',
    scope: ['openid', 'email', 'profile'],
    state: pending.id,         // UUID — maps back to pending_auths row
    prompt: 'select_account',
  });

  return url;
}

// ── Step 2: callback ──────────────────────────────────────────────────────

export interface CallbackInput {
  code: string;
  state: string;
  ipAddress?: string;
  userAgent?: string;
}

export interface CallbackResult {
  redirectUri: string;
  code: string;
  state?: string;
}

/**
 * Handle Google's callback:
 *   1. Look up + delete the pending auth record (validates state, checks expiry)
 *   2. Exchange the Google auth code for tokens (gets ID token)
 *   3. Upsert GUB user (reuses existing findOrCreateUser)
 *   4. Issue a GUB short-lived auth code
 *   5. Return the redirect info so the controller can send the browser to the client
 */
export async function handleGoogleCallback(input: CallbackInput): Promise<CallbackResult> {
  // Consume pending auth record
  const pending = await prisma.oAuthPendingAuth.findUnique({ where: { id: input.state } });
  if (!pending) {
    throw new BrokerError('INVALID_STATE', 'State parameter not found or already used', 400);
  }
  if (pending.expiresAt < new Date()) {
    await prisma.oAuthPendingAuth.delete({ where: { id: pending.id } });
    throw new BrokerError('STATE_EXPIRED', 'Authorization session expired — please try again', 400);
  }
  // Delete immediately — state is single-use
  await prisma.oAuthPendingAuth.delete({ where: { id: pending.id } });

  // Exchange code with Google
  const oauthClient = getOAuth2Client();
  let idTokenRaw: string;
  try {
    const { tokens } = await oauthClient.getToken(input.code);
    if (!tokens.id_token) {
      throw new Error('Google did not return an id_token');
    }
    idTokenRaw = tokens.id_token;
  } catch (err) {
    logger.warn({ err }, 'Google code exchange failed in broker callback');
    throw new BrokerError('GOOGLE_EXCHANGE_FAILED', 'Failed to exchange code with Google', 502);
  }

  // Verify ID token and upsert user (reuses existing auth service logic)
  // We import verifyGoogleToken to avoid duplicating the verification logic.
  const { verifyGoogleToken } = await import('../../services/google.service');
  const googleUser = await verifyGoogleToken(idTokenRaw);
  const user = await findOrCreateUser(googleUser);

  if (!user.isActive) {
    throw new BrokerError('ACCOUNT_DISABLED', 'This account has been disabled', 403);
  }

  // Issue a GUB auth code (single-use, 5 min TTL)
  const plainCode = crypto.randomBytes(32).toString('base64url');
  await prisma.oAuthAuthCode.create({
    data: {
      codeHash: sha256(plainCode),
      clientId: pending.clientId,
      userId: user.id,
      redirectUri: pending.redirectUri,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    },
  });

  const result: CallbackResult = { redirectUri: pending.redirectUri, code: plainCode };
  if (pending.clientState) result.state = pending.clientState;
  return result;
}

// ── Step 3: token ─────────────────────────────────────────────────────────

export interface TokenInput {
  grantType: string;       // must be 'authorization_code'
  code: string;
  redirectUri: string;
  clientId: string;
  clientSecret: string;
  ipAddress?: string;
  userAgent?: string;
}

/**
 * Exchange a GUB auth code for access + refresh tokens.
 * Validates client credentials, then issues a GUB JWT session.
 */
export async function exchangeAuthCode(input: TokenInput): Promise<AuthResponse> {
  if (input.grantType !== 'authorization_code') {
    throw new BrokerError('UNSUPPORTED_GRANT_TYPE', 'Only grant_type=authorization_code is supported');
  }

  // Validate client credentials
  const client = await prisma.oAuthClient.findUnique({ where: { clientId: input.clientId } });
  if (!client || !client.isActive) {
    throw new BrokerError('INVALID_CLIENT', 'Unknown or inactive client', 401);
  }
  if (client.clientSecretHash !== sha256(input.clientSecret)) {
    throw new BrokerError('INVALID_CLIENT', 'Invalid client credentials', 401);
  }

  // Look up auth code
  const record = await prisma.oAuthAuthCode.findUnique({ where: { codeHash: sha256(input.code) } });
  if (!record) {
    throw new BrokerError('INVALID_GRANT', 'Authorization code not found or already used', 400);
  }
  if (record.usedAt) {
    // Replay attack — the code was already consumed
    logger.warn({ codeId: record.id }, 'Auth code replay detected in broker token endpoint');
    throw new BrokerError('INVALID_GRANT', 'Authorization code has already been used', 400);
  }
  if (record.expiresAt < new Date()) {
    throw new BrokerError('INVALID_GRANT', 'Authorization code has expired', 400);
  }
  if (record.clientId !== input.clientId) {
    throw new BrokerError('INVALID_GRANT', 'Code was issued to a different client', 400);
  }
  if (record.redirectUri !== input.redirectUri) {
    throw new BrokerError('INVALID_GRANT', 'redirect_uri does not match', 400);
  }

  // Mark code used (prevents replay)
  await prisma.oAuthAuthCode.update({
    where: { id: record.id },
    data: { usedAt: new Date() },
  });

  // Build GUB session — fetch user identity for JWT signing
  const userIdentity = await getUserIdentity(record.userId);
  if (!userIdentity) {
    throw new BrokerError('USER_NOT_FOUND', 'User associated with this code no longer exists', 400);
  }
  if (!userIdentity.isActive) {
    throw new BrokerError('ACCOUNT_DISABLED', 'This account has been disabled', 403);
  }

  const accessToken = await signAccessToken(userIdentity);
  const { rawToken: refreshToken } = await issueInitialRefreshToken(
    record.userId,
    input.ipAddress ?? undefined,
    input.userAgent ?? undefined,
  );

  return {
    accessToken,
    refreshToken,
    expiresIn: config.JWT_ACCESS_TOKEN_TTL,
    tokenType: 'Bearer',
    user: {
      id: userIdentity.id,
      email: userIdentity.email,
      displayName: userIdentity.displayName,
      avatarUrl: userIdentity.avatarUrl,
    },
  };
}

// ── Cleanup job helper ────────────────────────────────────────────────────

/** Delete expired pending auths and auth codes. Safe to run on a schedule. */
export async function purgeExpiredBrokerRecords(): Promise<void> {
  const now = new Date();
  const [pa, ac] = await Promise.all([
    prisma.oAuthPendingAuth.deleteMany({ where: { expiresAt: { lt: now } } }),
    prisma.oAuthAuthCode.deleteMany({ where: { expiresAt: { lt: now } } }),
  ]);
  if (pa.count > 0 || ac.count > 0) {
    logger.info({ pendingAuths: pa.count, authCodes: ac.count }, 'Purged expired broker records');
  }
}
