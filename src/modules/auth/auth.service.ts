import { verifyGoogleToken } from '../../services/google.service';
import { signAccessToken } from '../../services/jwt.service';
import {
  issueInitialRefreshToken,
  rotateRefreshToken,
  revokeRefreshToken,
  revokeAllUserTokens,
} from '../../services/token.service';
import {
  findOrCreateUser,
  checkOrProvisionAppAccess,
  getUserWithPermissions,
} from '../../services/user.service';
import {
  AccountDisabledError,
  type AuthResponse,
  type PendingApprovalResponse,
} from './auth.types';
import { config } from '../../config/env';
import { logger } from '../../services/logger';

export type GoogleLoginResult = AuthResponse | PendingApprovalResponse;

export async function googleLogin(
  idToken: string,
  ipAddress: string | undefined,
  userAgent: string | undefined,
  appId?: string,
): Promise<GoogleLoginResult> {
  // 1. Verify token with Google — throws GoogleAuthError if invalid
  const googlePayload = await verifyGoogleToken(idToken);

  // 2. Resolve user identity (googleSub → email stub → JIT provision)
  const user = await findOrCreateUser(googlePayload);

  // 3. Check account is active
  if (!user.isActive) {
    logger.warn({ userId: user.id, email: user.email }, 'Disabled account login attempt');
    throw new AccountDisabledError();
  }

  // 4. App-level access check — only when the client identifies itself
  if (appId) {
    const access = await checkOrProvisionAppAccess(user.id, appId, user.isAdmin);

    if (access === 'pending') {
      logger.info(
        { userId: user.id, email: user.email, appId },
        'User login held at pending_approval for app',
      );
      return { status: 'pending_approval', userId: user.id, appId };
    }
  }

  // 5. Sign access token with RS256
  const accessToken = await signAccessToken({
    id:          user.id,
    email:       user.email,
    displayName: user.displayName,
    isAdmin:     user.isAdmin,
    permissions: user.permissions,
  });

  // 6. Issue opaque refresh token
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
): Promise<AuthResponse> {
  const { rawToken: newRefreshToken, userId: uid } = await rotateRefreshToken(
    rawRefreshToken,
    ipAddress,
    userAgent,
  );

  const user = await getUserWithPermissions(uid);

  if (!user) throw new AccountDisabledError();

  if (!user.isActive) {
    await revokeAllUserTokens(uid);
    throw new AccountDisabledError();
  }

  const accessToken = await signAccessToken({
    id:          user.id,
    email:       user.email,
    displayName: user.displayName,
    isAdmin:     user.isAdmin,
    permissions: user.permissions,
  });

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

export async function logout(rawRefreshToken: string): Promise<void> {
  await revokeRefreshToken(rawRefreshToken);
}

export async function logoutAll(userId: string): Promise<void> {
  await revokeAllUserTokens(userId);
  logger.info({ userId }, 'User logged out of all sessions');
}
