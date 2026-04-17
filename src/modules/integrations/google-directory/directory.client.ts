/**
 * directory.client.ts — Google Workspace Directory API client.
 *
 * Fetches all domain profiles from the Google People API listDirectoryPeople
 * endpoint — the same data visible at contacts.google.com/directory.
 *
 * Auth: service account with domain-wide delegation, impersonating a domain user.
 * Scope: https://www.googleapis.com/auth/directory.readonly
 */

import { google, type people_v1 } from 'googleapis';
import { config } from '../../../config/env';
import { logger } from '../../../services/logger';

// ── Types ────────────────────────────────────────────────────────────────────

export type DirectoryPerson = people_v1.Schema$Person;

// Every field the People API can return for a directory person.
// We ask for everything; the mapper decides what to keep.
const READ_MASK = [
  'addresses',
  'biographies',
  'birthdays',
  'emailAddresses',
  'externalIds',
  'genders',
  'locations',
  'memberships',
  'metadata',
  'names',
  'nicknames',
  'occupations',
  'organizations',
  'phoneNumbers',
  'photos',
  'relations',
  'sipAddresses',
  'skills',
  'urls',
].join(',');

// ── Auth ─────────────────────────────────────────────────────────────────────

function buildAuth() {
  const impersonateEmail = config.GOOGLE_DIRECTORY_IMPERSONATE_EMAIL;
  if (!impersonateEmail) {
    throw new Error('Google Directory sync requires GOOGLE_DIRECTORY_IMPERSONATE_EMAIL');
  }

  const keyFileOrCredentials = config.GOOGLE_DIRECTORY_SA_KEY_PATH
    ? { keyFile: config.GOOGLE_DIRECTORY_SA_KEY_PATH }
    : config.GOOGLE_DIRECTORY_SA_KEY_B64
      ? {
          credentials: JSON.parse(
            Buffer.from(config.GOOGLE_DIRECTORY_SA_KEY_B64, 'base64').toString('utf-8'),
          ) as Record<string, unknown>,
        }
      : null;

  if (!keyFileOrCredentials) {
    throw new Error(
      'Google Directory sync requires GOOGLE_DIRECTORY_SA_KEY_PATH or GOOGLE_DIRECTORY_SA_KEY_B64',
    );
  }

  return new google.auth.GoogleAuth({
    ...keyFileOrCredentials,
    scopes: ['https://www.googleapis.com/auth/directory.readonly'],
    clientOptions: {
      subject: impersonateEmail,
    },
  });
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetch all domain profiles from the Google Workspace directory.
 * Handles pagination automatically.
 */
export async function fetchAllDirectoryPeople(): Promise<DirectoryPerson[]> {
  const auth = buildAuth();
  const people = google.people({ version: 'v1', auth });

  const allPeople: DirectoryPerson[] = [];
  let pageToken: string | undefined;

  do {
    const res = await people.people.listDirectoryPeople({
      sources: ['DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE'],
      readMask: READ_MASK,
      pageSize: 1000,
      ...(pageToken ? { pageToken } : {}),
    });

    const page = res.data?.people ?? [];
    allPeople.push(...page);

    pageToken = res.data?.nextPageToken ?? undefined;
    logger.debug({ pageSize: page.length, total: allPeople.length }, 'Directory: fetched page');
  } while (pageToken);

  return allPeople;
}
