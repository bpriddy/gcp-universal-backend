/**
 * drive.client.ts — Google Drive API client.
 *
 * ── Auth (two paths) ────────────────────────────────────────────────────────
 *
 * Path A (legacy, key-file based — kept as fallback for dev without IT setup):
 *   - Reads a service-account JSON key from GOOGLE_DRIVE_SA_KEY_PATH /
 *     _B64 (or falls back to GOOGLE_DIRECTORY_SA_KEY_*).
 *   - Optionally adds DWD via GOOGLE_DRIVE_IMPERSONATE_EMAIL on the JWT.
 *   - Selected when GOOGLE_DRIVE_TARGET_SA is unset.
 *
 * Path B (preferred, STS impersonation chain — production posture):
 *   - Cloud Run runtime SA uses Application Default Credentials (no key file).
 *   - Calls iamcredentials.signJwt to sign a JWT *as* GOOGLE_DRIVE_TARGET_SA.
 *     Runtime SA needs roles/iam.serviceAccountTokenCreator on the target SA.
 *   - The signed JWT carries sub=GOOGLE_DRIVE_IMPERSONATE_EMAIL (the bot user)
 *     so domain-wide delegation impersonates that user when the JWT is
 *     exchanged for an access token at oauth2.googleapis.com/token.
 *   - The Workspace admin grants DWD with scope drive.readonly to
 *     GOOGLE_DRIVE_TARGET_SA only — NOT to the runtime SA.
 *   - Selected when GOOGLE_DRIVE_TARGET_SA is set.
 *
 * Why two paths exist:
 *   The current dev deployment uses Path A with the Directory SA's key.
 *   When IT provisions the dedicated Drive SA + grants DWD, we set
 *   GOOGLE_DRIVE_TARGET_SA in the Cloud Run env and the runtime auto-switches
 *   to Path B. The legacy code path remains for any environment that hasn't
 *   migrated yet.
 *
 * ── Egress filter (defense in depth) ────────────────────────────────────────
 *
 * Both paths route every Drive auth through assertSubjectAllowed(), which
 * checks the impersonation subject against the boot-time configured value.
 * The check is tautological in normal flow (we always pass the configured
 * value) — its job is to make any future code path that takes a subject
 * from somewhere else (a request param, an arbitrary helper) fail loudly
 * rather than silently widen the impersonation scope.
 *
 * The real defense remains: the only place the subject is read from is
 * config.GOOGLE_DRIVE_IMPERSONATE_EMAIL (boot-time env), and the auth
 * builders never accept it as a parameter. The assertion guards against
 * future refactors that might break that invariant.
 */

import { google, type drive_v3 } from 'googleapis';
import { Readable } from 'stream';
import { config } from '../../../config/env';
import { logger } from '../../../services/logger';

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const JWT_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:jwt-bearer';

// ── Egress filter ────────────────────────────────────────────────────────────
// The bot user we're configured to impersonate. Read once at module load.
// All auth paths must call assertSubjectAllowed before configuring DWD; an
// attempt to impersonate any other user fails loudly.
const ALLOWED_DWD_SUBJECT = config.GOOGLE_DRIVE_IMPERSONATE_EMAIL;

function assertSubjectAllowed(subject: string): void {
  if (subject !== ALLOWED_DWD_SUBJECT) {
    const msg =
      `[drive.client] DWD subject "${subject}" does not match configured ` +
      `GOOGLE_DRIVE_IMPERSONATE_EMAIL. Refusing to widen impersonation scope.`;
    logger.error({ requestedSubject: subject, allowedSubject: ALLOWED_DWD_SUBJECT }, msg);
    throw new Error(msg);
  }
}

// ── Path A: legacy key-file auth ────────────────────────────────────────────

function readKey(): { keyFile: string } | { credentials: Record<string, unknown> } {
  const path = config.GOOGLE_DRIVE_SA_KEY_PATH ?? config.GOOGLE_DIRECTORY_SA_KEY_PATH;
  const b64 = config.GOOGLE_DRIVE_SA_KEY_B64 ?? config.GOOGLE_DIRECTORY_SA_KEY_B64;
  if (path) return { keyFile: path };
  if (b64) {
    return {
      credentials: JSON.parse(Buffer.from(b64, 'base64').toString('utf-8')) as Record<string, unknown>,
    };
  }
  throw new Error(
    'Google Drive sync requires GOOGLE_DRIVE_SA_KEY_PATH or GOOGLE_DRIVE_SA_KEY_B64 ' +
      '(or falls back to GOOGLE_DIRECTORY_SA_KEY_* if that is set), ' +
      'OR set GOOGLE_DRIVE_TARGET_SA to use the STS impersonation chain instead.',
  );
}

