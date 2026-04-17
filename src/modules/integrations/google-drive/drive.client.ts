/**
 * drive.client.ts — Google Drive API client.
 *
 * Auth: service account. Folders must be shared with the SA's email.
 * Optional domain-wide delegation via GOOGLE_DRIVE_IMPERSONATE_EMAIL.
 *
 * Falls back to the Directory SA (GOOGLE_DIRECTORY_SA_*) when drive-specific
 * keys aren't set — convenient for dev with one SA.
 *
 * Auth is built lazily. Importing this module never touches env, so the
 * backend boots even before the SA key is filled in.
 */

import { google, type drive_v3 } from 'googleapis';
import { Readable } from 'stream';
import { config } from '../../../config/env';

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
      '(or falls back to GOOGLE_DIRECTORY_SA_KEY_* if that is set).',
  );
}

export function buildDriveAuth(): InstanceType<typeof google.auth.GoogleAuth> {
  const keyMaterial = readKey();
  const impersonate = config.GOOGLE_DRIVE_IMPERSONATE_EMAIL;
  return new google.auth.GoogleAuth({
    ...keyMaterial,
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
    ...(impersonate ? { clientOptions: { subject: impersonate } } : {}),
  });
}

let cachedClient: drive_v3.Drive | null = null;
export function driveClient(): drive_v3.Drive {
  if (cachedClient) return cachedClient;
  const auth = buildDriveAuth();
  cachedClient = google.drive({ version: 'v3', auth });
  return cachedClient;
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
