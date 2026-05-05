import { verifyGoogleToken, GoogleAuthError } from '../../services/google.service';
import { signAccessToken } from '../../services/jwt.service';
import {
  issueInitialRefreshToken,
  rotateRefreshToken,
  revokeRefreshToken,
  revokeAllUserTokens,
} from '../../services/token.service';
import { findOrCreateUser, getUserIdentity } from '../../services/user.service';
import { AccountDisabledError, type AuthResponse } from './auth.types';
import { config } from '../../config/env';
import { logger } from '../../services/logger';

/**
 * Google login flow:
 *   1. Verify the Google ID token (with strict same-row pairing of
 *      origin + audience against trusted_apps).
 *   2. Resolve / JIT-provision the GUB user identity.
 *   3. Reject disabled accounts.
 *   4. Issue access + refresh tokens, binding the access token's
 *      audience to the consuming app's appId.
 *
 * Note (2026-05-04): the per-app access gate (user_app_permissions
 * lookup, pending_approval branch) was removed. App-level "can this
 * user use my app?" decisions belong to each consuming app, not GUB.
 * See docs/proposals/remove-app-access-gating.md.
 */
export async function googleLogin(
  idToken: string,
  ipAddress: string | undefined,
  userAgent: string | undefined,
  appId?: string,
  origin?: string,
): Promise<AuthResponse> {
  // 1. Verify token with Google — throws GoogleAuthError if invalid.
  //    Passing origin opts into strict same-row pairing (origin + token
  //    aud must both appear on the SAME trusted_apps row). For browser
  //    SDK flows this is always set; for server-to-server callers
  //    (broker) the controller calls verifyGoogleToken directly without
  //    an origin so pairing is skipped.
  const googlePayload = await verifyGoogleToken(idToken, { origin });

  // 2. Resolve user identity (googleSub → email stub → JIT provision)
  const user = await findOrCreateUser(googlePayload);

  // 3. Check account is active
  if (!user.isActive) {
    logger.warn({ userId: user.id, email: user.email }, 'Disabled account login attempt');
    throw new AccountDisabledError();
  }

  // 4. Sign access token with RS256. Bind audience to appId so the
  //    consumer's SDK verifier accepts it (it expects aud === gub.appId).
  //    JWT_AUDIENCE is also added so GUB's own /org/* endpoints accept
  //    the same token when the consumer's backend calls back through.
  const accessToken = await signAccessToken(
    { id: user.id, email: user.email, displayName: user.displayName, isAdmin: user.isAdmin },
    appId ? { appId } : {},
  );

  // 5. Issue opaque refresh token
  const { rawToken: refreshToken } = await issueInitialRefreshToken(user.id, ipAddress, userAgent);

  logger.info({ userId: user.id, email: user.email, appId }, 'User logged in via Google OAuth');

  return {
    accessToken,
    refreshToken,
    expiresIn: config.JWT_ACCESS_TOKEN_TTL,
    tokenType: 'Bearer',
    user: {
      id:          user.id,
      email:       user.email,
      displayName: user.displayName,
      avatarUrl:   user.avatarUrl,
    },
  };
}

export async function refreshTokens(
  rawRefreshToken: string,
  ipAddress: string | undefined,
  userAgent: string | undefined,
  appId?: string,
): Promise<AuthResponse> {
  const { rawToken: newRefreshToken, userId: uid } = await rotateRefreshToken(
    rawRefreshToken,
    ipAddress,
    userAgent,
  );

  const user = await getUserIdentity(uid);

  if (!user) throw new AccountDisabledError();

  if (!user.isActive) {
    await revokeAllUserTokens(uid);
    throw new AccountDisabledError();
  }

  // Refresh re-binds the access token's audience to `appId` when the
  // SDK passes one — same shape as login (aud = [appId, JWT_AUDIENCE]
  // multi-audience). Without this, the refreshed token would carry
  // only JWT_AUDIENCE and fail the consumer's verifier (which checks
  // `aud === gub.appId`), turning silent refresh into a forced
  // re-login every ~14 minutes.
  const accessToken = await signAccessToken(
    {
      id:          user.id,
      email:       user.email,
      displayName: user.displayName,
      isAdmin:     user.isAdmin,
    },
    appId ? { appId } : {},
  );

  return {
    accessToken,
    refreshToken: newRefreshToken,
    expiresIn:    config.JWT_ACCESS_TOKEN_TTL,
    tokenType:    'Bearer',
    user: {
      id:          user.id,
      email:       user.email,
      displayName: user.displayName,
      avatarUrl:   user.avatarUrl,
    },
  };
}