function buildLegacyKeyAuth(): InstanceType<typeof google.auth.GoogleAuth> {
  const keyMaterial = readKey();
  const impersonate = config.GOOGLE_DRIVE_IMPERSONATE_EMAIL;
  if (impersonate) assertSubjectAllowed(impersonate);
  return new google.auth.GoogleAuth({
    ...keyMaterial,
    scopes: [DRIVE_SCOPE],
    ...(impersonate ? { clientOptions: { subject: impersonate } } : {}),
  });
}

// ── Path B: STS impersonation chain (no key file) ───────────────────────────

interface CachedToken {
  accessToken: string;
  expiresAt: number; // ms since epoch
}

let cachedDriveToken: CachedToken | null = null;

/**
 * Sign a JWT *as* the target SA, with the DWD subject in the payload.
 * Then exchange the JWT for an access token at the Google OAuth2 endpoint.
 *
 * Caches the resulting token until ~5 minutes before its expiry; refreshes
 * transparently on the next call.
 */
async function getOptionBAccessToken(): Promise<string> {
  const targetSa = config.GOOGLE_DRIVE_TARGET_SA;
  const dwdSubject = config.GOOGLE_DRIVE_IMPERSONATE_EMAIL;

  if (!targetSa) {
    throw new Error(
      'GOOGLE_DRIVE_TARGET_SA is required for the STS impersonation chain (Path B).',
    );
  }
  if (!dwdSubject) {
    throw new Error(
      'GOOGLE_DRIVE_IMPERSONATE_EMAIL (the @anomaly.com bot user) is required for DWD.',
    );
  }
  assertSubjectAllowed(dwdSubject);

  const now = Date.now();
  if (cachedDriveToken && cachedDriveToken.expiresAt > now + 5 * 60_000) {
    return cachedDriveToken.accessToken;
  }

  // Step 1: build the JWT payload. iss=target SA (signer), sub=bot user (DWD).
  const nowSec = Math.floor(now / 1000);
  const payload = JSON.stringify({
    iss: targetSa,
    sub: dwdSubject,
    aud: TOKEN_URL,
    scope: DRIVE_SCOPE,
    iat: nowSec,
    exp: nowSec + 3600,
  });

  // Step 2: sign the JWT *as* the target SA via iamcredentials.signJwt.
  // Runtime SA must have roles/iam.serviceAccountTokenCreator on targetSa.
  const adc = new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });
  const iam = google.iamcredentials({ version: 'v1', auth: adc });
  const signResp = await iam.projects.serviceAccounts.signJwt({
    name: `projects/-/serviceAccounts/${targetSa}`,
    requestBody: { payload },
  });
  const signedJwt = signResp.data.signedJwt;
  if (!signedJwt) {
    throw new Error('iamcredentials.signJwt returned no signedJwt');
  }

  // Step 3: exchange the signed JWT for an OAuth2 access token. The token
  // returned has the bot user's identity (DWD) for drive.readonly.
  const tokenResp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: JWT_GRANT_TYPE,
      assertion: signedJwt,
    }),
  });
  if (!tokenResp.ok) {
    const errBody = await tokenResp.text().catch(() => '<unreadable>');
    throw new Error(
      `[drive.client] JWT-bearer token exchange failed: ${tokenResp.status} ${errBody}`,
    );
  }
  const tokenData = (await tokenResp.json()) as {
    access_token: string;
    expires_in: number;
  };

  cachedDriveToken = {
    accessToken: tokenData.access_token,
    expiresAt: now + tokenData.expires_in * 1000,
  };
  return tokenData.access_token;
}

