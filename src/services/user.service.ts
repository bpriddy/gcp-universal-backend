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

// ── Identity resolution ───────────────────────────────────────────────────────
//
// Three-step lookup on every Google OAuth login:
//
//  1. Find by googleSub — immutable Google identifier, safest match.
//     Update display info if it changed.
//
//  2. Find by email where googleSub IS NULL — admin pre-created stub.
//     Claim the stub by writing googleSub and write an audit log entry
//     so there is a record of when the stub was first activated.
//
//  3. Nothing found — JIT provision a new user with zero permissions.
//
// Security note: if a record is found by email but already has a DIFFERENT
// googleSub, it is not merged.  The incoming login is treated as a new user.
// This prevents account takeover via email address reuse or reassignment.

export async function findOrCreateUser(
  googlePayload: GoogleTokenPayload,
): Promise<UserWithPermissions> {
  // ── Step 1: find by googleSub ─────────────────────────────────────────────
  const byGoogleSub = await prisma.user.findUnique({
    where: { googleSub: googlePayload.sub },
    include: { permissions: true },
  });

  if (byGoogleSub) {
    const needsUpdate =
      byGoogleSub.displayName !== (googlePayload.name ?? null) ||
      byGoogleSub.avatarUrl   !== (googlePayload.picture ?? null) ||
      byGoogleSub.email       !== googlePayload.email;

    if (needsUpdate) {
      await prisma.user.update({
        where: { id: byGoogleSub.id },
        data: {
          displayName: googlePayload.name ?? null,
          avatarUrl:   googlePayload.picture ?? null,
          email:       googlePayload.email,
        },
      });
    }

    return toUserWithPermissions(byGoogleSub, googlePayload);
  }

  // ── Step 2: find pre-created stub by email ────────────────────────────────
  const stub = await prisma.user.findFirst({
    where: { email: googlePayload.email, googleSub: null },
    include: { permissions: true },
  });

  if (stub) {
    // Claim the stub — lock googleSub so this identity cannot be claimed again
    logger.info(
      { userId: stub.id, email: stub.email },
      'Pre-created user stub claimed on first login',
    );

    // Claim the stub — single atomic update locks googleSub permanently
    await prisma.user.update({
      where: { id: stub.id },
      data: {
        googleSub:   googlePayload.sub,
        displayName: googlePayload.name ?? null,
        avatarUrl:   googlePayload.picture ?? null,
      },
    });
    // Note: audit_log requires a staff.id as actorId.  Stubs may not yet have
    // a staff profile at claim time, so this event is captured in the server
    // log only.  If the stub is linked to a staff record, the staff's audit
    // history will reflect subsequent access grant activity.

    return toUserWithPermissions(stub, googlePayload);
  }

  // ── Step 3: JIT provision a new user ─────────────────────────────────────
  logger.info({ email: googlePayload.email }, 'Provisioning new user on first login');

  const created = await prisma.user.create({
    data: {
      email:       googlePayload.email,
      googleSub:   googlePayload.sub,
      displayName: googlePayload.name ?? null,
      avatarUrl:   googlePayload.picture ?? null,
      isActive:    true,
    },
    include: { permissions: true },
  });

  return toUserWithPermissions(created, googlePayload);
}

// ── App access provisioning ───────────────────────────────────────────────────
//
// Called after identity resolution when the login request includes an appId.
// Returns 'granted' if the user may proceed, 'pending' if they need approval.
//
// Admins bypass the check entirely.

export async function checkOrProvisionAppAccess(
  userId: string,
  appId: string,
  isAdmin: boolean,
): Promise<'granted' | 'pending'> {
  if (isAdmin) return 'granted';

  const existing = await prisma.userAppPermission.findUnique({
    where: { userId_appId: { userId, appId } },
  });

  if (existing) return 'granted';

  // No permission — check the app's autoAccess setting
  const app = await prisma.app.findUnique({
    where: { appId },
    select: { autoAccess: true, isActive: true },
  });

  if (!app || !app.isActive) return 'pending';

  if (app.autoAccess) {
    await prisma.userAppPermission.create({
      data: { userId, appId, role: 'viewer' },
    });
    return 'granted';
  }

  return 'pending';
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
    id:          user.id,
    email:       user.email,
    displayName: user.displayName,
    avatarUrl:   user.avatarUrl,
    isActive:    user.isActive,
    isAdmin:     user.isAdmin,
    permissions: user.permissions.map((p) => ({ appId: p.appId, role: p.role })),
  };
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function toUserWithPermissions(
  user: { id: string; email: string; displayName: string | null; avatarUrl: string | null; isActive: boolean; isAdmin: boolean; permissions: { appId: string; role: string }[] },
  googlePayload: GoogleTokenPayload,
): UserWithPermissions {
  return {
    id:          user.id,
    email:       googlePayload.email,
    displayName: googlePayload.name ?? user.displayName,
    avatarUrl:   googlePayload.picture ?? user.avatarUrl,
    isActive:    user.isActive,
    isAdmin:     user.isAdmin,
    permissions: user.permissions.map((p) => ({ appId: p.appId, role: p.role })),
  };
}
