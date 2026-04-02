import { Router } from 'express';
import { validateBody } from '../../middleware/validate';
import { authenticate, requireAdmin } from '../../middleware/authenticate';
import { GoogleLoginSchema, RefreshSchema, LogoutSchema } from './auth.schema';
import * as authController from './auth.controller';
import * as brokerController from './broker.controller';

const router = Router();

/**
 * POST /auth/google/exchange
 * Exchange a client-obtained Google ID token for a GUB access + refresh token.
 * The OAuth dance happens entirely client-side (Google Identity Services SDK);
 * GUB only validates the resulting ID token and issues its own session.
 */
router.post('/google/exchange', validateBody(GoogleLoginSchema), authController.googleLogin);

/**
 * POST /auth/refresh
 * Rotate a refresh token and issue new access + refresh tokens.
 */
router.post('/refresh', validateBody(RefreshSchema), authController.refreshTokens);

/**
 * POST /auth/logout
 * Revoke the provided refresh token (and its entire rotation family).
 */
router.post('/logout', validateBody(LogoutSchema), authController.logout);

/**
 * POST /auth/logout-all
 * Revoke all refresh tokens for the authenticated user (all devices).
 */
router.post('/logout-all', authenticate, authController.logoutAll);

/**
 * GET /auth/jwks
 * Returns the RS256 public key in JWKS format.
 * Downstream services can use this to verify access tokens independently.
 */
router.get('/jwks', authController.getJwks);

// ── OAuth Broker ────────────────────────────────────────────────────────────
// Server-side OAuth flow for headless clients (e.g. Agentspace MCP).
// These routes actually run the OAuth dance — unlike /auth/google/exchange which
// merely validates a client-obtained ID token.

/**
 * GET /auth/google/broker/authorize
 * Step 1: Client redirects the user's browser here.
 * GUB saves state and redirects to Google's OAuth consent screen.
 */
router.get('/google/broker/authorize', brokerController.authorize);

/**
 * GET /auth/google/broker/callback
 * Step 2: Google redirects here after the user approves.
 * GUB exchanges the Google code, issues its own auth code, redirects to client.
 */
router.get('/google/broker/callback', brokerController.callback);

/**
 * POST /auth/google/broker/token
 * Step 3: Client exchanges the GUB auth code for access + refresh tokens.
 * Accepts application/x-www-form-urlencoded or application/json.
 */
router.post('/google/broker/token', brokerController.token);

/**
 * GET /auth/google/broker/clients
 * POST /auth/google/broker/clients
 * DELETE /auth/google/broker/clients/:clientId
 * Admin-only: manage registered OAuth clients.
 */
router.get('/google/broker/clients', authenticate, requireAdmin, brokerController.listClients);
router.post('/google/broker/clients', authenticate, requireAdmin, brokerController.createClient);
router.delete('/google/broker/clients/:clientId', authenticate, requireAdmin, brokerController.deleteClient);

export default router;
