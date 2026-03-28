import { verifyGoogleToken } from '../../services/google.service';
import { signAccessToken } from '../../services/jwt.service';
import {
  issueInitialRefreshToken,
  rotateRefreshToken,
  revokeRefreshToken,
  revokeAllUserTokens,
} from '../../services/token.service';
import { findOrCreateUser, getUserWithPermissions } from '../../services/user.service';
import { AccountDisabledError, type AuthResponse } from './auth.types';
import { config } from '../../config/env';
import { logger } from '../../services/logger';

export async function googleLogin(
  idToken: string,
  ipAddress: string | undefined,
  userAgent: string | undefined,
): Promise<AuthResponse> {
  // 1. Verify token with Google — throws GoogleAuthError if invalid
  const googlePayload = await verifyGoogleToken(idToken);

  // 2. Find or provision user in our database
  const user = await findOrCreateUser(googlePayload);

  // 3. Check account is active
  if (!user.isActive) {
    logger.warn({ userId: user.id, email: user.email }, 'Disabled account login attempt');
    throw new AccountDisabledError();
  }

  // 4. Sign access token with RS256
  const accessToken = await signAccessToken({
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    isAdmin: user.isAdmin,
    permissions: user.permissions,
  });

  // 5. Issue opaque refresh token (stored as hash in DB)
  const { rawToken: refreshToken } = await issueInitialRefreshToken(user.id, ipAddress, userAgent);

  logger.info({ userId: user.id, email: user.email }, 'User logged in via Google OAuth');

  return {
    accessToken,
    refreshToken,
    expiresIn: config.JWT_ACCESS_TOKEN_TTL,
    tokenType: 'Bearer',
    user: {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
    },
  };
}

export async function refreshTokens(
  rawRefreshToken: string,
  ipAddress: string | undefined,
  userAgent: string | undefined,
): Promise<AuthResponse> {
  // Rotate the refresh token — throws on reuse detection or invalid token
  const { rawToken: newRefreshToken, userId: uid } = await rotateRefreshToken(
    rawRefreshToken,
    ipAddress,
    userAgent,
  );

  // Reload user + permissions (may have changed since token was issued)
  const user = await getUserWithPermissions(uid);

  if (!user) {
    throw new AccountDisabledError();
  }

  if (!user.isActive) {
    // Revoke all tokens and block further refresh
    await revokeAllUserTokens(uid);
    throw new AccountDisabledError();
  }

  const accessToken = await signAccessToken({
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    isAdmin: user.isAdmin,
    permissions: user.permissions,
  });

  return {
    accessToken,
    refreshToken: newRefreshToken,
    expiresIn: config.JWT_ACCESS_TOKEN_TTL,
    tokenType: 'Bearer',
    user: {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
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
