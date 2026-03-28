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
