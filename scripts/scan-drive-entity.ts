/**
 * Scan a single account or campaign end-to-end (traverse → extract → Gemini → proposals).
 *
 * Usage:
 *   npx tsx scripts/scan-drive-entity.ts account <account_uuid>
 *   npx tsx scripts/scan-drive-entity.ts campaign <campaign_uuid>
 *
 * The entity must have drive_folder_id set, and the service account must be
 * shared into that folder. If GEMINI_API_KEY is unset, interpretation runs
 * against the mock driver (zero observations).
 */

import 'dotenv/config';
import { prisma } from '../src/config/database';
import { scanEntity } from '../src/modules/integrations/google-drive/drive.orchestrator';

async function main() {
  const entityType = process.argv[2];
  const entityId = process.argv[3];
  if (!entityType || !entityId || (entityType !== 'account' && entityType !== 'campaign')) {
    console.error('Usage: npx tsx scripts/scan-drive-entity.ts <account|campaign> <uuid>');
    process.exit(1);
  }

  const run = await prisma.syncRun.create({
    data: { source: 'google_drive', status: 'running' },
  });
  console.log(`Sync run id: ${run.id}`);

  const start = Date.now();
  try {
    const result = await scanEntity({
      entityType: entityType as 'account' | 'campaign',
      entityId,
      syncRunId: run.id,
    });

    await prisma.syncRun.update({
      where: { id: run.id },
      data: {
        status: 'success',
        completedAt: new Date(),
        durationMs: Date.now() - start,
        totalScanned: result.scan.filesSeen,
        updated: result.scan.filesExtracted,
        skipped:
          result.scan.filesSkippedDelta +
          result.scan.filesSkippedMime +
          result.scan.filesSkippedSize +
          result.scan.filesEmpty,
        errored: result.scan.errors,
        summary: JSON.stringify(result, null, 2),
      },
    });

    console.log('\n=== Scan complete ===');
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    await prisma.syncRun.update({
      where: { id: run.id },
      data: {
        status: 'failed',
        completedAt: new Date(),
        durationMs: Date.now() - start,
        summary: err instanceof Error ? err.message : String(err),
      },
    });
    throw err;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('scan-drive-entity failed:', err);
  process.exit(1);
});
