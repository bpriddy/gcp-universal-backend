// ── Errors ────────────────────────────────────────────────────────────────

export class AccessDeniedError extends Error {
  readonly code = 'ACCESS_DENIED';
  constructor() {
    super('You do not have access to this resource');
    this.name = 'AccessDeniedError';
  }
}

// ── Response shapes returned by the org API ───────────────────────────────
// These mirror the SDK types in sdk/backend/index.ts.
// Changes here should be reflected there.

export interface AccountCurrentState {
  [property: string]: string | null;
}

export interface AccountResponse {
  id: string;
  name: string;
  parentId: string | null;
  currentState: AccountCurrentState;
  createdAt: Date;
  updatedAt: Date;
}

export interface CampaignResponse {
  id: string;
  accountId: string;
  name: string;
  status: string;
  budget: string | null;
  assetsUrl: string | null;
  awardedAt: Date | null;
  liveAt: Date | null;
  endsAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ChangeLogEntry {
  id: string;
  property: string;
  valueText: string | null;
  valueUuid: string | null;
  valueDate: string | null;
  changedBy: string | null;
  changedAt: Date;
}

// Offices and Teams mirror the Account change-log pattern — a `currentState`
// map resolved from their *_changes history, alongside the base row fields.

export interface OfficeCurrentState {
  [property: string]: string | null;
}

export interface OfficeResponse {
  id: string;
  name: string;
  syncCity: string | null;
  isActive: boolean;
  startedAt: Date | null;
  currentState: OfficeCurrentState;
  createdAt: Date;
  updatedAt: Date;
}

export interface TeamCurrentState {
  [property: string]: string | null;
}

export interface TeamMemberSummary {
  staffId: string;
  fullName: string;
  email: string;
  title: string | null;
}

export interface TeamResponse {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
  startedAt: Date | null;
  members: TeamMemberSummary[];
  currentState: TeamCurrentState;
  createdAt: Date;
  updatedAt: Date;
}

// Users are Google OAuth identities — distinct from Staff (org employees).
// A user may or may not have a staff profile. List is admin-only; by-id is
// admin or self. Sensitive fields (googleSub, refreshTokens, etc.) are
// deliberately excluded from this public shape.

export interface UserResponse {
  id: string;
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
  role: string;
  isAdmin: boolean;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface StaffResponse {
  id: string;
  fullName: string;
  email: string;
  title: string | null;
  department: string | null;
  status: string;
  startedAt: Date;
  endedAt: Date | null;
}
