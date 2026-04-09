/**
 * workfront.cron.ts — Full Workfront → accounts/campaigns sync.
 *
 * Fetches all active projects and applies each one.
 * Run on a daily schedule via Cloud Scheduler → POST /integrations/workfront/cron
 */

import { fetchAllProjects } from './workfront.client';
import { mapWorkfrontProject } from './workfront.mapper';
import { applyWorkfrontProject } from './workfront.sync';
import { logger } from '../../../services/logger';

export interface WorkfrontSyncResult {
  total: number;
  created: number;
  updated: number;
  unchanged: number;
  skipped: number;
  errors: number;
}

export async function runWorkfrontFullSync(): Promise<WorkfrontSyncResult> {
  logger.info('Workfront full sync: starting');

  const projects = await fetchAllProjects();
  logger.info({ count: projects.length }, 'Workfront full sync: fetched projects');

  let created = 0;
  let updated = 0;
  let unchanged = 0;
  let skipped = 0;
  let errors = 0;

  for (const project of projects) {
    const mapped = mapWorkfrontProject(project);

    if (!mapped.campaign.name) {
      skipped++;
      continue;
    }

    try {
      const result = await applyWorkfrontProject(mapped);
      switch (result) {
        case 'created': created++; break;
        case 'updated': updated++; break;
        case 'unchanged': unchanged++; break;
      }
    } catch (err) {
      errors++;
      logger.error(
        { err, workfrontId: mapped.campaign.workfrontId, name: mapped.campaign.name },
        'Workfront sync: failed to apply project',
      );
    }
  }

  const result: WorkfrontSyncResult = { total: projects.length, created, updated, unchanged, skipped, errors };
  logger.info(result, 'Workfront full sync: complete');
  return result;
}
