/**
 * Scan one Drive folder end-to-end (traverse → extract → snapshot → logs).
 *
 * Usage:
 *   npx tsx scripts/scan-drive-folder.ts <folderId> [--account <uuid>] [--campaign <uuid>] [--label "Name"]
 *
 * Requires:
 *   GOOGLE_DRIVE_SA_KEY_PATH or _B64 (falls back to GOOGLE_DIRECTORY_SA_KEY_*)
 *   The service account must be shared into the target folder.
 */

import 'dotenv/config';
import { prisma } from '../src/config/database';
import { scanFolder } from '../src/modules/integrations/google-drive/drive.sync';

function flag(name: string): string | null {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return null;
  return process.argv[idx + 1] ?? null;
}

async function main() {
  const folderId = process.argv[2];
  if (!folderId || folderId.startsWith('--')) {
    console.error(
      'Usage: npx tsx scripts/scan-drive-folder.ts <folderId> [--account <uuid>] [--campaign <uuid>] [--label "Name"]',
    );
    process.exit(1);
  }
  const accountId = flag('account');
  const campaignId = flag('campaign');
  const label = flag('label') ?? folderId;

  const run = await prisma.syncRun.create({
    data: { source: 'google_drive', status: 'running' },
  });
  console.log(`Sync run id: ${run.id}`);

  const start = Date.now();
  try {
    const result = await scanFolder({
      folderId,
      folderLabel: label,
      scope: { accountId: accountId ?? null, campaignId: campaignId ?? null },
      syncRunId: run.id,
      // No onExtract in Phase 3 — Phase 4 wires in Gemini.
    });

    await prisma.syncRun.update({
      where: { id: run.id },
      data: {
        status: 'success',
        completedAt: new Date(),
        durationMs: Date.now() - start,
        totalScanned: result.filesSeen,
        updated: result.filesExtracted,
        skipped:
          result.filesSkippedDelta +
          result.filesSkippedMime +
          result.filesSkippedSize +
          result.filesEmpty,
        errored: result.errors,
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
  console.error('scan-drive-folder failed:', err);
  process.exit(1);
});
