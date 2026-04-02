import { config } from '../../../config/env';

// ── Okta API types ────────────────────────────────────────────────────────────

export interface OktaUserProfile {
  firstName: string;
  lastName: string;
  login: string;
  email: string;
  title?: string | null;
  department?: string | null;
  city?: string | null;
  startDate?: string | null; // ISO date string e.g. "2020-01-15T00:00:00.000Z"
  employeeNumber?: string | null;
}

export type OktaStatus =
  | 'ACTIVE'
  | 'STAGED'
  | 'PROVISIONED'
  | 'RECOVERY'
  | 'PASSWORD_EXPIRED'
  | 'LOCKED_OUT'
  | 'DEPROVISIONED'
  | 'SUSPENDED';

export interface OktaUser {
  id: string;
  status: OktaStatus;
  profile: OktaUserProfile;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function baseUrl(): string {
  return `${config.OKTA_ORG_URL}/api/v1`;
}

function headers(): Record<string, string> {
  return {
    Authorization: `SSWS ${config.OKTA_API_TOKEN}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Fetch all users from Okta with statuses ACTIVE, SUSPENDED, or DEPROVISIONED.
 * Follows Link header pagination automatically.
 */
export async function fetchAllOktaUsers(): Promise<OktaUser[]> {
  const users: OktaUser[] = [];

  // filter uses Okta expression language; encode spaces as +
  const filter = encodeURIComponent(
    'status eq "ACTIVE" or status eq "SUSPENDED" or status eq "DEPROVISIONED"',
  );
  let url: string | null = `${baseUrl()}/users?limit=200&filter=${filter}`;

  while (url) {
    const currentUrl: string = url;
    const res: Response = await fetch(currentUrl, { headers: headers() });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Okta API error ${res.status}: ${body}`);
    }

    const page = (await res.json()) as OktaUser[];
    users.push(...page);

    // Follow Link: <url>; rel="next" pagination header
    const linkHeader: string = res.headers.get('link') ?? '';
    const match: RegExpMatchArray | null = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
    url = match ? match[1] ?? null : null;
  }

  return users;
}

/**
 * Fetch a single Okta user by their Okta user ID.
 * Returns null if the user does not exist (404).
 */
export async function fetchOktaUserById(oktaId: string): Promise<OktaUser | null> {
  const res = await fetch(`${baseUrl()}/users/${oktaId}`, { headers: headers() });

  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Okta API error ${res.status}: ${body}`);
  }

  return (await res.json()) as OktaUser;
}
