import type { CorsOptions } from 'cors';

/**
 * CORS layer — always reflects the request origin.
 *
 * Origin enforcement is intentionally NOT done here. The cors lib's
 * built-in rejection (callback returning an Error) makes the browser
 * see only an opaque "blocked by CORS policy" message in the console;
 * the dev never sees the helpful guidance the server has to offer.
 *
 * Instead, we let CORS pass everything through, and the
 * `originAllowList` middleware (mounted right after this) returns a
 * structured 403 with a readable message when an origin isn't
 * allow-listed. The dev sees:
 *
 *   {
 *     error: "ORIGIN_NOT_ALLOWED",
 *     origin: "https://abc-123.replit.dev",
 *     message: "...add your origin to cloudbuild/<env>.yaml..."
 *   }
 *
 * ── Why this isn't a security regression ─────────────────────────────────
 * CORS is browser hygiene, not a server-side trust check. Auth-protected
 * endpoints (`/auth/*` for the OAuth flow, `/org/*` for JWT-gated org
 * data, `/mcp` for Bearer-authenticated MCP) gate access via auth
 * middleware. CORS rejection at the preflight layer never blocked a
 * malicious caller — it only blocked browser-based readers from
 * cross-origin reads, which is a concern for response-body confidentiality
 * but irrelevant for endpoints whose responses are gated by auth tokens
 * the caller wouldn't possess.
 *
 * The allow-list is preserved as an operational hygiene check (which
 * origins are registered consumers of this GUB instance) — see the
 * originAllowList middleware. It just stops being a silent failure.
 */
export const corsOptions: CorsOptions = {
  // Reflect the request origin. With credentials: true, the cors lib
  // returns Access-Control-Allow-Origin: <origin> + Allow-Credentials: true.
  origin: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Authorization', 'Content-Type', 'X-Request-ID', 'X-Workspace-Token'],
  exposedHeaders: ['X-Request-ID'],
  credentials: true,
  maxAge: 86_400, // Cache preflight response for 24 hours
};