function buildOptionBAuth(): InstanceType<typeof google.auth.OAuth2> {
  // google.auth.OAuth2 (alias for OAuth2Client) supports a refreshHandler
  // that the googleapis library invokes when it needs a fresh token. Our
  // handler delegates to getOptionBAccessToken, which has its own caching
  // layer. The returned expiry_date matches what we cached so the library
  // doesn't double-refresh.
  const oauth = new google.auth.OAuth2();
  oauth.refreshHandler = async () => {
    const access = await getOptionBAccessToken();
    const expiry = cachedDriveToken?.expiresAt ?? Date.now() + 3500 * 1000;
    return { access_token: access, expiry_date: expiry };
  };
  return oauth;
}

// ── Public API ──────────────────────────────────────────────────────────────

/** Path selector. */
function isOptionB(): boolean {
  return Boolean(config.GOOGLE_DRIVE_TARGET_SA);
}

let cachedClient: drive_v3.Drive | null = null;
export function driveClient(): drive_v3.Drive {
  if (cachedClient) return cachedClient;
  if (isOptionB()) {
    logger.info(
      { targetSa: config.GOOGLE_DRIVE_TARGET_SA, botUser: ALLOWED_DWD_SUBJECT },
      '[drive.client] using STS impersonation chain (Path B)',
    );
    cachedClient = google.drive({ version: 'v3', auth: buildOptionBAuth() });
  } else {
    logger.info('[drive.client] using legacy key-file auth (Path A)');
    cachedClient = google.drive({ version: 'v3', auth: buildLegacyKeyAuth() });
  }
  return cachedClient;
}

// Kept exported for backward compatibility — callers that built their own
// auth from this previously will get the right path automatically.
export function buildDriveAuth():
  | InstanceType<typeof google.auth.GoogleAuth>
  | InstanceType<typeof google.auth.OAuth2> {
  return isOptionB() ? buildOptionBAuth() : buildLegacyKeyAuth();
}

// ── Low-level helpers ────────────────────────────────────────────────────────

/** Fields we always request on a file. */
export const FILE_FIELDS =
  'id,name,mimeType,parents,modifiedTime,size,lastModifyingUser(emailAddress,displayName)';

/**
 * List immediate children of a folder, following pagination.
 * Includes both files and subfolders. Trashed items excluded.
 */
export async function listFolderChildren(folderId: string): Promise<drive_v3.Schema$File[]> {
  const client = driveClient();
  const out: drive_v3.Schema$File[] = [];
  let pageToken: string | undefined;
  do {
    const res = await client.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: `nextPageToken, files(${FILE_FIELDS})`,
      pageSize: 200,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      ...(pageToken ? { pageToken } : {}),
    });
    out.push(...(res.data.files ?? []));
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return out;
}

/**
 * Download file bytes via `files.get(alt=media)`.
 * Use `exportMedia` instead for Google-native docs (Docs/Sheets/Slides).
 */
export async function downloadFileBuffer(fileId: string): Promise<Buffer> {
  const client = driveClient();
  const res = await client.files.get(
    { fileId, alt: 'media', supportsAllDrives: true },
    { responseType: 'stream' },
  );
  return streamToBuffer(res.data as Readable);
}

/**
 * Export a Google-native doc to a specific mime type (e.g. text/plain for Docs).
 */
export async function exportFileBuffer(fileId: string, mimeType: string): Promise<Buffer> {
  const client = driveClient();
  const res = await client.files.export(
    { fileId, mimeType },
    { responseType: 'stream' },
  );
  return streamToBuffer(res.data as Readable);
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBuffer));
  }
  return Buffer.concat(chunks);
}

// ── Changes API (incremental polling) ─────────────────────────────────────────

/**
 * Ask Drive for a fresh start page token. The token represents "right now —
 * any subsequent change is captured." Persist it; pass to `listChanges` later.
 *
 * Used at the end of /run-full-sync (so the very first /poll has a token to
 * call from) and as the recovery path when a previously-saved token has
 * expired (~7 days idle).
 */
export async function getStartPageToken(): Promise<string> {
  const client = driveClient();
  const res = await client.changes.getStartPageToken({
    supportsAllDrives: true,
  });
  if (!res.data.startPageToken) {
    throw new Error('Drive returned no startPageToken');
  }
  return res.data.startPageToken;
}

/**
 * The fields we care about per change. `removed` flags deletions; `file` carries
 * the post-change file metadata when available. `fileId` is always present.
 */
export const CHANGE_FIELDS =
  'fileId,removed,changeType,time,file(id,name,mimeType,parents,modifiedTime,size,trashed,lastModifyingUser(emailAddress,displayName))';

