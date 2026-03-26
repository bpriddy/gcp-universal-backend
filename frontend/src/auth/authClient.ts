/**
 * authClient.ts
 * Low-level functions for talking to the backend auth endpoints.
 * No framework dependencies — plain fetch calls.
 */

const BASE_URL = import.meta.env['VITE_API_BASE_URL'] ?? '';

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

export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
}

export class AuthApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'AuthApiError';
  }
}

async function handleResponse<T>(res: Response): Promise<T> {
  if (res.ok) {
    if (res.status === 204) return undefined as T;
    return res.json() as Promise<T>;
  }
  let body: ApiError = { code: 'UNKNOWN_ERROR', message: 'An unknown error occurred' };
  try {
    body = (await res.json()) as ApiError;
  } catch {
    // ignore parse failure
  }
  throw new AuthApiError(body.code, body.message, res.status);
}

/** Exchange a Google ID token for our JWT access + refresh tokens. */
export async function loginWithGoogle(idToken: string): Promise<AuthResponse> {
  const res = await fetch(`${BASE_URL}/auth/google`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken }),
  });
  return handleResponse<AuthResponse>(res);
}

/** Rotate a refresh token to get new access + refresh tokens. */
export async function refreshTokens(refreshToken: string): Promise<AuthResponse> {
  const res = await fetch(`${BASE_URL}/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  });
  return handleResponse<AuthResponse>(res);
}

/** Revoke the current session (this device only). */
export async function logout(refreshToken: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/auth/logout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  });
  return handleResponse<void>(res);
}

/** Revoke all sessions for this user (all devices). */
export async function logoutAll(accessToken: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/auth/logout-all`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return handleResponse<void>(res);
}
