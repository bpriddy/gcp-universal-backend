/**
 * GUB Frontend SDK
 *
 * React SDK for the GCP Universal Backend.
 * Uses Google Identity Services (GIS) — no additional npm packages required.
 *
 * Install:
 *   npm install github:bpriddy/gcp-universal-backend
 *
 * Usage (new shape — recommended):
 *   import { defineGUBConfig } from 'gcp-universal-backend/sdk/config'
 *   import { GUBProvider, useGUB } from 'gcp-universal-backend/sdk/frontend'
 *
 *   const GUB = defineGUBConfig({
 *     url:            import.meta.env.VITE_GUB_URL,
 *     googleClientId: import.meta.env.VITE_GOOGLE_CLIENT_ID,
 *     appId:          'workflows-dashboard',
 *   });
 *
 *   <GUBProvider config={GUB}>{children}</GUBProvider>
 *
 * Legacy shape still accepted (deprecation warning logged):
 *   <GUBProvider config={{ gubUrl, googleClientId }}>
 *
 * Migration: see sdk/USAGE.md "Migrating from <0.x>".
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { defineGUBConfig, type GUBConfig, type GUBConfigInput } from '../config';

// Re-export so `<GUBProvider>` callers can `import { defineGUBConfig }`
// from the same path they import the provider from.
export { defineGUBConfig };
export type { GUBConfig, GUBConfigInput };

// ── Types ──────────────────────────────────────────────────────────────────

/**
 * Authenticated GUB user — identity claims from the JWT.
 *
 * Note (2026-05-04): the `permissions` field was removed. App-level "can
 * this user use this app?" decisions belong to each consuming app, not
 * GUB. Implementers needing role/permission gating should source those
 * from their own backend on top of the JWT identity claims. See
 * docs/proposals/remove-app-access-gating.md.
 */
export interface GUBUser {
  /** User UUID — users.id in GUB */
  sub: string;
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
  /** Superuser flag — bypasses all access_grants checks on GUB's own org-data API */
  isAdmin: boolean;
  exp: number;
}

/**
 * @deprecated Use `defineGUBConfig({ url, googleClientId, appId })` and
 * pass the result to `<GUBProvider>` instead. This shape will be removed
 * in a future major version. See sdk/USAGE.md.
 */
export interface LegacyGUBConfig {
  /** GUB backend URL — e.g. https://gub.yourdomain.com */
  gubUrl: string;
  /** Google OAuth client ID */
  googleClientId: string;
}

interface TokenBody {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  tokenType: string;
  user: { id: string; email: string; displayName: string | null; avatarUrl: string | null };
}

export interface GUBContextValue {
  /** Authenticated user, or null if not logged in */
  user: GUBUser | null;
  /**
   * True while any auth operation is in progress — covers initial session
   * restoration (when `initialRefreshToken` was provided), interactive login,
   * and logout.
   *
   * NOTE: `isLoading` is initialized to `true` on the very first render if
   * an `initialRefreshToken` was passed. This is intentional: without it,
   * consumers that do `if (!isLoading && !isAuthenticated) redirectToLogin()`
   * would kick the user to login for one frame on every page reload, before
   * the restore effect has a chance to run.
   */
  isLoading: boolean;
  /**
   * True only while the initial-mount session restoration is in flight
   * (i.e. exchanging `initialRefreshToken` for fresh tokens). Becomes
   * false after the restore attempt settles, success or failure, and does
   * NOT flip true again during subsequent silent refreshes or interactive
   * logins. Use this when you need to distinguish "first-load session
   * check" from "user clicked Sign In".
   */
  isRestoring: boolean;
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
// which is exactly what GUB's POST /auth/google/exchange expects.

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
  /**
   * Three input shapes are accepted:
   *
   *   1. A {@link GUBConfig} from `defineGUBConfig({ url, googleClientId, appId })`.
   *      Recommended.
   *   2. The raw {@link GUBConfigInput} — the same `{ url, googleClientId, appId }`
   *      shape `defineGUBConfig` takes. Convenience.
   *   3. The legacy `{ gubUrl, googleClientId }` shape, accepted with a
   *      deprecation warning. Will be removed in a future major version.
   */
  config: GUBConfig | GUBConfigInput | LegacyGUBConfig;
  children: React.ReactNode;
  /**
   * If provided, restore a previous session on mount instead of requiring a
   * fresh Google sign-in. Pass the refresh token from your server-side session
   * store — GUBProvider will exchange it for fresh access + refresh tokens
   * via the GUB /auth/refresh endpoint.
   */
  initialRefreshToken?: string | null;
  /**
   * Called whenever tokens change:
   *   - after interactive login:          ({ accessToken, refreshToken })
   *   - after silent refresh:             ({ accessToken, refreshToken })
   *   - after logout:                     (null)
   *   - after server rejects `initialRefreshToken` during restoration:  (null)
   *
   * Use this to persist tokens to a server-side session store so they
   * survive page reloads. The `null` callback on restoration failure is
   * your cue to clear the stale cookie so the next reload doesn't loop.
   * Transient network failures during restoration do NOT trigger the
   * null callback — the token may still be valid.
   */
  onTokensChange?: (tokens: { accessToken: string; refreshToken: string } | null) => void;
}