/**
 * Iterate all changes since `startToken`, paginating internally. Yields the
 * full list of changes plus the terminal `newStartPageToken` to persist for
 * the next call.
 *
 * Critical contract:
 *   - `nextPageToken` (intermediate) is followed automatically. Callers never
 *     see it. Don't persist intermediate tokens; doing so would cause the
 *     next poll to re-process the changes between intermediate and terminal.
 *   - `newStartPageToken` (terminal, returned only on the last page) is what
 *     callers persist for the next poll cycle.
 *
 * Throws `PageTokenExpiredError` when Drive returns 410 / INVALID_PAGE_TOKEN —
 * the saved token aged past Drive's ~7-day idle window. Recovery: clear
 * persisted token, run /run-full-sync to bootstrap, persist the fresh token
 * captured at end of run.
 */
export class PageTokenExpiredError extends Error {
  constructor() {
    super('Drive page token has expired (>7d idle). Re-run /run-full-sync to recover.');
    this.name = 'PageTokenExpiredError';
  }
}

export interface ListChangesResult {
  changes: drive_v3.Schema$Change[];
  newStartPageToken: string;
}

export async function listChanges(startToken: string): Promise<ListChangesResult> {
  const client = driveClient();
  const all: drive_v3.Schema$Change[] = [];
  let pageToken: string | undefined = startToken;
  let newStartPageToken: string | undefined;

  while (pageToken) {
    let res;
    try {
      res = await client.changes.list({
        pageToken,
        fields: `nextPageToken, newStartPageToken, changes(${CHANGE_FIELDS})`,
        pageSize: 100,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        // Restrict to "my drive"-ish surface: only changes for files the SA
        // can see. We additionally filter to our configured root tree at
        // the consumer (drive.poll.ts) as a defensive belt.
        spaces: 'drive',
      });
    } catch (err) {
      if (isPageTokenExpired(err)) {
        throw new PageTokenExpiredError();
      }
      throw err;
    }

    all.push(...(res.data.changes ?? []));
    newStartPageToken = res.data.newStartPageToken ?? undefined;
    pageToken = res.data.nextPageToken ?? undefined;
  }

  if (!newStartPageToken) {
    // Drive's contract: every paginated terminal response includes
    // newStartPageToken. If it's missing, something is wrong; treat as
    // expired and bootstrap rather than silently saving nothing.
    throw new PageTokenExpiredError();
  }

  return { changes: all, newStartPageToken };
}

/** Drive returns 410 with reason="invalidPageToken" when the token has aged out. */
function isPageTokenExpired(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: number; errors?: Array<{ reason?: string }> };
  if (e.code === 410) return true;
  if (Array.isArray(e.errors)) {
    return e.errors.some((x) => x?.reason === 'invalidPageToken');
  }
  return false;
}

/**
 * Walk parent references upward from `fileId` until we find `rootFolderId` or
 * exhaust parents. Used as a defensive belt in drive.poll.ts: even though
 * changes.list only returns files the SA can see (which should be just our
 * root tree), an inheritance-broken subfolder could theoretically widen
 * visibility. We reject anything outside the configured root.
 *
 * Returns `true` if `fileId` is inside `rootFolderId` (or is the root itself).
 *
 * Note: this runs `files.get` per ancestor lookup. Cache miss cost scales
 * with tree depth, not breadth. Acceptable for the typical client/project
 * folder shape (3–5 levels deep). If trees get truly deep, add a parent-id
 * cache.
 */
export async function isInsideFolder(
  fileId: string,
  rootFolderId: string,
): Promise<boolean> {
  if (fileId === rootFolderId) return true;
  const client = driveClient();
  const visited = new Set<string>();
  let current = fileId;
  while (current && !visited.has(current)) {
    visited.add(current);
    let res;
    try {
      res = await client.files.get({
        fileId: current,
        fields: 'id,parents',
        supportsAllDrives: true,
      });
    } catch (err) {
      const e = err as { code?: number };
      if (e?.code === 404) return false; // file/parent gone — not inside
      throw err;
    }
    const parents = res.data.parents ?? [];
    if (parents.includes(rootFolderId)) return true;
    if (parents.length === 0) return false; // root reached
    current = parents[0]!; // walk first parent (shared-drive files have at most one)
  }
  return false;
}
