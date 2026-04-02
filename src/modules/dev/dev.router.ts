/**
 * dev.router.ts
 * Development-only routes — never mounted in production (NODE_ENV check in app.ts).
 *
 * POST /dev/broker-test/exchange
 *   Accepts an auth code from the frontend test page and exchanges it for GUB
 *   tokens using BROKER_TEST_CLIENT_ID + BROKER_TEST_CLIENT_SECRET from env.
 *   This keeps the client_secret out of the browser entirely.
 */

import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { config } from '../../config/env';
import { buildGoogleAuthorizeUrl, exchangeAuthCode, BrokerError } from '../auth/broker.service';

const router = Router();

const DEFAULT_TEST_REDIRECT_URI = 'http://localhost:5173/broker-test';

/**
 * GET /dev/broker-test/start
 * Builds the GUB authorize URL using BROKER_TEST_CLIENT_ID from env and
 * redirects the browser there. The client_id never needs to be known by the
 * frontend page — it stays in GUB's environment.
 */
router.get('/broker-test/start', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!config.BROKER_TEST_CLIENT_ID || !config.BROKER_TEST_CLIENT_SECRET) {
      res.status(503).json({
        error: 'NOT_CONFIGURED',
        error_description:
          'Set BROKER_TEST_CLIENT_ID and BROKER_TEST_CLIENT_SECRET in .env to enable the test UI.',
      });
      return;
    }

    const redirectUri = config.BROKER_TEST_REDIRECT_URI ?? DEFAULT_TEST_REDIRECT_URI;
    const { state } = req.query as { state?: string };

    const googleUrl = await buildGoogleAuthorizeUrl({
      clientId:     config.BROKER_TEST_CLIENT_ID,
      redirectUri,
      responseType: 'code',
      ...(state ? { state } : {}),
    });

    res.redirect(302, googleUrl);
  } catch (err) {
    if (err instanceof BrokerError) {
      res.status(err.status).json({ error: err.code, error_description: err.message });
      return;
    }
    next(err);
  }
});

/**
 * POST /dev/broker-test/exchange
 */
router.post('/broker-test/exchange', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!config.BROKER_TEST_CLIENT_ID || !config.BROKER_TEST_CLIENT_SECRET) {
      res.status(503).json({
        error: 'NOT_CONFIGURED',
        error_description:
          'Set BROKER_TEST_CLIENT_ID and BROKER_TEST_CLIENT_SECRET in .env to enable the test UI.',
      });
      return;
    }

    const { code } = req.body as { code?: string };
    if (!code) {
      res.status(400).json({ error: 'invalid_request', error_description: 'code is required' });
      return;
    }

    const redirectUri =
      config.BROKER_TEST_REDIRECT_URI ?? DEFAULT_TEST_REDIRECT_URI;

    const ip = req.ip;
    const ua = req.headers['user-agent']?.slice(0, 512);
    const result = await exchangeAuthCode({
      grantType:    'authorization_code',
      code,
      redirectUri,
      clientId:     config.BROKER_TEST_CLIENT_ID,
      clientSecret: config.BROKER_TEST_CLIENT_SECRET,
      ...(ip ? { ipAddress: ip } : {}),
      ...(ua ? { userAgent: ua } : {}),
    });

    res.set('Cache-Control', 'no-store').json(result);
  } catch (err) {
    if (err instanceof BrokerError) {
      res.status(err.status).json({ error: err.code, error_description: err.message });
      return;
    }
    next(err);
  }
});

export default router;
