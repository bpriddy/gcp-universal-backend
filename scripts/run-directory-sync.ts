/**
 * One-off script to run the Google Directory sync against the local database.
 *
 * Usage: npx tsx scripts/run-directory-sync.ts
 */

import 'dotenv/config';
import { runDirectoryFullSync } from '../src/modules/integrations/google-directory/directory.cron';
import { prisma } from '../src/config/database';

async function main() {
  console.log('Starting Google Directory sync against local DB...\n');

  const result = await runDirectoryFullSync();

  console.log('\n=== Sync Complete ===');
  console.log('Run ID:', result.runId);
  console.log('Counters:', JSON.stringify(result.counters, null, 2));

  // Fetch the sync run to display the summary
  const run = await prisma.syncRun.findUnique({ where: { id: result.runId } });
  if (run?.summary) {
    console.log('\n=== SYNC RUN SUMMARY ===');
    console.log(run.summary);
  }

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error('Fatal error:', err);
  await prisma.$disconnect();
  process.exit(1);
});
