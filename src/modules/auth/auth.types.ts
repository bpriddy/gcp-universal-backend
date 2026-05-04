export class AccountDisabledError extends Error {
  readonly code = 'ACCOUNT_DISABLED';
  constructor() {
    super('This account has been disabled. Contact your administrator.');
    this.name = 'AccountDisabledError';
  }
}

export interface AuthResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  tokenType: 'Bearer';
  user: {
    id: string;
    email: string;
    displayName: string | null;
    avatarUrl: string | null;
  };
}