/**
 * Wrap your app with GUBProvider at the root level.
 *
 * @example
 *   const GUB = defineGUBConfig({
 *     url:            import.meta.env.VITE_GUB_URL,
 *     googleClientId: import.meta.env.VITE_GOOGLE_CLIENT_ID,
 *     appId:          'workflows-dashboard',
 *   });
 *
 *   <GUBProvider config={GUB}>
 *     <App />
 *   </GUBProvider>
 */
export function GUBProvider({ config, children, initialRefreshToken, onTokensChange }: GUBProviderProps) {
  // Normalize once per mount: legacy + raw-input shapes get folded into a
  // GUBConfig so the rest of the component reads from a single canonical
  // source. The dependency-array shape stays stable across renders.
  const gub = useNormalizedConfig(config);

  const [user, setUser] = useState<GUBUser | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  // Initialize to `true` when an initial refresh token is present. The restore
  // effect runs after first render; without this, consumers doing
  //   if (!isLoading && !isAuthenticated) redirectToLogin()
  // would redirect on the very first frame of every reload even when a
  // valid saved session is about to be restored.
  const [isLoading, setIsLoading] = useState<boolean>(() => Boolean(initialRefreshToken));
  const [isRestoring, setIsRestoring] = useState<boolean>(() => Boolean(initialRefreshToken));
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const baseUrl = gub.url;

  // Stable ref for onTokensChange so it doesn't re-trigger memoized callbacks
  const onTokensChangeRef = useRef(onTokensChange);
  onTokensChangeRef.current = onTokensChange;

  // Decode JWT payload and store tokens in memory
  const storeTokens = useCallback((access: string, refresh: string) => {
    _accessToken = access;
    _refreshToken = refresh;
    setAccessToken(access);

    // JWT payload is base64 encoded — readable without crypto
    const payload = JSON.parse(atob(access.split('.')[1])) as GUBUser;

    // Merge avatarUrl from auth response since it may not be in JWT claims
    setUser(payload);

    // Notify consumer (e.g. session persistence layer)
    onTokensChangeRef.current?.({ accessToken: access, refreshToken: refresh });

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
        const res = await window.fetch(`${baseUrl}/auth/google/exchange`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // GUB expects idToken — the GIS credential IS an ID token.
          // appId is forwarded so GUB can bind the issued JWT's `aud`
          // claim to this app's identifier. GUB no longer gates per-app
          // access; the appId is purely an audience binding so each
          // consumer's verifier can confirm tokens were issued for
          // them specifically.
          body: JSON.stringify({ idToken: credential, appId: gub.appId }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({})) as { message?: string };
          throw new Error(err.message ?? 'Authentication failed');
        }
        const data = await res.json() as TokenBody;
        storeTokens(data.accessToken, data.refreshToken);
      } finally {
        setIsLoading(false);
      }
    },
    [baseUrl, storeTokens, gub.appId],
  );

  // Trigger Google One Tap / popup login
  const login = useCallback(async () => {
    setIsLoading(true);
    try {
      await loadGoogleScript();
      window.google!.accounts.id.initialize({
        client_id: gub.googleClientId,
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
  }, [gub.googleClientId, exchangeGoogleCredential]);

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
    onTokensChangeRef.current?.(null);
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

  // Restore session from an initial refresh token (e.g. from a server-side
  // session store). Runs once on mount — if the token is valid, exchanges it
  // for fresh access + refresh tokens via the GUB /auth/refresh endpoint.
  //
  // If the server returns a non-OK response (revoked/expired/reused token),
  // we fire `onTokensChange(null)` so the consumer can clear its server-side
  // cookie store — otherwise the next page reload would try the same bad
  // token again. We deliberately do NOT clear on a `catch` (transient
  // network failure): better to try again next reload than to force a
  // re-login because the network blipped.
  const hasRestoredRef = useRef(false);
  useEffect(() => {
    if (hasRestoredRef.current || !initialRefreshToken) return;
    hasRestoredRef.current = true;
    // isLoading + isRestoring were already initialized to true in useState
    // when initialRefreshToken was present; no need to set them here.
    (async () => {
      try {
        const res = await window.fetch(`${baseUrl}/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken: initialRefreshToken }),
        });
        if (res.ok) {
          const data = await res.json();
          storeTokens(data.accessToken, data.refreshToken);
        } else {
          // Server rejected the refresh token. Signal the consumer to clear
          // its stale cookie so subsequent reloads don't loop on a bad token.
          onTokensChangeRef.current?.(null);
        }
      } catch {
        // Network failure — don't clear the cookie; next reload can retry.
      } finally {
        setIsLoading(false);
        setIsRestoring(false);
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
        isRestoring,
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

// ── Internal: config normalization ─────────────────────────────────────────

/**
 * Accept any of the three input shapes and return a stable {@link GUBConfig}
 * for the rest of the component to consume. The legacy `{ gubUrl,
 * googleClientId }` shape gets a one-time `console.warn`.
 *
 * Memoized on the structural identity of the input — same identity
 * across renders means same returned config (lazy discovery cache stays
 * intact). When the implementer's config object IS already a GUBConfig,
 * we just return it; defineGUBConfig is only invoked for the raw-input
 * and legacy shapes.
 */
function useNormalizedConfig(
  input: GUBConfig | GUBConfigInput | LegacyGUBConfig,
): GUBConfig {
  // Stable instance via useRef — recompute only if the input identity
  // changes (which an implementer would do deliberately).
  const cacheRef = useRef<{ source: unknown; resolved: GUBConfig } | null>(null);
  if (cacheRef.current && cacheRef.current.source === input) {
    return cacheRef.current.resolved;
  }

  const resolved = normalizeConfig(input);
  cacheRef.current = { source: input, resolved };
  return resolved;
}

function normalizeConfig(
  input: GUBConfig | GUBConfigInput | LegacyGUBConfig,
): GUBConfig {
  // Already a full GUBConfig (from defineGUBConfig) — use as-is. The
  // presence of the `getDiscovery` method is a reliable distinguisher.
  if (typeof (input as GUBConfig).getDiscovery === 'function') {
    return input as GUBConfig;
  }

  // Legacy shape: { gubUrl, googleClientId }. We've kept supporting it
  // for one release so existing implementers don't break on upgrade,
  // but it's deprecated and will be removed in a future major version.
  if ('gubUrl' in input && !('url' in input)) {
    const legacy = input as LegacyGUBConfig;
    // eslint-disable-next-line no-console
    console.warn(
      '[gub-sdk] <GUBProvider config={{ gubUrl, googleClientId }}> is deprecated. ' +
        'Use defineGUBConfig({ url, googleClientId, appId }) and pass the result. ' +
        'See sdk/USAGE.md "Migrating from <0.x>".',
    );
    // Legacy provider didn't carry an appId — synthesize one from the
    // hostname so the token-exchange request still has a stable value.
    // Implementers who relied on the legacy shape were already routing
    // through the audience claim implicitly; this preserves that behavior.
    let synthesizedAppId = 'gub-frontend-legacy';
    try {
      synthesizedAppId = `legacy-${new URL(legacy.gubUrl).hostname}`;
    } catch {
      // fall through to the generic placeholder
    }
    return defineGUBConfig({
      url: legacy.gubUrl,
      googleClientId: legacy.googleClientId,
      appId: synthesizedAppId,
    });
  }

  // Raw input shape: { url, googleClientId, appId }. Wrap it.
  return defineGUBConfig(input as GUBConfigInput);
}
