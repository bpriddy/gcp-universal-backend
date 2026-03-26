import { randomBytes, createHash } from 'crypto';
import { randomUUID } from 'crypto';
import { prisma } from '../config/database';
import { config } from '../config/env';
import { logger } from './logger';

export class TokenReuseDetectedError extends Error {
  readonly code = 'TOKEN_REUSE_DETECTED';
  constructor() {
    super('Refresh token reuse detected — all sessions revoked for security');
    this.name = 'TokenReuseDetectedError';
  }
}

export class InvalidRefreshTokenError extends Error {
  readonly code = 'INVALID_REFRESH_TOKEN';
  constructor() {
    super('Refresh token is invalid, expired, or already revoked');
    this.name = 'InvalidRefreshTokenError';
  }
}

function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

function generateRawToken(): string {
  return randomBytes(32).toString('base64url');
}

export async function issueRefreshToken(
  userId: string,
  family: string,
  ipAddress: string | undefined,
  userAgent: string | undefined,
): Promise<{ rawToken: string; tokenId: string }> {
  const rawToken = generateRawToken();
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + config.JWT_REFRESH_TOKEN_TTL * 1000);

  const record = await prisma.refreshToken.create({
    data: {
      userId,
      tokenHash,
      family,
      expiresAt,
      ipAddress: ipAddress ?? null,
      userAgent: userAgent ?? null,
    },
    select: { id: true },
  });

  return { rawToken, tokenId: record.id };
}

export async function issueInitialRefreshToken(
  userId: string,
  ipAddress: string | undefined,
  userAgent: string | undefined,
): Promise<{ rawToken: string; tokenId: string; family: string }> {
  const family = randomUUID();
  const { rawToken, tokenId } = await issueRefreshToken(userId, family, ipAddress, userAgent);
  return { rawToken, tokenId, family };
}

export async function rotateRefreshToken(
  rawToken: string,
  ipAddress: string | undefined,
  userAgent: string | undefined,
): Promise<{ rawToken: string; tokenId: string; userId: string }> {
  const tokenHash = hashToken(rawToken);

  // Find the presented token
  const existing = await prisma.refreshToken.findUnique({
    where: { tokenHash },
    select: {
      id: true,
      userId: true,
      family: true,
      expiresAt: true,
      revokedAt: true,
      replacedById: true,
    },
  });

  if (!existing) {
    // Token doesn't exist — likely tampered or already garbage-collected
    throw new InvalidRefreshTokenError();
  }

  if (existing.revokedAt !== null) {
    // Token was already revoked — check if it was rotated (reuse) or revoked by logout
    if (existing.replacedById !== null) {
      // This token was previously rotated but is being presented again — REUSE DETECTED
      logger.warn(
        { userId: existing.userId, family: existing.family, tokenId: existing.id },
        'SECURITY: Refresh token reuse detected — revoking entire token family',
      );
      await revokeTokenFamily(existing.family);
      throw new TokenReuseDetectedError();
    }
    // Token was explicitly revoked (logout) — reject normally
    throw new InvalidRefreshTokenError();
  }

  if (existing.expiresAt < new Date()) {
    throw new InvalidRefreshTokenError();
  }

  // Issue new token in the same family
  const { rawToken: newRawToken, tokenId: newTokenId } = await issueRefreshToken(
    existing.userId,
    existing.family,
    ipAddress,
    userAgent,
  );

  // Mark the old token as rotated (not revoked by logout — by rotation)
  await prisma.refreshToken.update({
    where: { id: existing.id },
    data: {
      revokedAt: new Date(),
      replacedById: newTokenId,
    },
  });

  return { rawToken: newRawToken, tokenId: newTokenId, userId: existing.userId };
}

export async function revokeRefreshToken(rawToken: string): Promise<void> {
  const tokenHash = hashToken(rawToken);

  const token = await prisma.refreshToken.findUnique({
    where: { tokenHash },
    select: { id: true, family: true, revokedAt: true },
  });

  if (!token || token.revokedAt !== null) {
    // Already revoked or doesn't exist — idempotent, no error
    return;
  }

  // Revoke the entire family so all devices in this session are logged out
  await revokeTokenFamily(token.family);
}

export async function revokeTokenFamily(family: string): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { family, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export async function revokeAllUserTokens(userId: string): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  logger.info({ userId }, 'All refresh tokens revoked for user');
}
