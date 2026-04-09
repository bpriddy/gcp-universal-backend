/**
 * drive.client.ts — Google Drive API client for project folder scanning.
 *
 * Uses a service account with domain-wide delegation (same pattern as
 * the directory sync) to list folders and read project state files.
 *
 * TODO: Implement once folder conventions are defined.
 * See README.md in this directory for design decisions.
 */

import { google, type drive_v3 } from 'googleapis';
import { config } from '../../../config/env';
import { logger } from '../../../services/logger';

// ── Types ────────────────────────────────────────────────────────────────────

export type DriveFile = drive_v3.Schema$File;

export interface ProjectFolder {
  folderId: string;
  folderName: string;
  /** Files inside the folder — only fetched if needed for state extraction */
  files?: DriveFile[];
}

// ── Auth ─────────────────────────────────────────────────────────────────────

function buildAuth() {
  // Reuses the same service account as directory sync (or a separate one).
  // Scopes needed: drive.readonly (or drive.metadata.readonly for listing only)
  const impersonateEmail = config.GOOGLE_DIRECTORY_IMPERSONATE_EMAIL;
  if (!impersonateEmail) {
    throw new Error('Google Drive sync requires GOOGLE_DIRECTORY_IMPERSONATE_EMAIL');
  }

  const keyFileOrCredentials = config.GOOGLE_DIRECTORY_SA_KEY_PATH
    ? { keyFile: config.GOOGLE_DIRECTORY_SA_KEY_PATH }
    : config.GOOGLE_DIRECTORY_SA_KEY_B64
      ? {
          credentials: JSON.parse(
            Buffer.from(config.GOOGLE_DIRECTORY_SA_KEY_B64, 'base64').toString('utf-8'),
          ) as Record<string, unknown>,
        }
      : null;

  if (!keyFileOrCredentials) {
    throw new Error('Google Drive sync requires a service account key');
  }

  return new google.auth.GoogleAuth({
    ...keyFileOrCredentials,
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
    clientOptions: { subject: impersonateEmail },
  });
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * List project folders under a parent folder or shared drive.
 *
 * Stub — returns empty. Implement once the folder convention is defined.
 */
export async function listProjectFolders(
  _parentFolderId: string,
): Promise<ProjectFolder[]> {
  logger.debug('Google Drive: listProjectFolders called (stub)');

  // TODO: Implement with:
  // const auth = buildAuth();
  // const drive = google.drive({ version: 'v3', auth });
  // const res = await drive.files.list({
  //   q: `'${parentFolderId}' in parents and mimeType='application/vnd.google-apps.folder'`,
  //   fields: 'files(id,name,modifiedTime)',
  //   pageSize: 100,
  // });

  return [];
}

/**
 * Read a "project state" sheet or file from a project folder.
 *
 * Stub — returns null. The shape of this depends entirely on the
 * convention we establish for how project state is recorded.
 */
export async function readProjectState(
  _folderId: string,
): Promise<Record<string, string> | null> {
  logger.debug('Google Drive: readProjectState called (stub)');
  return null;
}
