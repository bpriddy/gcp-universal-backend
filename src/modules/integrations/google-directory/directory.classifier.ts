/**
 * directory.classifier.ts — Classify directory entries as people or non-people.
 *
 * The Google Workspace directory contains real staff alongside group mailboxes,
 * service accounts, and legacy domain entries. This module inspects each entry
 * and returns a classification with a human-readable reason for skipping.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export type Classification =
  | { type: 'person' }
  | { type: 'skipped'; reason: SkipReason; detail: string };

export type SkipReason =
  | 'service_account'    // group mailbox, shared inbox, bot
  | 'external_domain'    // not on the primary domain
  | 'no_reply'           // noreply / no-reply addresses
  | 'newsletter'         // automated sender (news.*, updates@, etc.)
  | 'unmappable';        // no name or email — can't create a staff record

// ── Configuration ────────────────────────────────────────────────────────────

/** Primary email domain(s). Entries on other domains are flagged as external. */
const PRIMARY_DOMAINS = new Set(['anomaly.com']);

/**
 * Email local-part patterns that indicate a group/service account.
 * Matched against the full local part (before the @).
 */
const SERVICE_ACCOUNT_PATTERNS: RegExp[] = [
  // Department / function mailboxes
  /^talent$/i,
  /^(uk|de|cn|ca|us|ny|la|tor|nyc)talent$/i,
  /^(catalent|detalent|cntalent)$/i,
  /^support$/i,
  /^admin$/i,
  /^(it|hr|pr|legal|ops|finance|accounting|payroll|marketing)$/i, // 2-letter departments
  /^(nychr|hrit)$/i,
  /^meetings$/i,
  /^(nyc|la|tor)\.(ap|ar|archive|presentations|fix)$/i,
  /^(ap|ar)$/i,
  /^ap_la$/i,
  /^finance\.forms$/i,
  /^maconomy$/i,
  /^scannsend$/i,
  /^elements$/i,
  /^together$/i,
  /^backups$/i,
  /^labattpo$/i,
  /^thekids$/i,
  /^thelastsilo$/i,
  /^berbackup$/i,
  // Generic function/team mailboxes
  /^(data|dev|devops|sre|security|noreply|alerts|notifications)$/i,
  /^(cia|eotm)$/i, // Anomaly-specific internal groups
  // Monitoring / bot service accounts
  /^(jamf|datadog|newrelic|pagerduty|sentry|rollbar|github|slack)$/i,
  // Test / placeholder accounts
  /^(test|testing|demo|yoda|placeholder|staging|sandbox)$/i,
];

/**
 * Display name patterns that indicate a group/service account.
 * Checked when the email pattern doesn't catch it.
 */
const SERVICE_NAME_PATTERNS: RegExp[] = [
  /^anomaly\s/i,          // "Anomaly NY Talent", "Anomaly Meetings", etc.
  /^(NYC|LA|HR|IT|AP|AR)\s/i,
  /^accounts payable/i,
  /^finance forms/i,
  /^support it/i,
  /^admin anomaly/i,
  /^(the kids|the last silo)$/i,
  /^backups archive$/i,
  /^updates from/i,
  // Common service-account display-name tells:
  /\balerts?\b/i,                    // "JAMF Alerts", "GitHub Alert", "Monitoring Alerts"
  /\b(intelligence|analytics|insights)\b/i,  // "Cultural Intelligence", "Data Analytics"
  /^data\s/i,                         // "Data Analytics", "Data Pipeline"
  /^dev\s/i,                          // "dev anomaly", "Dev Test"
  /\b(test|staging|sandbox|demo)\b/i, // any display name containing these
  /^(eotm|jamf|yoda)\b/i,             // specific placeholders observed in prod data
  /\bnotification/i,                  // "System Notifications"
];

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Classify a directory entry by email and display name.
 * Returns { type: 'person' } or { type: 'skipped', reason, detail }.
 */
export function classifyDirectoryEntry(
  email: string,
  displayName: string,
): Classification {
  if (!email || !displayName) {
    return { type: 'skipped', reason: 'unmappable', detail: 'missing email or name' };
  }

  const parts = email.toLowerCase().split('@');
  const localPart = parts[0] ?? '';
  const domain = parts[1] ?? '';

  // No-reply addresses
  if (/^no[-_.]?reply$/i.test(localPart)) {
    return { type: 'skipped', reason: 'no_reply', detail: `no-reply address: ${email}` };
  }

  // Newsletter / automated senders (subdomains like news.anomaly.com)
  if (domain && !PRIMARY_DOMAINS.has(domain)) {
    // Check if it's a subdomain of a primary domain (e.g. news.anomaly.com)
    const isSubdomain = [...PRIMARY_DOMAINS].some((pd) => domain.endsWith(`.${pd}`));
    if (isSubdomain) {
      return { type: 'skipped', reason: 'newsletter', detail: `subdomain sender: ${email}` };
    }

    // External domain entirely
    return { type: 'skipped', reason: 'external_domain', detail: `external domain: ${domain}` };
  }

  // Service account — match on email local part
  for (const pattern of SERVICE_ACCOUNT_PATTERNS) {
    if (pattern.test(localPart)) {
      return { type: 'skipped', reason: 'service_account', detail: `group/service email: ${email}` };
    }
  }

  // Service account — match on display name
  for (const pattern of SERVICE_NAME_PATTERNS) {
    if (pattern.test(displayName)) {
      return { type: 'skipped', reason: 'service_account', detail: `group/service name: "${displayName}"` };
    }
  }

  return { type: 'person' };
}
