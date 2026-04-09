/**
 * drive.sync.ts — Extract sparse campaign state from Google Drive folders.
 *
 * Stub — the sync logic depends on folder conventions not yet defined.
 * See README.md in this directory.
 */

import { logger } from '../../../services/logger';

export interface DriveSyncResult {
  foldersScanned: number;
  changesWritten: number;
  errors: number;
}

export async function runDriveSync(): Promise<DriveSyncResult> {
  logger.info('Google Drive sync: starting (stub — no folder conventions defined yet)');

  // TODO: Implement:
  // 1. listProjectFolders(config.DRIVE_PROJECTS_FOLDER_ID)
  // 2. For each folder: readProjectState(folderId)
  // 3. Map extracted state to account_changes / campaign_changes
  // 4. Diff against last known values; write only actual changes

  return { foldersScanned: 0, changesWritten: 0, errors: 0 };
}
