import { OAuth2Client } from 'google-auth-library';
import { prisma } from '../config/database';
import { config } from '../config/env';
import { logger } from './logger';

/**
 * Google ID-token verification with strict same-row pairing against the
 * trusted_apps registry.
 *
 * ── Two-stage check ────────────────────────────────────────────────────────
 *   1. Cryptographic verification — Google's verifyIdToken: signature,
 *      expiration, issuer, and `aud` is in the union of all active
 *      trusted_apps.googleClientIds. (Plus the env-configured
 *      GOOGLE_CLIENT_ID, which auto-seeds via ensureSelfTrustedApp at boot.)
 *
 *   2. Pairing check (only when origin is provided / enforcePairing) —
 *      after cryptographic verification succeeds, look for a trusted_apps
 *      row where the verified `aud` AND the request's Origin header are
 *      both present. If no such row, reject with AUDIENCE_ORIGIN_MISMATCH.
 *
 *      A "derivative" environment (e.g. someone forked the work-flows
 *      Replit project) won't share a row with the parent — its origin
 *      lives on its own trusted_apps row (or none, if it isn't registered)
 *      and won't match the parent's google_client_ids. This is the whole
 *      point of pairing — derivatives don't inherit access.
 *
 * ── Why pairing happens here, not in middleware ────────────────────────────
 * The audience claim is inside the JWT — the middleware doesn't see it
 * before the body is parsed. Pairing has to live next to the
 * verifyIdToken call. The CORS-layer originAllowList stays as the coarse
 * first gate ("origin is on SOME row") and this function adds the fine-
 * grained gate ("origin and aud are on the SAME row").
 *
 * ── Broker / non-browser callers ───────────────────────────────────────────
 * The OAuth broker callback (broker.service.ts) is a server-to-server
 * flow with no Origin header. It calls verifyGoogleToken without options;
 * pairing is skipped, but the audience must still be on some active row
 * (GUB's own client_id auto-seeds via ensureSelfTrustedApp at boot).
 *
 * ── Boot-time self-seed (ensureSelfTrustedApp) ─────────────────────────────
 * The migration that created trusted_apps left google_client_ids empty.
 * On every app start, ensureSelfTrustedApp runs once and inserts a
 * "GUB itself" row holding the env GOOGLE_CLIENT_ID if no active row
 * already covers it. Without this, the broker would break after migration.
 */

export interface GoogleTokenPayload {
  /** Stable Google user ID — use as the primary user identifier, not email */
  sub: string;
  email: string;
  email_verified: boolean;
  name: string | undefined;
  picture: string | undefined;
}

export interface VerifyGoogleTokenOptions {
  /**
   * The browser Origin header of the request that delivered this token.
   * When set, the verifier enforces strict same-row pairing: the token's
   * `aud` and this origin must both appear on a single active
   * trusted_apps row. When unset (broker, server-to-server), the pairing
   * check is skipped — only the audience-on-some-row check runs.
   */
  origin?: string | undefined;
}

// Singleton OAuth2Client — reuses HTTP connections and caches Google's
// public certs across calls.
const client = new OAuth2Client();

export async function verifyGoogleToken(
  idToken: string,
  options: VerifyGoogleTokenOptions = {},
): Promise<GoogleTokenPayload> {
  // 1. Pull the live audience allow-list from the DB.
  const allowedAudiences = await getActiveAudiences();

  if (allowedAudiences.length === 0) {
    // Hard misconfig — the table is empty / no active rows. Sign-in is
    // impossible until an operator registers a trusted app. Fail with a
    // distinct code so the surface message is clear.
    throw new GoogleAuthError(
      'AUDIENCES_REGISTRY_EMPTY',
      'No trusted apps are configured on this GUB instance. ' +
        'A GUB admin must register the consuming app via gub-admin → Settings → Trusted apps before users can sign in.',
    );
  }

  // 2. Cryptographic verification against the live allow-list.
  let ticket;
  try {
    ticket = await client.verifyIdToken({
      idToken,
      audience: allowedAudiences,
    });
  } catch (err) {
    // google-auth-library lumps several distinct failures into a single
    // throw: signature mismatch, expiry, AND audience-not-allowed all
    // raise here. Try to pull the aud claim out of the unverified header
    // to disambiguate — if we can read aud and it isn't on the list, we
    // can return the much friendlier AUDIENCE_NOT_REGISTERED.
    const aud = decodeUnverifiedAudience(idToken);

    if (aud && !allowedAudiences.includes(aud)) {
      logger.warn(
        { aud, allowedAudiencesCount: allowedAudiences.length },
        '[verifyGoogleToken] aud not in trusted_apps registry',
      );
      throw new GoogleAuthError(
        'AUDIENCE_NOT_REGISTERED',
        `The Google client_id '${aud}' is not registered as part of any trusted app on this GUB instance. ` +
          `Ask a GUB admin to add it via the gub-admin Trusted Apps settings page.`,
        { audience: aud },
      );
    }

    logger.warn({ err }, 'Google ID token verification failed');
    throw new GoogleAuthError(
      'INVALID_GOOGLE_TOKEN',
      'Invalid or expired Google ID token',
    );
  }

  const payload = ticket.getPayload();
  if (!payload) {
    throw new GoogleAuthError('INVALID_GOOGLE_TOKEN', 'Google token payload is empty');
  }

  if (!payload['email_verified']) {
    throw new GoogleAuthError('EMAIL_NOT_VERIFIED', 'Google account email is not verified');
  }

  if (!payload['sub'] || !payload['email']) {
    throw new GoogleAuthError(
      'INVALID_GOOGLE_TOKEN',
      'Google token missing required claims (sub, email)',
    );
  }

  // 3. Strict same-row pairing — only when an Origin header is present
  // (i.e. this is a browser-initiated request, not a server-to-server
  // broker callback).
  const verifiedAud = payload['aud'] as string | undefined;
  if (options.origin && verifiedAud) {
    const paired = await isAudienceOriginPaired(verifiedAud, options.origin);
    if (!paired) {
      logger.warn(
        { aud: verifiedAud, origin: options.origin },
        '[verifyGoogleToken] aud and origin not paired on a trusted_apps row',
      );
      throw new GoogleAuthError(
        'AUDIENCE_ORIGIN_MISMATCH',
        `The Google client_id '${verifiedAud}' is registered, but origin '${options.origin}' isn't on the same trusted-app row. ` +
          `Forks and derivatives don't inherit access — ask a GUB admin to register this origin (and client_id, if it's distinct) as its own trusted app.`,
        { audience: verifiedAud, origin: options.origin },
      );
    }
  }

  return {
    sub: payload['sub'],
    email: payload['email'],
    email_verified: payload['email_verified'] ?? false,
    name: payload['name'],
    picture: payload['picture'],
  };
}