/**
 * Exchange a Google OAuth access token (obtained by an OAuth 2.0 flow, e.g.
 * Gemini Enterprise injecting one into an ADK agent's ToolContext) for a GUB
 * JWT session.
 *
 * Verifies the token by calling Google's userinfo endpoint, then resolves or
 * provisions the user via the same path as a normal Google login.
 */
export async function exchangeGoogleAccessToken(
  accessToken: string,
  ipAddress: string | undefined,
  userAgent: string | undefined,
  appId?: string,
): Promise<AuthResponse> {
  // Verify by calling Google's userinfo endpoint — this is the standard way to
  // validate an OAuth access token when you don't have an ID token.
  let userInfo: { sub: string; email: string; email_verified?: boolean; name?: string; picture?: string };

  try {
    const response = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) {
      throw new Error(`Google userinfo returned ${response.status}`);
    }
    userInfo = await response.json() as typeof userInfo;
  } catch {
    throw new GoogleAuthError('INVALID_GOOGLE_TOKEN', 'Invalid or expired Google access token');
  }

  if (!userInfo.sub || !userInfo.email) {
    throw new GoogleAuthError(
      'INVALID_GOOGLE_TOKEN',
      'Google userinfo response missing required claims (sub, email)',
    );
  }

  // Construct a minimal TokenPayload-compatible object so we can reuse findOrCreateUser.
  // The fields used by findOrCreateUser are sub, email, name, picture.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const googlePayload: any = {
    sub:            userInfo.sub,
    email:          userInfo.email,
    email_verified: userInfo.email_verified ?? true,
    name:           userInfo.name,
    picture:        userInfo.picture,
    iss:            'https://accounts.google.com',
    aud:            config.GOOGLE_CLIENT_ID,
    iat:            Math.floor(Date.now() / 1000),
    exp:            Math.floor(Date.now() / 1000) + 3600,
  };

  const user = await findOrCreateUser(googlePayload);

  if (!user.isActive) {
    logger.warn({ userId: user.id, email: user.email }, 'Disabled account login via access token exchange');
    throw new AccountDisabledError();
  }

  const accessTokenJwt = await signAccessToken(
    { id: user.id, email: user.email, displayName: user.displayName, isAdmin: user.isAdmin },
    appId ? { appId } : {},
  );

  const { rawToken: refreshToken } = await issueInitialRefreshToken(user.id, ipAddress, userAgent);

  logger.info({ userId: user.id, email: user.email }, 'User authenticated via Google access token exchange (ADK/agent flow)');

  return {
    accessToken:  accessTokenJwt,
    refreshToken,
    expiresIn:    config.JWT_ACCESS_TOKEN_TTL,
    tokenType:    'Bearer',
    user: {
      id:          user.id,
      email:       user.email,
      displayName: user.displayName,
      avatarUrl:   user.avatarUrl,
    },
  };
}

export async function logout(rawRefreshToken: string): Promise<void> {
  await revokeRefreshToken(rawRefreshToken);
}

export async function logoutAll(userId: string): Promise<void> {
  await revokeAllUserTokens(userId);
  logger.info({ userId }, 'User logged out of all sessions');
}
