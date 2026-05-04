/**
 * GUB SDK — shared configuration helper.
 *
 * Implementer-facing entry point that consolidates everything an app needs
 * to talk to GUB into one declaration. The helper is the single source of
 * truth that the frontend `<GUBProvider>` and the backend `createGUBClient`
 * both consume.
 *
 *   import { defineGUBConfig } from 'gcp-universal-backend/sdk/config';
 *
 *   export const GUB = defineGUBConfig({
 *     url:            process.env.GUB_URL!,
 *     googleClientId: process.env.GOOGLE_CLIENT_ID!,
 *     appId:          'workflows-dashboard',  // identity, not config
 *   });
 *
 * What it does:
 *   - Validates the URL (https only, except loopback for dev) and the
 *     Google client_id shape ('<digits>-<random>.apps.googleusercontent.com').
 *   - Lazily fetches `${url}/.well-known/oauth-authorization-server` on
 *     first use and caches the result in memory.
 *   - Validates `discovery.issuer === url` — typo into a domain you don't
 *     control fails loudly here, not silently 30s later at JWT verification.
 *
 * What it deliberately doesn't do:
 *   - On-disk caching. Per security review, an attacker-tampered cache
 *     would become the trust anchor.
 *   - Auto-discovery from any URL other than the configured `url`. The
 *     URL IS the trust anchor; chasing redirects defeats the point.
 *   - Read env vars itself. The implementer reads env in their own
 *     framework's idiom (process.env, import.meta.env, etc.) and passes
 *     the strings here. Less magic, fewer cross-framework concerns.
 *
 * Status: implements decisions captured in
 * docs/proposals/sdk-config-simplification.md (Decisions log).
 */

// ── Types ──────────────────────────────────────────────────────────────────

/**
 * Input shape for defineGUBConfig. The implementer reads these from
 * their environment (or hardcodes them in the case of `appId`) and
 * passes them in.
 */
export interface GUBConfigInput {
  /** GUB backend URL — e.g. `https://gub.example.com`. https required except for loopback. */
  url: string;
  /** Implementer's Google OAuth 2.0 client_id (the value from Google Cloud Console). */
  googleClientId: string;
  /**
   * The implementer's stable identity within GUB. Same string in dev,
   * staging, and prod — declared once in code, not in env. The token's
   * `aud` claim will equal this value; the SDK's verifier requires
   * `aud === appId` with no override.
   */
  appId: string;
}

/**
 * Resolved GUB configuration. Both `<GUBProvider>` and `createGUBClient`
 * accept this object; either can consume the typed accessors as needed.
 */
export interface GUBConfig {
  readonly url: string;
  readonly googleClientId: string;
  readonly appId: string;
  /** Discovery endpoint URL (computed from `url`). */
  readonly discoveryUrl: string;
  /**
   * Fetches and validates the OAuth Authorization Server Metadata
   * document. Lazy + cached in memory; any failure throws and the
   * cache is reset so a retry can succeed if e.g. the network blip
   * was transient.
   */
  getDiscovery(): Promise<DiscoveryDoc>;
  /** Convenience accessor: `(await getDiscovery()).issuer`. */
  getIssuer(): Promise<string>;
  /** Convenience accessor: `(await getDiscovery()).jwks_uri`. */
  getJwksUri(): Promise<string>;
}

/**
 * Subset of OAuth 2.0 Authorization Server Metadata (RFC 8414) we
 * actually consume. GUB serves the full doc; we only require these.
 */
export interface DiscoveryDoc {
  issuer: string;
  jwks_uri: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  response_types_supported?: string[];
  id_token_signing_alg_values_supported?: string[];
  [key: string]: unknown;
}

export type GUBConfigErrorCode =
  | 'INVALID_URL'
  | 'INVALID_GOOGLE_CLIENT_ID'
  | 'INVALID_APP_ID'
  | 'DISCOVERY_FETCH_FAILED'
  | 'DISCOVERY_INVALID'
  | 'DISCOVERY_ISSUER_MISMATCH';

export class GUBConfigError extends Error {
  readonly code: GUBConfigErrorCode;
  constructor(code: GUBConfigErrorCode, message: string) {
    super(message);
    this.name = 'GUBConfigError';
    this.code = code;
  }
}

// ── Helper ─────────────────────────────────────────────────────────────────

/**
 * Validate the input synchronously, then return a config object whose
 * discovery doc gets fetched on first use.
 *
 * This function never makes a network call. Discovery is async + lazy
 * via the returned object's `getDiscovery()` accessor.
 */
export function defineGUBConfig(input: GUBConfigInput): GUBConfig {
  const url = validateUrl(input.url);
  const googleClientId = validateGoogleClientId(input.googleClientId);
  const appId = validateAppId(input.appId);
  const discoveryUrl = `${url}/.well-known/oauth-authorization-server`;

  // Lazy fetch: kicks off on first getDiscovery() call. Subsequent calls
  // await the same promise. On failure the promise is cleared so the
  // next call retries (otherwise transient errors would be sticky for
  // the lifetime of the process).
  let discoveryPromise: Promise<DiscoveryDoc> | null = null;

  function getDiscovery(): Promise<DiscoveryDoc> {
    if (!discoveryPromise) {
      discoveryPromise = fetchAndValidateDiscovery(url, discoveryUrl).catch((err: unknown) => {
        discoveryPromise = null;
        throw err;
      });
    }
    return discoveryPromise;
  }

  return {
    url,
    googleClientId,
    appId,
    discoveryUrl,
    getDiscovery,
    getIssuer: async () => (await getDiscovery()).issuer,
    getJwksUri: async () => (await getDiscovery()).jwks_uri,
  };
}

// ── Validation ─────────────────────────────────────────────────────────────

