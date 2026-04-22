/**
 * hard-filters.ts — Two deterministic rules that run before the LLM.
 *
 * Only bright-line cases live here. Everything that's a judgment call
 * (group mailbox? team inbox? placeholder account? no-reply / bot?) goes
 * to the LLM. A rule only belongs here if it's justifiable without any
 * interpretation at all:
 *
 *   1. unmappable      — missing email or displayName (nothing to classify)
 *   2. external_domain — email domain not in PRIMARY_DOMAINS
 *
 * Notably NOT here: no-reply / bounce / mailer-daemon addresses. These
 * ARE non-people, but they're handled by the LLM in the same pass as
 * every other service account — the prompt calls them out explicitly.
 * Keeping them in code would be duplicate work and would be another
 * place to update when conventions shift.
 *
 * PRIMARY_DOMAINS is org-specific. When we onboard a second org or move
 * off Google Directory, this becomes a config value (env var or DB row).
 */

import type { ClassifierInput, Classification } from './types';

/** Primary email domain(s). Entries on other domains are skipped. */
const PRIMARY_DOMAINS = new Set(['anomaly.com']);

export interface HardFilterResult {
  /** Entries that survive all hard rules — hand to the LLM. */
  kept: ClassifierInput[];
  /** Entries eliminated by a hard rule — record in the sync log. */
  skipped: Classification[];
}

export function applyHardFilters(entries: ClassifierInput[]): HardFilterResult {
  const kept: ClassifierInput[] = [];
  const skipped: Classification[] = [];

  for (const entry of entries) {
    const { email, displayName } = entry;

    // Rule 1: missing email OR displayName → unmappable.
    if (!email || !displayName) {
      skipped.push({
        kind: 'skip',
        input: entry,
        reason: 'unmappable',
        detail: !email ? 'no email on directory entry' : 'no display name on directory entry',
        source: 'hard_filter',
      });
      continue;
    }

    const parts = email.toLowerCase().split('@');
    const domain = parts[1] ?? '';

    // Rule 2: external domain. Subdomains of primary (e.g. news.anomaly.com)
    // are also treated as external — they're typically newsletter senders,
    // never human accounts.
    if (!domain || !PRIMARY_DOMAINS.has(domain)) {
      const isSubdomain = [...PRIMARY_DOMAINS].some((pd) => domain.endsWith(`.${pd}`));
      skipped.push({
        kind: 'skip',
        input: entry,
        reason: 'external_domain',
        detail: isSubdomain
          ? `subdomain sender: ${email}`
          : `external domain: ${domain || '(none)'}`,
        source: 'hard_filter',
      });
      continue;
    }

    kept.push(entry);
  }

  return { kept, skipped };
}
