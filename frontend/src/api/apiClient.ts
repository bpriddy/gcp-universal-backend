/**
 * apiClient.ts
 * Authenticated fetch wrapper.
 *
 * - Automatically attaches the Bearer token to every request.
 * - Proactively refreshes the access token when it's near expiry.
 * - On 401, attempts one token refresh then retries the original request.
 * - On second 401 (refresh also failed), clears the session and throws.
 */

import { getValidAccessToken, clearSession } from '../auth/tokenStore';
import { AuthApiError } from '../auth/authClient';

const BASE_URL = import.meta.env['VITE_API_BASE_URL'] ?? '';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

export interface RequestOptions {
  method?: HttpMethod;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface ApiResponse<T> {
  data: T;
  status: number;
}

async function request<T>(
  path: string,
  options: RequestOptions = {},
  isRetry = false,
): Promise<ApiResponse<T>> {
  let accessToken: string;

  try {
    accessToken = await getValidAccessToken();
  } catch {
    // No valid session at all — caller should redirect to login
    clearSession();
    throw new AuthApiError('SESSION_EXPIRED', 'Your session has expired. Please log in again.', 401);
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    ...options.headers,
  };

  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(`${BASE_URL}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  // 401 on first attempt → try refreshing then retry once
  if (res.status === 401 && !isRetry) {
    // Force a token refresh by invalidating the cached access token
    // (getValidAccessToken will pick up the refresh token and issue a new one)
    try {
      // Clear in-memory token to force refresh on next getValidAccessToken call
      // We do this by calling refresh directly
      const { refreshTokens } = await import('../auth/authClient');
      const { getRefreshToken, setSession } = await import('../auth/tokenStore');
      const rt = getRefreshToken();
      if (!rt) throw new Error('no refresh token');
      const fresh = await refreshTokens(rt);
      setSession(fresh);
      return request<T>(path, options, true);
    } catch {
      clearSession();
      throw new AuthApiError('SESSION_EXPIRED', 'Your session has expired. Please log in again.', 401);
    }
  }

  if (!res.ok) {
    let body: { code?: string; message?: string } = {};
    try { body = await res.json() as typeof body; } catch { /* ignore */ }
    throw new AuthApiError(
      body.code ?? 'API_ERROR',
      body.message ?? `Request failed with status ${res.status}`,
      res.status,
    );
  }

  if (res.status === 204) {
    return { data: undefined as T, status: 204 };
  }

  const data = await res.json() as T;
  return { data, status: res.status };
}

export const apiClient = {
  get: <T>(path: string, headers?: Record<string, string>) =>
    request<T>(path, { method: 'GET', headers }),

  post: <T>(path: string, body?: unknown, headers?: Record<string, string>) =>
    request<T>(path, { method: 'POST', body, headers }),

  put: <T>(path: string, body?: unknown, headers?: Record<string, string>) =>
    request<T>(path, { method: 'PUT', body, headers }),

  delete: <T>(path: string, headers?: Record<string, string>) =>
    request<T>(path, { method: 'DELETE', headers }),
};