const GOOGLE_CLIENT_ID_PATTERN = /^[0-9]+-[A-Za-z0-9_]+\.apps\.googleusercontent\.com$/;
const APP_ID_MIN = 1;
const APP_ID_MAX = 64;

function validateUrl(input: string): string {
  if (typeof input !== 'string') {
    throw new GUBConfigError('INVALID_URL', 'url must be a string');
  }
  const trimmed = input.trim();
  if (!trimmed) {
    throw new GUBConfigError('INVALID_URL', 'url is required');
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new GUBConfigError('INVALID_URL', `url '${trimmed}' is not a valid URL`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new GUBConfigError(
      'INVALID_URL',
      `url must use https:// or http:// (got '${parsed.protocol}')`,
    );
  }
  if (parsed.protocol === 'http:') {
    const host = parsed.hostname;
    const isLoopback =
      host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
    if (!isLoopback) {
      throw new GUBConfigError(
        'INVALID_URL',
        `url must use https:// for non-loopback hosts (got '${host}')`,
      );
    }
  }
  // Strip trailing slash for canonical comparison vs. discovery's issuer claim.
  return trimmed.replace(/\/+$/, '');
}

function validateGoogleClientId(input: string): string {
  if (typeof input !== 'string') {
    throw new GUBConfigError('INVALID_GOOGLE_CLIENT_ID', 'googleClientId must be a string');
  }
  const trimmed = input.trim();
  if (!trimmed) {
    throw new GUBConfigError('INVALID_GOOGLE_CLIENT_ID', 'googleClientId is required');
  }
  if (!GOOGLE_CLIENT_ID_PATTERN.test(trimmed)) {
    throw new GUBConfigError(
      'INVALID_GOOGLE_CLIENT_ID',
      `'${trimmed}' isn't a valid Google OAuth client_id. ` +
        `Expected '<digits>-<random>.apps.googleusercontent.com' (the value Google issues in the OAuth client console).`,
    );
  }
  return trimmed;
}

function validateAppId(input: string): string {
  if (typeof input !== 'string') {
    throw new GUBConfigError('INVALID_APP_ID', 'appId must be a string');
  }
  const trimmed = input.trim();
  if (trimmed.length < APP_ID_MIN || trimmed.length > APP_ID_MAX) {
    throw new GUBConfigError(
      'INVALID_APP_ID',
      `appId must be ${APP_ID_MIN}-${APP_ID_MAX} characters (got ${trimmed.length})`,
    );
  }
  return trimmed;
}

// ── Discovery fetch + validation ───────────────────────────────────────────

const DISCOVERY_TIMEOUT_MS = 5_000;

async function fetchAndValidateDiscovery(
  url: string,
  discoveryUrl: string,
): Promise<DiscoveryDoc> {
  // Bounded timeout — slow GUB shouldn't hang implementer startup forever.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(discoveryUrl, {
      signal: controller.signal,
      // Don't carry implementer cookies/credentials to the discovery
      // endpoint — it's public and we want clean caching.
      credentials: 'omit',
      // Plain Accept header; discovery doc is small JSON.
      headers: { Accept: 'application/json' },
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new GUBConfigError(
      'DISCOVERY_FETCH_FAILED',
      `Could not fetch GUB discovery doc from '${discoveryUrl}': ${reason}. ` +
        `Check that GUB_URL is correct and reachable from this environment.`,
    );
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    throw new GUBConfigError(
      'DISCOVERY_FETCH_FAILED',
      `GUB discovery doc fetch returned HTTP ${response.status} from '${discoveryUrl}'.`,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new GUBConfigError(
      'DISCOVERY_INVALID',
      `GUB discovery doc at '${discoveryUrl}' returned non-JSON.`,
    );
  }

  if (typeof body !== 'object' || body === null) {
    throw new GUBConfigError(
      'DISCOVERY_INVALID',
      `GUB discovery doc at '${discoveryUrl}' is not a JSON object.`,
    );
  }

  const doc = body as Partial<DiscoveryDoc>;

  if (typeof doc.issuer !== 'string') {
    throw new GUBConfigError(
      'DISCOVERY_INVALID',
      `GUB discovery doc missing required string field 'issuer'.`,
    );
  }
  if (typeof doc.jwks_uri !== 'string') {
    throw new GUBConfigError(
      'DISCOVERY_INVALID',
      `GUB discovery doc missing required string field 'jwks_uri'.`,
    );
  }

  // The single critical anchor check. GUB_URL is the trust root; the
  // discovery doc's issuer claim must match it. If a typo'd GUB_URL
  // points at an attacker, this is where the attack fails — the
  // attacker would have to (a) match the typo'd domain AND (b) serve
  // a discovery doc whose issuer claim equals the typo'd value.
  const issuer = doc.issuer.replace(/\/+$/, '');
  if (issuer !== url) {
    throw new GUBConfigError(
      'DISCOVERY_ISSUER_MISMATCH',
      `GUB discovery doc reports issuer '${doc.issuer}' but configured url is '${url}'. ` +
        `This usually means GUB_URL is pointing at the wrong service. Refusing to trust this discovery doc.`,
    );
  }

  // Belt-and-suspenders: if GUB starts declaring algorithms it'll sign
  // with, make sure RS256 is in the list. Old discovery docs may omit
  // this field; tolerate that.
  if (
    Array.isArray(doc.id_token_signing_alg_values_supported) &&
    !doc.id_token_signing_alg_values_supported.includes('RS256')
  ) {
    throw new GUBConfigError(
      'DISCOVERY_INVALID',
      `GUB discovery doc declares signing algorithms ${JSON.stringify(
        doc.id_token_signing_alg_values_supported,
      )} but does not include 'RS256'. SDK only verifies RS256 tokens.`,
    );
  }

  return doc as DiscoveryDoc;
}
