/**
 * groups.client.ts — Google Workspace Groups API client.
 *
 * Fetches all domain Workspace groups (the same data visible at
 * groups.google.com/all-groups) plus per-group member lists.
 *
 * Uses the Admin SDK Directory API (NOT the People API used by the
 * Directory sync — same SA, different API). Specifically:
 *   - `directory_v1.groups.list({domain})` → all groups in the domain
 *   - `directory_v1.members.list({groupKey})` → members of one group
 *
 * Auth: service account with domain-wide delegation, impersonating a
 * domain user. Reuses the same SA + impersonation email as the Directory
 * sync (see GOOGLE_DIRECTORY_SA_KEY_* / GOOGLE_DIRECTORY_IMPERSONATE_EMAIL).
 *
 * Scopes (must be added to the DWD client whitelist in Workspace Admin —
 * piggy-backing the contacts workstream IT is already running):
 *   - https://www.googleapis.com/auth/admin.directory.group.readonly
 *   - https://www.googleapis.com/auth/admin.directory.group.member.readonly
 */

import { google, type admin_directory_v1 } from 'googleapis';
import { config } from '../../../config/env';
import { logger } from '../../../services/logger';

// ── Types ────────────────────────────────────────────────────────────────────

export type DirectoryGroup = admin_directory_v1.Schema$Group;
export type DirectoryMember = admin_directory_v1.Schema$Member;

const SCOPES = [
  'https://www.googleapis.com/auth/admin.directory.group.readonly',
  'https://www.googleapis.com/auth/admin.directory.group.member.readonly',
];

// ── Auth ─────────────────────────────────────────────────────────────────────

function readKey(): { keyFile: string } | { credentials: Record<string, unknown> } {
  // Reuses the Directory SA env vars. If the Workspace admin grants the
  // Groups scopes to the same DWD client, the same key works for both.
  const path = config.GOOGLE_DIRECTORY_SA_KEY_PATH;
  const b64 = config.GOOGLE_DIRECTORY_SA_KEY_B64;
  if (path) return { keyFile: path };
  if (b64) {
    return {
      credentials: JSON.parse(Buffer.from(b64, 'base64').toString('utf-8')) as Record<string, unknown>,
    };
  }
  throw new Error(
    'Google Groups sync requires GOOGLE_DIRECTORY_SA_KEY_PATH or GOOGLE_DIRECTORY_SA_KEY_B64 (same SA as the Directory sync).',
  );
}

let cachedClient: admin_directory_v1.Admin | null = null;

function adminClient(): admin_directory_v1.Admin {
  if (cachedClient) return cachedClient;
  const subject = config.GOOGLE_DIRECTORY_IMPERSONATE_EMAIL;
  if (!subject) {
    throw new Error(
      'GOOGLE_DIRECTORY_IMPERSONATE_EMAIL is required (the @anomaly.com user the SA impersonates via DWD).',
    );
  }
  const auth = new google.auth.GoogleAuth({
    ...readKey(),
    scopes: SCOPES,
    clientOptions: { subject },
  });
  cachedClient = google.admin({ version: 'directory_v1', auth });
  return cachedClient;
}

// ── Fetchers ─────────────────────────────────────────────────────────────────

/**
 * List every group in the configured domain. Paginates internally.
 * Returns the full set in memory — domains with thousands of groups
 * would need a streaming variant; for this org's scale, this is fine.
 */
export async function fetchAllGroups(): Promise<DirectoryGroup[]> {
  const client = adminClient();
  const domain = config.GOOGLE_GROUPS_DOMAIN;
  if (!domain) {
    throw new Error(
      'GOOGLE_GROUPS_DOMAIN is required (the Workspace domain whose groups to sync, e.g. "anomaly.com").',
    );
  }

  const out: DirectoryGroup[] = [];
  let pageToken: string | undefined;
  do {
    const res = await client.groups.list({
      domain,
      maxResults: 200,
      ...(pageToken ? { pageToken } : {}),
    });
    out.push(...(res.data.groups ?? []));
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  logger.info({ count: out.length, domain }, '[groups.client] fetched all groups');
  return out;
}

/**
 * List members of a single group. Paginates internally.
 *
 * Filters to type='USER' members only — Workspace Groups can also contain
 * other Groups (nested), customer-wide tokens, and external addresses.
 * For team-membership purposes we only care about real human users that
 * we'd resolve to a staff record. Nested groups would expand recursively
 * if we wanted that behavior; for v1 we keep it flat.
 */
export async function fetchGroupMembers(groupKey: string): Promise<DirectoryMember[]> {
  const client = adminClient();
  const out: DirectoryMember[] = [];
  let pageToken: string | undefined;
  do {
    const res = await client.members.list({
      groupKey,
      maxResults: 200,
      ...(pageToken ? { pageToken } : {}),
    });
    for (const m of res.data.members ?? []) {
      if (m.type === 'USER') out.push(m);
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  return out;
}
