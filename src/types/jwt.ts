export interface AccessTokenPayload {
  /** User UUID (Prisma users.id) */
  sub: string;
  email: string;
  displayName: string | null;
  /** Superuser flag — bypasses all access_grants checks when true */
  isAdmin: boolean;
  iss: string;
  /**
   * Audience claim. When the SDK passes an `appId` on
   * /auth/google/exchange, this is set to that appId — binding the token
   * to the consuming app it was issued for. Without an appId, falls back
   * to config.JWT_AUDIENCE. Consumers verify with `aud === their.appId`.
   */
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
