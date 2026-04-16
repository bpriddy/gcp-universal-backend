/**
 * Seed a handful of Drive change proposals against an existing account +
 * staff owner so Phase 6 review UI work can proceed without a live Drive
 * scan.
 *
 * Usage:
 *   npx tsx scripts/seed-dev-proposals.ts --account <accountId> --owner <staffId>
 *   npx tsx scripts/seed-dev-proposals.ts --auto
 *
 * `--auto` picks the first account that has an owner_staff_id and seeds
 * against that one.
 *
 * What it creates:
 *   - 3 field_change proposals on that account (status, industry, notes)
 *   - 1 new_entity proposal group (3 rows) simulating a newly-discovered
 *     campaign folder under that same account
 *
 * Emits the magic-link URL to stdout so you can paste into gub-admin or
 * hit /review/:token directly with curl while building the UI.
 */

import 'dotenv/config';
import crypto from 'node:crypto';
import { prisma } from '../src/config/database';
import { config } from '../src/config/env';
import { notifyReviewers } from '../src/modules/integrations/google-drive/drive.notify';

interface Args {
  accountId?: string;
  ownerStaffId?: string;
  auto: boolean;
  notify: boolean;
}

function parseArgs(): Args {
  const out: Args = { auto: false, notify: false };
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === '--auto') out.auto = true;
    else if (a === '--notify') out.notify = true;
    else if (a === '--account') out.accountId = process.argv[++i];
    else if (a === '--owner') out.ownerStaffId = process.argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log(
        'Usage: seed-dev-proposals.ts [--auto] [--account <id>] [--owner <staffId>] [--notify]',
      );
      process.exit(0);
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs();

  // Resolve target account + owner.
  let accountId = args.accountId ?? null;
  let ownerStaffId = args.ownerStaffId ?? null;

  if (args.auto) {
    const account = await prisma.account.findFirst({
      where: { ownerStaffId: { not: null } },
      include: { owner: true },
    });
    if (!account) {
      console.error('No account with an owner_staff_id found. Use --account and --owner explicitly.');
      process.exit(2);
    }
    accountId = account.id;
    ownerStaffId = account.ownerStaffId!;
    console.log(
      `[seed] auto-selected account="${account.name}" (id=${accountId}) owner=${account.owner?.email}`,
    );
  }

  if (!accountId || !ownerStaffId) {
    console.error('Both --account and --owner are required (or use --auto).');
    process.exit(2);
  }

  const account = await prisma.account.findUnique({
    where: { id: accountId },
    include: { owner: true },
  });
  if (!account) {
    console.error(`Account ${accountId} not found`);
    process.exit(2);
  }
  if (!account.owner) {
    console.error(`Account ${accountId} has no linked owner — pick another or set ownerStaffId`);
    process.exit(2);
  }

  const expiresAt = new Date(Date.now() + config.DRIVE_PROPOSAL_TTL_DAYS * 24 * 60 * 60 * 1000);

  // ── 3 field_change proposals against the existing account ────────────────
  const fieldChanges = [
    {
      property: 'status',
      currentValue: account.status ?? null,
      proposedValue: 'active',
      reasoning:
        'Q2 kickoff doc references ongoing engagements with this client. Status should reflect active partnership.',
      confidence: 0.92,
    },
    {
      property: 'industry',
      currentValue: account.industry ?? null,
      proposedValue: 'Consumer Packaged Goods',
      reasoning:
        'Brand brief explicitly positions the brand in the CPG sector (shelf-placement SKUs, retail-first distribution).',
      confidence: 0.88,
    },
    {
      property: 'notes',
      currentValue: account.notes ?? null,
      proposedValue:
        'Renegotiating master agreement in Q3. Legal on the agency side has flagged IP-clause updates.',
      reasoning: 'Summarized from the account ops log entries dated 2026-02-12 and 2026-03-04.',
      confidence: 0.74,
    },
  ];

  let fieldCreated = 0;
  for (const c of fieldChanges) {
    await prisma.driveChangeProposal.create({
      data: {
        kind: 'field_change',
        entityType: 'account',
        accountId,
        campaignId: null,
        property: c.property,
        currentValue: c.currentValue,
        proposedValue: c.proposedValue,
        reasoning: c.reasoning,
        sourceFileIds: ['dev-seed-file-1', 'dev-seed-file-2'],
        confidence: c.confidence,
        state: 'pending',
        reviewToken: crypto.randomBytes(32).toString('hex'),
        reviewerEmail: account.owner.email,
        reviewerStaffId: ownerStaffId,
        expiresAt,
      },
    });
    fieldCreated++;
  }

  // ── 1 new_entity proposal group (a newly-discovered campaign folder) ─────
  const groupId = crypto.randomUUID();
  const sourceFolderId = `dev-folder-${crypto.randomBytes(4).toString('hex')}`;
  const newEntityRows = [
    { property: 'name', proposedValue: 'Summer Campaign 2026' },
    { property: 'status', proposedValue: 'pitch' },
    { property: 'awarded_at', proposedValue: '2026-03-15' },
  ];
  for (const r of newEntityRows) {
    await prisma.driveChangeProposal.create({
      data: {
        kind: 'new_entity',
        proposalGroupId: groupId,
        sourceDriveFolderId: sourceFolderId,
        entityType: 'campaign',
        accountId, // parent account for new-campaign proposals
        campaignId: null,
        property: r.property,
        currentValue: null,
        proposedValue: r.proposedValue,
        reasoning:
          'Folder contains a pitch deck, scope-of-work draft, and a tentative timeline sheet — all consistent with an unannounced campaign engagement.',
        sourceFileIds: ['dev-seed-file-3', 'dev-seed-file-4'],
        confidence: 0.83,
        state: 'pending',
        reviewToken: crypto.randomBytes(32).toString('hex'),
        reviewerEmail: account.owner.email,
        reviewerStaffId: ownerStaffId,
        expiresAt,
      },
    });
  }

  console.log(
    `[seed] created ${fieldCreated} field_change proposals + 1 new_entity group (${newEntityRows.length} rows) against account=${account.name}`,
  );

  // Look up one token to print the magic link.
  const firstToken = await prisma.driveChangeProposal.findFirst({
    where: { reviewerStaffId: ownerStaffId, state: 'pending', notifiedAt: null },
    orderBy: { createdAt: 'asc' },
    select: { reviewToken: true },
  });

  if (firstToken) {
    const base = config.GUB_ADMIN_BASE_URL.replace(/\/$/, '');
    console.log('');
    console.log('Magic-link URL (paste into gub-admin when review page exists):');
    console.log(`  ${base}/drive-review/${firstToken.reviewToken}`);
    console.log('');
    console.log('Or hit the API directly:');
    console.log(`  curl http://localhost:${config.PORT}/integrations/google-drive/review/${firstToken.reviewToken}`);
    console.log('');
  }

  if (args.notify) {
    console.log('[seed] --notify passed; running notifyReviewers()');
    const res = await notifyReviewers();
    console.log('[seed] notify result:', JSON.stringify(res, null, 2));
  } else {
    console.log('[seed] (skip notify — pass --notify to fan out emails via the configured mail driver)');
  }

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
