export interface TokenPermission {
  appId: string;
  dbIdentifier: string;
  role: string;
}

export interface AccessTokenPayload {
  /** User UUID (Prisma users.id) */
  sub: string;
  email: string;
  displayName: string | null;
  permissions: TokenPermission[];
  iss: string;
  aud: string | string[];
  iat: number;
  exp: number;
  /** Unique token ID — enables targeted revocation if needed */
  jti: string;
}

export interface RefreshTokenResult {
  rawToken: string;
  tokenId: string;
  family: string;
}
