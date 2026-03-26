import { Router } from 'express';
import { validateBody } from '../../middleware/validate';
import { authenticate } from '../../middleware/authenticate';
import { GoogleLoginSchema, RefreshSchema, LogoutSchema } from './auth.schema';
import * as authController from './auth.controller';

const router = Router();

/**
 * POST /auth/google
 * Exchange a Google OAuth ID token for an access token + refresh token.
 */
router.post('/google', validateBody(GoogleLoginSchema), authController.googleLogin);

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

export default router;
