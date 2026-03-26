/**
 * useAuth.ts
 * React hook that wires Google Identity Services → backend auth → session state.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { loginWithGoogle, logout as apiLogout, logoutAll as apiLogoutAll, AuthApiError } from './authClient';
import {
  setSession,
  clearSession,
  getRefreshToken,
  getValidAccessToken,
  getUser,
  isLoggedIn,
} from './tokenStore';
import type { AuthResponse } from './authClient';

export type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated' | 'error';

export interface AuthState {
  status: AuthStatus;
  user: AuthResponse['user'] | null;
  error: string | null;
}

export interface UseAuthReturn extends AuthState {
  /** Call this to render the Google Sign-In button into a container element. */
  renderGoogleButton: (container: HTMLElement) => void;
  logout: () => Promise<void>;
  logoutAll: () => Promise<void>;
}

const GOOGLE_CLIENT_ID = import.meta.env['VITE_GOOGLE_CLIENT_ID'] as string;

export function useAuth(): UseAuthReturn {
  const [state, setState] = useState<AuthState>({
    status: 'loading',
    user: null,
    error: null,
  });

  // Track if we attempted a silent restore on mount
  const restoredRef = useRef(false);

  // ── On mount: attempt silent session restore via refresh token ────────────
  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;

    if (!isLoggedIn()) {
      setState({ status: 'unauthenticated', user: null, error: null });
      return;
    }

    // Refresh token exists — try to get a valid access token silently
    getValidAccessToken()
      .then(() => {
        setState({ status: 'authenticated', user: getUser(), error: null });
      })
      .catch(() => {
        // Refresh token is expired or revoked — force re-login
        clearSession();
        setState({ status: 'unauthenticated', user: null, error: null });
      });
  }, []);

  // ── Handle Google credential response ─────────────────────────────────────
  const handleGoogleCredential = useCallback(
    async (credentialResponse: google.accounts.id.CredentialResponse) => {
      setState((s) => ({ ...s, status: 'loading', error: null }));
      try {
        const response = await loginWithGoogle(credentialResponse.credential);
        setSession(response);
        setState({ status: 'authenticated', user: response.user, error: null });
      } catch (err) {
        const message =
          err instanceof AuthApiError ? err.message : 'Login failed — please try again';
        clearSession();
        setState({ status: 'error', user: null, error: message });
      }
    },
    [],
  );

  // ── Render the Google Sign-In button ──────────────────────────────────────
  const renderGoogleButton = useCallback(
    (container: HTMLElement) => {
      if (!window.google?.accounts?.id) {
        console.warn('Google Identity Services not yet loaded');
        return;
      }

      window.google.accounts.id.initialize({
        client_id: GOOGLE_CLIENT_ID,
        callback: (credentialResponse) => {
          void handleGoogleCredential(credentialResponse);
        },
        // Disable One Tap — explicit button only for cleaner UX in this demo
        cancel_on_tap_outside: false,
      });

      window.google.accounts.id.renderButton(container, {
        type: 'standard',
        theme: 'outline',
        size: 'large',
        text: 'signin_with',
        shape: 'rectangular',
        width: 280,
      });
    },
    [handleGoogleCredential],
  );

  // ── Logout (this device) ──────────────────────────────────────────────────
  const logout = useCallback(async () => {
    const refreshToken = getRefreshToken();
    if (refreshToken) {
      try {
        await apiLogout(refreshToken);
      } catch {
        // Best-effort — clear local session regardless
      }
    }
    // Revoke Google session so One Tap doesn't auto-re-login
    window.google?.accounts?.id?.disableAutoSelect();
    clearSession();
    setState({ status: 'unauthenticated', user: null, error: null });
  }, []);

  // ── Logout all devices ────────────────────────────────────────────────────
  const logoutAll = useCallback(async () => {
    try {
      const accessToken = await getValidAccessToken();
      await apiLogoutAll(accessToken);
    } catch {
      // Best-effort
    }
    window.google?.accounts?.id?.disableAutoSelect();
    clearSession();
    setState({ status: 'unauthenticated', user: null, error: null });
  }, []);

  return { ...state, renderGoogleButton, logout, logoutAll };
}
