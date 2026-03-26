/**
 * tokenStore.ts
 *
 * Token storage strategy:
 *   - Access token  → memory only (module variable). Never persisted.
 *     Lost on page refresh — that's intentional; we re-issue via refresh token on load.
 *   - Refresh token → localStorage.
 *     Trade-off: convenient persistence across tabs/reloads, but XSS-accessible.
 *     For higher security, move to an httpOnly cookie set by the backend.
 *
 * The access token expiry is tracked so the API client can proactively
 * refresh before sending a request rather than waiting for a 401.
 */

import { refreshTokens } from './authClient';
import type { AuthResponse } from './authClient';

const REFRESH_TOKEN_KEY = 'gcp_refresh_token';

// ── In-memory access token state ─────────────────────────────────────────────

interface AccessTokenState {
  token: string;
  /** Unix timestamp (ms) when the token expires */
  expiresAt: number;
  user: AuthResponse['user'];
}

let accessTokenState: AccessTokenState | null = null;

/** How many ms before expiry to proactively refresh (60 seconds). */
const PROACTIVE_REFRESH_BUFFER_MS = 60_000;

// ── Getters / setters ─────────────────────────────────────────────────────────

export function setSession(response: AuthResponse): void {
  accessTokenState = {
    token: response.accessToken,
    expiresAt: Date.now() + response.expiresIn * 1000,
    user: response.user,
  };
  localStorage.setItem(REFRESH_TOKEN_KEY, response.refreshToken);
}

export function clearSession(): void {
  accessTokenState = null;
  localStorage.removeItem(REFRESH_TOKEN_KEY);
}

export function getRefreshToken(): string | null {
  return localStorage.getItem(REFRESH_TOKEN_KEY);
}

export function getUser(): AuthResponse['user'] | null {
  return accessTokenState?.user ?? null;
}

export function isAccessTokenValid(): boolean {
  if (!accessTokenState) return false;
  return Date.now() < accessTokenState.expiresAt - PROACTIVE_REFRESH_BUFFER_MS;
}

export function isLoggedIn(): boolean {
  return getRefreshToken() !== null;
}

// ── Refresh lock — prevents concurrent refresh races ─────────────────────────

let refreshPromise: Promise<string> | null = null;

/**
 * Returns a valid access token, refreshing it first if needed.
 * Multiple concurrent callers share the same in-flight refresh request.
 */
export async function getValidAccessToken(): Promise<string> {
  if (isAccessTokenValid() && accessTokenState) {
    return accessTokenState.token;
  }

  // Re-use an in-flight refresh if one is already running
  if (refreshPromise) {
    return refreshPromise;
  }

  refreshPromise = (async () => {
    const refreshToken = getRefreshToken();
    if (!refreshToken) {
      throw new Error('No refresh token available — user must log in');
    }

    const response = await refreshTokens(refreshToken);
    setSession(response);
    return response.accessToken;
  })().finally(() => {
    refreshPromise = null;
  });

  return refreshPromise;
}
