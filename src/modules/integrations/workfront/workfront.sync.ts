/**
 * workfront.sync.ts — Apply Workfront project data to accounts and campaigns.
 *
 * Follows the same diff-and-change-log pattern as the Google Directory
 * syncs, but targets accounts + campaigns instead of staff.
 *
 * - Accounts are resolved by name (upsert).
 * - Campaigns are tracked via staff_external_ids (system: 'workfront').
 * - Change rows are written to account_changes / campaign_changes.
 *
 * TODO: Implement once Workfront API access is available and field mapping
 * is confirmed.
 */

import { prisma } from '../../../config/database';
import { logger } from '../../../services/logger';
import type { MappedWorkfrontResult } from './workfront.mapper';

export type SyncSource = 'workfront_sync';

/**
 * Apply a single Workfront project to the accounts/campaigns tables.
 *
 * Stub — logs the mapped data and returns without writing.
 * Remove the early return once field mapping is validated.
 */
export async function applyWorkfrontProject(
  mapped: MappedWorkfrontResult,
  source: SyncSource = 'workfront_sync',
): Promise<'created' | 'updated' | 'unchanged'> {
  logger.debug(
    { workfrontId: mapped.campaign.workfrontId, name: mapped.campaign.name, account: mapped.account?.name },
    'Workfront sync: would apply project (stub)',
  );

  // TODO: Implement the following:
  // 1. Resolve or create the account by name
  // 2. Look up campaign by external ID (system: 'workfront', externalId: workfrontId)
  //    — NOTE: campaigns don't have external IDs yet; a migration will be needed
  //    — Alternative: use a metadata entry or a dedicated field
  // 3. If new: create campaign + write change rows
  // 4. If existing: diff status, budget, dates; write only actual changes
  // 5. Resolve ownerName → staff.id for createdBy (best-effort match)

  return 'unchanged';
}
