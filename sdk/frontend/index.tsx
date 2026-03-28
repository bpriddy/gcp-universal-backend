/**
 * GUB Frontend SDK
 *
 * React SDK for the GCP Universal Backend.
 * Uses Google Identity Services (GIS) — no additional npm packages required.
 *
 * Install:
 *   npm install github:bpriddy/gcp-universal-backend
 *
 * Usage:
 *   import { GUBProvider, useGUB } from 'gcp-universal-backend/sdk/frontend'
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';

// ── Types ──────────────────────────────────────────────────────────────────

export interface TokenPermission {
  appId: string;
  dbIdentifier: string;
  role: string;
}

export interface GUBUser {
  /** User UUID — users.id in GUB */
  sub: string;
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
  /** Superuser flag — bypasses all access_grants checks on GUB */
  isAdmin: boolean;
  permissions: TokenPermission[];
  exp: number;
}

export interface GUBConfig {
  /** GUB backend URL — e.g. https://gub.yourdomain.com */
  gubUrl: string;
  /** Google OAuth client ID */
  googleClientId: string;
}

export interface GUBContextValue {
  /** Authenticated user, or null if not logged in */
  user: GUBUser | null;
  /** True while login / token refresh is in progress */
  isLoading: boolean;
  /** True if the user is authenticated */
  isAuthenticated: boolean;
  /** Initiate Google OAuth login flow via One Tap or popup */
  login: () => void;
  /** Clear session and revoke refresh token */
  logout: () => Promise<void>;
  /**
   * Authenticated fetch — automatically attaches the Authorization header
   * and silently refreshes the token on 401 before retrying once.
   *
   * @example
   * const { fetch: authFetch } = useGUB()
   * const data = await authFetch('https://api.yourdomain.com/endpoint').then(r => r.json())
   */
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  /**
   * Raw access token — use only if you need the JWT directly.
   * Prefer fetch() for making authenticated requests.
   */
  accessToken: string | null;
}

// ── Internal token storage ─────────────────────────────────────────────────
// Stored in module-level variables (memory only — never localStorage).
// This prevents XSS token theft. Tokens are lost on page refresh;
// the silent refresh flow re-issues them from the refresh token automatically.

let _accessToken: string | null = null;
let _refreshToken: string | null = null;

// ── Google Identity Services ───────────────────────────────────────────────
// Loaded once via script injection — no @react-oauth/google dependency.
// The GIS credential response contains an ID token (not an access token),
// which is exactly what GUB's POST /auth/google expects.

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (config: {
            client_id: string;
            callback: (response: { credential: string }) => void;
            auto_select?: boolean;
            cancel_on_tap_outside?: boolean;
          }) => void;
          prompt: (notification?: (n: { isNotDisplayed: () => boolean; isSkippedMoment: () => boolean }) => void) => void;
          renderButton: (parent: HTMLElement, options: object) => void;
          disableAutoSelect: () => void;
        };
      };
    };
  }
}

function loadGoogleScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.google?.accounts) {
      resolve();
      return;
    }
    if (document.getElementById('gub-gis-script')) {
      // Script tag exists but not yet loaded — wait for it
      document.getElementById('gub-gis-script')!.addEventListener('load', () => resolve());
      return;
    }
    const script = document.createElement('script');
    script.id = 'gub-gis-script';
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Failed to load Google Identity Services'));
    document.head.appendChild(script);
  });
}

// ── Context ────────────────────────────────────────────────────────────────

const GUBContext = createContext<GUBContextValue | null>(null);

// ── Provider ───────────────────────────────────────────────────────────────

export interface GUBProviderProps {
  config: GUBConfig;
  children: React.ReactNode;
}

/**
 * Wrap your app with GUBProvider at the root level.
 *
 * @example
 * <GUBProvider config={{ gubUrl: '...', googleClientId: '...' }}>
 *   <App />
 * </GUBProvider>
 */
