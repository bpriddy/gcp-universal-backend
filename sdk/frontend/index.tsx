/**
 * GUB Frontend SDK
 *
 * React SDK for the GCP Universal Backend.
 *
 * Install:
 *   npm install github:bpriddy/gcp-universal-backend @react-oauth/google
 *
 * Usage:
 *   import { GUBProvider, useGUB } from 'gcp-universal-backend/frontend'
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { GoogleOAuthProvider, useGoogleLogin } from '@react-oauth/google';

// ── Types ──────────────────────────────────────────────────────────────────

export interface TokenPermission {
  appId: string;
  dbIdentifier: string;
  role: string;
}

export interface GUBUser {
  sub: string;
  email: string;
  displayName: string | null;
  permissions: TokenPermission[];
  exp: number;
}

export interface GUBConfig {
  /** GUB backend URL — e.g. https://gub.yourdomain.com */
  gubUrl: string;
  /** Google OAuth client ID */
  googleClientId: string;
  /** App ID — must match a UserAppPermission row in GUB */
  appId: string;
}

export interface GUBContextValue {
  /** Authenticated user, or null if not logged in */
  user: GUBUser | null;
  /** True while login/token refresh is in progress */
  isLoading: boolean;
  /** True if the user is authenticated */
  isAuthenticated: boolean;
  /** Initiate Google OAuth login flow */
  login: () => void;
  /** Clear session and tokens */
  logout: () => void;
  /**
   * Authenticated fetch — automatically attaches Authorization header
   * and handles token refresh on 401.
   *
   * Usage:
   *   const { fetch: authFetch } = useGUB()
   *   const data = await authFetch('https://api.yourdomain.com/endpoint')
   */
  fetch: (input: RequestInfo, init?: RequestInit) => Promise<Response>;
  /**
   * Raw access token — use only if you need the JWT directly.
   * Prefer fetch() for making authenticated requests.
   */
  accessToken: string | null;
}

// ── Internal token storage ─────────────────────────────────────────────────
// Tokens are stored in memory only — never localStorage or sessionStorage.
// This prevents XSS token theft. Tokens are lost on page refresh (by design —
// the refresh token flow re-issues them automatically).

let _accessToken: string | null = null;
let _refreshToken: string | null = null;

// ── Context ────────────────────────────────────────────────────────────────

const GUBContext = createContext<GUBContextValue | null>(null);

// ── Provider internals ─────────────────────────────────────────────────────

interface GUBProviderInnerProps {
  config: GUBConfig;
  children: React.ReactNode;
}

