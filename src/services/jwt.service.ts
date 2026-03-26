import { SignJWT, jwtVerify, exportJWK, importPKCS8, importSPKI } from 'jose';
import { randomUUID } from 'crypto';
import { config } from '../config/env';
import type { AccessTokenPayload, TokenPermission } from '../types/jwt';

interface UserForToken {
  id: string;
  email: string;
  displayName: string | null;
  permissions: TokenPermission[];
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

export async function signAccessToken(user: UserForToken): Promise<string> {
  await keysReady;

  const token = await new SignJWT({
    email: user.email,
    displayName: user.displayName,
    permissions: user.permissions,
  } satisfies Omit<AccessTokenPayload, 'sub' | 'iss' | 'aud' | 'iat' | 'exp' | 'jti'>)
    .setProtectedHeader({ alg: 'RS256', kid: config.JWT_KEY_ID })
    .setIssuedAt()
    .setIssuer(config.JWT_ISSUER)
    .setAudience(config.JWT_AUDIENCE)
    .setExpirationTime(`${config.JWT_ACCESS_TOKEN_TTL}s`)
    .setSubject(user.id)
    .setJti(randomUUID())
    .sign(privateKey);

  return token;
}

export async function verifyAccessToken(token: string): Promise<AccessTokenPayload> {
  await keysReady;

  const { payload } = await jwtVerify(token, publicKey, {
    issuer: config.JWT_ISSUER,
    audience: config.JWT_AUDIENCE,
    algorithms: ['RS256'],
  });

  // Type assertion safe: SignJWT above always produces this shape
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