export function GUBProvider({ config, children }: GUBProviderProps) {
  const [user, setUser] = useState<GUBUser | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const baseUrl = config.gubUrl.replace(/\/$/, '');

  // Decode JWT payload and store tokens in memory
  const storeTokens = useCallback((access: string, refresh: string) => {
    _accessToken = access;
    _refreshToken = refresh;
    setAccessToken(access);

    // JWT payload is base64 encoded — readable without crypto
    const payload = JSON.parse(atob(access.split('.')[1])) as GUBUser;

    // Merge avatarUrl from auth response since it may not be in JWT claims
    setUser(payload);

    // Schedule silent refresh 30s before expiry
    const msUntilExpiry = payload.exp * 1000 - Date.now();
    const refreshIn = Math.max(msUntilExpiry - 30_000, 0);
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = setTimeout(silentRefresh, refreshIn);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseUrl]);

  // Silent token refresh
  const silentRefresh = useCallback(async () => {
    if (!_refreshToken) return;
    try {
      const res = await window.fetch(`${baseUrl}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: _refreshToken }),
      });
      if (!res.ok) {
        // Refresh token expired or revoked — clear session
        _accessToken = null;
        _refreshToken = null;
        setAccessToken(null);
        setUser(null);
        return;
      }
      const data = await res.json();
      storeTokens(data.accessToken, data.refreshToken);
    } catch {
      // Network error — keep existing tokens until they expire
    }
  }, [baseUrl, storeTokens]);

  // Exchange Google ID token for a GUB JWT
  const exchangeGoogleCredential = useCallback(
    async (credential: string) => {
      setIsLoading(true);
      try {
        const res = await window.fetch(`${baseUrl}/auth/google`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // GUB expects idToken — the GIS credential IS an ID token
          body: JSON.stringify({ idToken: credential }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({})) as { message?: string };
          throw new Error(err.message ?? 'Authentication failed');
        }
        const data = await res.json();
        storeTokens(data.accessToken, data.refreshToken);
      } finally {
        setIsLoading(false);
      }
    },
    [baseUrl, storeTokens],
  );

  // Trigger Google One Tap / popup login
  const login = useCallback(async () => {
    setIsLoading(true);
    try {
      await loadGoogleScript();
      window.google!.accounts.id.initialize({
        client_id: config.googleClientId,
        callback: ({ credential }) => exchangeGoogleCredential(credential),
        auto_select: false,
        cancel_on_tap_outside: true,
      });
      window.google!.accounts.id.prompt((notification) => {
        // If One Tap is suppressed (e.g. user dismissed it), stop loading
        if (notification.isNotDisplayed() || notification.isSkippedMoment()) {
          setIsLoading(false);
        }
      });
    } catch (err) {
      setIsLoading(false);
      throw err;
    }
  }, [config.googleClientId, exchangeGoogleCredential]);

  // Logout — revoke refresh token then clear local state
  const logout = useCallback(async () => {
    if (_refreshToken) {
      try {
        await window.fetch(`${baseUrl}/auth/logout`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken: _refreshToken }),
        });
      } catch {
        // Best effort — clear local state regardless
      }
    }
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    _accessToken = null;
    _refreshToken = null;
    setAccessToken(null);
    setUser(null);
    window.google?.accounts.id.disableAutoSelect();
  }, [baseUrl]);

  // Authenticated fetch — attaches JWT, retries once after silent refresh on 401
  const authFetch = useCallback(
    async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
      if (!_accessToken) throw new Error('Not authenticated');

      const doRequest = (token: string) =>
        window.fetch(input, {
          ...init,
          headers: { ...init.headers, Authorization: `Bearer ${token}` },
        });

      const res = await doRequest(_accessToken);

      if (res.status === 401) {
        await silentRefresh();
        if (!_accessToken) throw new Error('Session expired — please sign in again');
        return doRequest(_accessToken);
      }

      return res;
    },
    [silentRefresh],
  );

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
        isAuthenticated: user !== null,
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

// ── Hook ───────────────────────────────────────────────────────────────────

/**
 * Access the GUB auth context from any component inside GUBProvider.
 *
 * @example
 * function Dashboard() {
 *   const { isAuthenticated, isLoading, login, logout, user, fetch } = useGUB()
 *
 *   if (isLoading) return <p>Loading...</p>
 *   if (!isAuthenticated) return <button onClick={login}>Sign in with Google</button>
 *
 *   return (
 *     <div>
 *       <p>Hello {user.displayName ?? user.email}</p>
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

// ── Pre-built login button ─────────────────────────────────────────────────

/**
 * Pre-built sign-in / sign-out button.
 * Shows "Sign in with Google" when logged out, "Sign out (email)" when in.
 *
 * @example
 * <GUBLoginButton className="btn btn-primary" />
 */
export function GUBLoginButton({ className }: { className?: string }) {
  const { isAuthenticated, isLoading, login, logout, user } = useGUB();

  if (isLoading) {
    return <button disabled className={className}>Signing in...</button>;
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
