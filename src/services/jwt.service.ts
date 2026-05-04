import { SignJWT, jwtVerify, exportJWK, importPKCS8, importSPKI } from 'jose';
import { randomUUID } from 'crypto';
import { config } from '../config/env';
import type { AccessTokenPayload } from '../types/jwt';

interface UserForToken {
  id: string;
  email: string;
  displayName: string | null;
  isAdmin: boolean;
}

interface SignOptions {
  /**
   * Per-app audience to add to the token's `aud` claim. When the SDK
   * passes `appId` on /auth/google/exchange, the auth service forwards
   * it here. The token is then signed with `aud = [appId, JWT_AUDIENCE]`
   * — multi-audience so both verifiers succeed:
   *
   *   - Consumer's SDK verifier: checks `aud includes gub.appId` → true.
   *   - GUB's own /org/* verifier (audience=JWT_AUDIENCE): true.
   *
   * Without this, a token would be accepted by exactly one of the two
   * and the consumer's `gub.org()` calls back through to GUB would fail
   * audience verification at GUB's edge.
   *
   * When omitted, the token has `aud = JWT_AUDIENCE` only — matching
   * the legacy single-audience shape.
   */
  appId?: string;
}

// Keys loaded once at module initialization — fail fast if misconfigured
let privateKey: CryptoKey;
let publicKey: CryptoKey;

async function loadKeys(): Promise<void> {
  privateKey = await importPKCS8(config.privateKeyPem, 'RS256');
  publicKey = await importSPKI(config.publicKeyPem, 'RS256');
}

// Initialize immediately — any error here crashes the process intentionally
const keysReady = loadKeys();

export async function signAccessToken(
  user: UserForToken,
  options: SignOptions = {},
): Promise<string> {
  await keysReady;

  const token = await new SignJWT({
    email: user.email,
    displayName: user.displayName,
    isAdmin: user.isAdmin,
  } satisfies Omit<AccessTokenPayload, 'sub' | 'iss' | 'aud' | 'iat' | 'exp' | 'jti'>)
    .setProtectedHeader({ alg: 'RS256', kid: config.JWT_KEY_ID })
    .setIssuedAt()
    .setIssuer(config.JWT_ISSUER)
    .setAudience(options.appId ? [options.appId, config.JWT_AUDIENCE] : config.JWT_AUDIENCE)
    .setExpirationTime(`${config.JWT_ACCESS_TOKEN_TTL}s`)
    .setSubject(user.id)
    .setJti(randomUUID())
    .sign(privateKey);

  return token;
}

export async function verifyAccessToken(token: string): Promise<AccessTokenPayload> {
  await keysReady;

  // GUB's own routes (e.g. /org/*) verify tokens issued for them. Tokens
  // issued with an SDK-provided audience won't match here — those tokens
  // are intended for consuming apps to verify locally with their JWKS,
  // not for round-tripping back through GUB. If a route ever needs to
  // accept multi-audience tokens, this verifier is the place to widen.
  const { payload } = await jwtVerify(token, publicKey, {
    issuer: config.JWT_ISSUER,
    audience: config.JWT_AUDIENCE,
    algorithms: ['RS256'],
  });

  return payload as unknown as AccessTokenPayload;
}

export async function getJwks(): Promise<object> {
  await keysReady;

  const jwk = await exportJWK(publicKey);
  return {
    keys: [
      {
        ...jwk,
        alg: 'RS256',
        use: 'sig',
        kid: config.JWT_KEY_ID,
      },
    ],
  };
}