/**
 * Live audience list = union of all active trusted_apps.googleClientIds,
 * plus the env-configured GOOGLE_CLIENT_ID (belt and suspenders — the
 * auto-seed should have put it on a row, but if someone deactivated that
 * row the env var keeps GUB-self sign-in working).
 */
async function getActiveAudiences(): Promise<string[]> {
  const rows = await prisma.trustedApp.findMany({
    where: { isActive: true },
    select: { googleClientIds: true },
  });
  const fromDb = rows.flatMap((r) => r.googleClientIds);
  return Array.from(new Set([config.GOOGLE_CLIENT_ID, ...fromDb])).filter(Boolean);
}

/**
 * Same-row pairing check: is there an active trusted_apps row that has
 * BOTH the audience and the origin on it?
 */
async function isAudienceOriginPaired(audience: string, origin: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM trusted_apps
    WHERE is_active = true
      AND ${audience} = ANY(google_client_ids)
      AND ${origin} = ANY(origins)
    LIMIT 1
  `;
  return rows.length > 0;
}

/**
 * Pull the `aud` claim out of an unverified JWT. Used ONLY to provide a
 * better error message when verification fails — never as authentication
 * input. If parsing fails, returns null.
 */
function decodeUnverifiedAudience(idToken: string): string | null {
  try {
    const parts = idToken.split('.');
    if (parts.length < 2) return null;
    const payloadB64 = parts[1]!;
    const padded = payloadB64 + '==='.slice((payloadB64.length + 3) % 4);
    const json = Buffer.from(padded, 'base64url').toString('utf-8');
    const claims = JSON.parse(json) as { aud?: unknown };
    return typeof claims.aud === 'string' ? claims.aud : null;
  } catch {
    return null;
  }
}

/**
 * Boot-time idempotent seed: ensures the env GOOGLE_CLIENT_ID appears on
 * at least one active trusted_apps row. Without this, post-migration the
 * broker can't verify any token (its `aud` is GUB's own client_id, which
 * starts out on no row).
 *
 * Called once from src/server.ts at startup. Safe to re-run; no-op if a
 * row already covers GUB's client_id.
 */
export async function ensureSelfTrustedApp(): Promise<void> {
  const clientId = config.GOOGLE_CLIENT_ID;
  if (!clientId) return;

  const existing = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM trusted_apps
    WHERE is_active = true AND ${clientId} = ANY(google_client_ids)
    LIMIT 1
  `;
  if (existing.length > 0) return;

  await prisma.trustedApp.create({
    data: {
      name: 'GUB itself (auto-seeded)',
      origins: [],
      googleClientIds: [clientId],
      isActive: true,
    },
  });
  logger.info(
    { clientId },
    '[ensureSelfTrustedApp] seeded GUB-self trusted_apps row for env GOOGLE_CLIENT_ID',
  );
}

/**
 * Domain error for Google authentication failures.
 *
 * The `code` field is the stable identifier; SDKs/clients should pivot
 * on it. The `message` is human-readable and safe to display directly to
 * an implementer (it carries actionable hints when applicable). The
 * `details` object carries structured context — e.g. which audience or
 * origin was rejected — that the SDK can render or log.
 */
export type GoogleAuthErrorCode =
  | 'INVALID_GOOGLE_TOKEN'
  | 'EMAIL_NOT_VERIFIED'
  | 'AUDIENCE_NOT_REGISTERED'
  | 'AUDIENCE_ORIGIN_MISMATCH'
  | 'AUDIENCES_REGISTRY_EMPTY';

export class GoogleAuthError extends Error {
  readonly code: GoogleAuthErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: GoogleAuthErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'GoogleAuthError';
    this.code = code;
    this.details = details;
  }
}
