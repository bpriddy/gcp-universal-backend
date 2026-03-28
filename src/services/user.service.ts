import { prisma } from '../config/database';
import type { GoogleTokenPayload } from './google.service';
import type { TokenPermission } from '../types/jwt';
import { logger } from './logger';

export interface UserWithPermissions {
  id: string;
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
  isActive: boolean;
  isAdmin: boolean;
  permissions: TokenPermission[];
}

export async function findOrCreateUser(
  googlePayload: GoogleTokenPayload,
): Promise<UserWithPermissions> {
  const existing = await prisma.user.findUnique({
    where: { googleSub: googlePayload.sub },
    include: { permissions: true },
  });

  if (existing) {
    // Update display info if it changed in Google's directory
    const needsUpdate =
      existing.displayName !== (googlePayload.name ?? null) ||
      existing.avatarUrl !== (googlePayload.picture ?? null);

    if (needsUpdate) {
      await prisma.user.update({
        where: { id: existing.id },
        data: {
          displayName: googlePayload.name ?? null,
          avatarUrl: googlePayload.picture ?? null,
          // Also update email in case user changed their Google account email
          email: googlePayload.email,
        },
      });
    }

    return {
      id: existing.id,
      email: googlePayload.email,
      displayName: googlePayload.name ?? existing.displayName,
      avatarUrl: googlePayload.picture ?? existing.avatarUrl,
      isActive: existing.isActive,
      isAdmin: existing.isAdmin,
      permissions: existing.permissions.map((p) => ({
        appId: p.appId,
        dbIdentifier: p.dbIdentifier,
        role: p.role,
      })),
    };
  }

  // JIT provisioning: create user with zero permissions on first login
  logger.info({ email: googlePayload.email }, 'Provisioning new user on first login');

  const created = await prisma.user.create({
    data: {
      email: googlePayload.email,
      googleSub: googlePayload.sub,
      displayName: googlePayload.name ?? null,
      avatarUrl: googlePayload.picture ?? null,
      isActive: true,
    },
    include: { permissions: true },
  });

  return {
    id: created.id,
    email: created.email,
    displayName: created.displayName,
    avatarUrl: created.avatarUrl,
    isActive: created.isActive,
    isAdmin: created.isAdmin,
    permissions: [],
  };
}

export async function getUserWithPermissions(
  userId: string,
): Promise<UserWithPermissions | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { permissions: true },
  });

  if (!user) return null;

  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    isActive: user.isActive,
    isAdmin: user.isAdmin,
    permissions: user.permissions.map((p) => ({
      appId: p.appId,
      dbIdentifier: p.dbIdentifier,
      role: p.role,
    })),
  };
}