function GUBProviderInner({ config, children }: GUBProviderInnerProps) {
  const [user, setUser] = useState<GUBUser | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Exchange Google credential for a GUB JWT
  const exchangeGoogleCredential = useCallback(
    async (googleAccessToken: string) => {
      setIsLoading(true);
      try {
        const res = await window.fetch(`${config.gubUrl}/auth/google`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            accessToken: googleAccessToken,
            appId: config.appId,
          }),
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.message ?? 'Authentication failed');
        }

        const data = await res.json();
        storeTokens(data.accessToken, data.refreshToken);
      } finally {
        setIsLoading(false);
      }
    },
    [config.gubUrl, config.appId],
  );

  // Store tokens and decode user from JWT payload
  const storeTokens = useCallback((access: string, refresh: string) => {
    _accessToken = access;
    _refreshToken = refresh;
    setAccessToken(access);

    // Decode payload (JWTs are base64 — no crypto needed to read claims)
    const payload = JSON.parse(atob(access.split('.')[1])) as GUBUser & {
      exp: number;
    };
    setUser(payload);

    // Schedule silent refresh 30 seconds before expiry
    const msUntilExpiry = payload.exp * 1000 - Date.now();
    const refreshIn = Math.max(msUntilExpiry - 30_000, 0);

    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = setTimeout(silentRefresh, refreshIn);
  }, []);

  // Silent token refresh using the refresh token
  const silentRefresh = useCallback(async () => {
    if (!_refreshToken) return;
    try {
      const res = await window.fetch(`${config.gubUrl}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: _refreshToken }),
      });

      if (!res.ok) {
        // Refresh token expired or revoked — force re-login
        logout();
        return;
      }

      const data = await res.json();
      storeTokens(data.accessToken, data.refreshToken);
    } catch {
      logout();
    }
  }, [config.gubUrl, storeTokens]);

  const logout = useCallback(() => {
    _accessToken = null;
    _refreshToken = null;
    setAccessToken(null);
    setUser(null);
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
  }, []);

  // Authenticated fetch — handles 401 → refresh → retry once
  const authFetch = useCallback(
    async (input: RequestInfo, init: RequestInit = {}): Promise<Response> => {
      if (!_accessToken) throw new Error('Not authenticated');

      const doRequest = (token: string) =>
        window.fetch(input, {
          ...init,
          headers: {
            ...init.headers,
            Authorization: `Bearer ${token}`,
          },
        });

      const res = await doRequest(_accessToken);

      if (res.status === 401) {
        // Token may have just expired — try a silent refresh then retry once
        await silentRefresh();
        if (!_accessToken) throw new Error('Session expired');
        return doRequest(_accessToken);
      }

      return res;
    },
    [silentRefresh],
  );

  // Google login hook
  const googleLogin = useGoogleLogin({
    onSuccess: (response) => exchangeGoogleCredential(response.access_token),
    onError: () => setIsLoading(false),
  });

  const login = useCallback(() => {
    setIsLoading(true);
    googleLogin();
  }, [googleLogin]);

  // Clean up refresh timer on unmount
  useEffect(() => {
    return () => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    };
  }, []);

  return (
    <GUBContext.Provider
      value={{
        user,
        isLoading,
        isAuthenticated: !!user,
        login,
        logout,
        fetch: authFetch,
        accessToken,
      }}
    >
      {children}
    </GUBContext.Provider>
  );
}

// ── Public Provider ────────────────────────────────────────────────────────

export interface GUBProviderProps {
  config: GUBConfig;
  children: React.ReactNode;
}

/**
 * Wrap your app with GUBProvider at the root level.
 *
 * @example
 * <GUBProvider config={{ gubUrl: '...', googleClientId: '...', appId: '...' }}>
 *   <App />
 * </GUBProvider>
 */
export function GUBProvider({ config, children }: GUBProviderProps) {
  return (
    <GoogleOAuthProvider clientId={config.googleClientId}>
      <GUBProviderInner config={config}>{children}</GUBProviderInner>
    </GoogleOAuthProvider>
  );
}

// ── Hook ───────────────────────────────────────────────────────────────────

/**
 * Access the GUB auth context from any component inside GUBProvider.
 *
 * @example
 * function App() {
 *   const { isAuthenticated, login, logout, user, fetch } = useGUB()
 *
 *   if (!isAuthenticated) return <button onClick={login}>Sign in with Google</button>
 *
 *   return (
 *     <div>
 *       <p>Hello {user.displayName}</p>
 *       <button onClick={logout}>Sign out</button>
 *     </div>
 *   )
 * }
 */
export function useGUB(): GUBContextValue {
  const ctx = useContext(GUBContext);
  if (!ctx) throw new Error('useGUB must be used inside <GUBProvider>');
  return ctx;
}

/**
 * Pre-built sign-in button. Renders a "Sign in with Google" button
 * or a sign-out button depending on auth state.
 *
 * @example
 * <GUBLoginButton />
 */
export function GUBLoginButton({
  className,
}: {
  className?: string;
}) {
  const { isAuthenticated, isLoading, login, logout, user } = useGUB();

  if (isLoading) {
    return (
      <button disabled className={className}>
        Signing in...
      </button>
    );
  }

  if (isAuthenticated) {
    return (
      <button onClick={logout} className={className}>
        Sign out ({user?.email})
      </button>
    );
  }

  return (
    <button onClick={login} className={className}>
      Sign in with Google
    </button>
  );
}
