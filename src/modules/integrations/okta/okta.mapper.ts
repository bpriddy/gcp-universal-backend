import type { OktaUser, OktaStatus } from './okta.client';

// ── Types ─────────────────────────────────────────────────────────────────────

export type StaffStatus = 'active' | 'on_leave' | 'former';

export interface MappedStaff {
  oktaId: string;
  fullName: string;
  email: string;
  title: string | null;
  department: string | null;
  status: StaffStatus;
  /** The Okta profile.city value — used to look up the office record via offices.okta_city */
  oktaCity: string | null;
  startedAt: Date | null;
}

// ── Public API ────────────────────────────────────────────────────────────────

export function mapOktaUser(user: OktaUser): MappedStaff {
  const { profile } = user;

  return {
    oktaId: user.id,
    fullName: `${profile.firstName ?? ''} ${profile.lastName ?? ''}`.trim(),
    email: profile.email ?? profile.login,
    title: profile.title ?? null,
    department: profile.department ?? null,
    status: mapOktaStatus(user.status),
    oktaCity: profile.city ?? null,
    startedAt: parseDate(profile.startDate),
  };
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function mapOktaStatus(status: OktaStatus): StaffStatus {
  switch (status) {
    case 'ACTIVE':
    case 'RECOVERY':
    case 'PASSWORD_EXPIRED':
    case 'LOCKED_OUT':
      return 'active';

    case 'SUSPENDED':
      return 'on_leave';

    case 'DEPROVISIONED':
      return 'former';

    // STAGED / PROVISIONED: not yet fully onboarded — treat conservatively
    default:
      return 'former';
  }
}

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}
