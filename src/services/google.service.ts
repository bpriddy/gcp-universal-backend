import { OAuth2Client } from 'google-auth-library';
import { config } from '../config/env';
import { logger } from './logger';

export interface GoogleTokenPayload {
  /** Stable Google user ID — use as the primary user identifier, not email */
  sub: string;
  email: string;
  email_verified: boolean;
  name: string | undefined;
  picture: string | undefined;
}

// Singleton client — reuses HTTP connections and caches Google's public certs
const client = new OAuth2Client();

export async function verifyGoogleToken(idToken: string): Promise<GoogleTokenPayload> {
  let ticket;
  try {
    ticket = await client.verifyIdToken({
      idToken,
      audience: config.GOOGLE_ALLOWED_AUDIENCES,
    });
  } catch (err) {
    logger.warn({ err }, 'Google ID token verification failed');
    throw new GoogleAuthError('Invalid or expired Google ID token');
  }

  const payload = ticket.getPayload();
  if (!payload) {
    throw new GoogleAuthError('Google token payload is empty');
  }

  if (!payload['email_verified']) {
    throw new GoogleAuthError('Google account email is not verified');
  }

  if (!payload['sub'] || !payload['email']) {
    throw new GoogleAuthError('Google token missing required claims (sub, email)');
  }

  return {
    sub: payload['sub'],
    email: payload['email'],
    email_verified: payload['email_verified'] ?? false,
    name: payload['name'],
    picture: payload['picture'],
  };
}

export class GoogleAuthError extends Error {
  readonly code = 'INVALID_GOOGLE_TOKEN';
  constructor(message: string) {
    super(message);
    this.name = 'GoogleAuthError';
  }
}
