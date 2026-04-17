/**
 * Probe the mail module end-to-end.
 *
 * Usage:
 *   npx tsx scripts/send-test-mail.ts you@example.com
 *
 * Behaviour:
 *   MAIL_DRIVER=console  → logs a dry-run message (no dispatch)
 *   MAIL_DRIVER=mailgun  → actually sends via Mailgun (requires MAILGUN_API_KEY + MAILGUN_DOMAIN + MAIL_FROM_ADDRESS; MAILGUN_REGION defaults to 'us')
 */

import 'dotenv/config';
import { mail } from '../src/modules/mail';

async function main() {
  const recipient = process.argv[2];
  if (!recipient) {
    console.error('Usage: npx tsx scripts/send-test-mail.ts <recipient@example.com>');
    process.exit(1);
  }

  const result = await mail.send({
    to: { email: recipient },
    subject: 'GUB mail module test',
    text: 'If you see this, the GUB mail module is wired up.',
    html: '<p>If you see this, the <strong>GUB mail module</strong> is wired up.</p>',
    tags: { source: 'send-test-mail', env: process.env['NODE_ENV'] ?? 'unknown' },
  });

  console.log('Send result:', result);
}

main().catch((err) => {
  console.error('send-test-mail failed:', err);
  process.exit(1);
});
