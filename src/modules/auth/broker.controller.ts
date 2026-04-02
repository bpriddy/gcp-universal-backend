/**
 * broker.controller.ts
 * HTTP handlers for the GUB OAuth 2.0 broker endpoints.
 *
 * Routes (mounted under /auth):
 *   GET  /google/broker/authorize  → redirect browser to Google
 *   GET  /google/broker/callback   → handle Google redirect, issue GUB auth code
 *   POST /google/broker/token      → exchange GUB auth code for access + refresh tokens
 *
 * Admin routes (mounted under /auth/google/broker):
 *   GET  /clients                  → list registered OAuth clients
 *   POST /clients                  → register a new OAuth client
 *   DELETE /clients/:clientId      → deactivate a client
 */

import type { Request, Response, NextFunction } from 'express';
import * as brokerService from './broker.service';
import { BrokerError } from './broker.service';
import { logger } from '../../services/logger';

function getClientIp(req: Request): string | undefined {
  return req.ip ?? undefined;
}

function getUserAgent(req: Request): string | undefined {
  const ua = req.headers['user-agent'];
  return ua ? ua.slice(0, 512) : undefined;
}

// ── Step 1: /authorize ────────────────────────────────────────────────────

/**
 * GET /auth/google/broker/authorize
 *
 * Expected query params:
 *   client_id      required
 *   redirect_uri   required
 *   response_type  required (must be "code")
 *   state          optional — echoed back to the client in the final redirect
 */
export async function authorize(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { client_id, redirect_uri, response_type, state } = req.query as Record<string, string>;

    if (!client_id || !redirect_uri || !response_type) {
      res.status(400).json({
        error: 'invalid_request',
        error_description: 'client_id, redirect_uri, and response_type are required',
      });
      return;
    }

    const googleUrl = await brokerService.buildGoogleAuthorizeUrl({
      clientId: client_id,
      redirectUri: redirect_uri,
      responseType: response_type,
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
}

// ── Step 2: /callback ─────────────────────────────────────────────────────

/**
 * GET /auth/google/broker/callback
 *
 * Google redirects here with `code` + `state`.
 * GUB exchanges the code, issues its own auth code, and redirects to the client.
 *
 * On error: redirects back to the registered redirect_uri with `error` params
 * (RFC 6749 §4.1.2.1) — unless the state is invalid, in which case a plain
 * 400 is returned since we cannot safely redirect.
 */
export async function callback(req: Request, res: Response, next: NextFunction): Promise<void> {
  const { code, state, error: googleError, error_description } = req.query as Record<string, string>;

  // Google sent an error (e.g. user denied)
  if (googleError) {
    logger.warn({ googleError, error_description }, 'Google returned error in broker callback');

    // Try to find the pending auth to get the redirect_uri for a proper RFC redirect
    if (state) {
      const { prisma } = await import('../../config/database');
      const pending = await prisma.oAuthPendingAuth.findUnique({ where: { id: state } });
      if (pending) {
        const params = new URLSearchParams({
          error: googleError,
          ...(error_description ? { error_description } : {}),
          ...(pending.clientState ? { state: pending.clientState } : {}),
        });
        res.redirect(302, `${pending.redirectUri}?${params.toString()}`);
        return;
      }
    }

    res.status(400).json({ error: googleError, error_description });
    return;
  }

  if (!code || !state) {
    res.status(400).json({
      error: 'invalid_request',
      error_description: 'code and state are required',
    });
    return;
  }

  try {
    const ip = getClientIp(req);
    const ua = getUserAgent(req);
    const result = await brokerService.handleGoogleCallback({
      code,
      state,
      ...(ip ? { ipAddress: ip } : {}),
      ...(ua ? { userAgent: ua } : {}),
    });

    const params = new URLSearchParams({ code: result.code });
    if (result.state) params.set('state', result.state);

    res.redirect(302, `${result.redirectUri}?${params.toString()}`);
  } catch (err) {
    if (err instanceof BrokerError) {
      res.status(err.status).json({ error: err.code, error_description: err.message });
      return;
    }
    next(err);
  }
}

// ── Step 3: /token ────────────────────────────────────────────────────────

/**
 * POST /auth/google/broker/token
 *
 * Standard OAuth2 token endpoint — application/x-www-form-urlencoded or JSON.
 * Expected body:
 *   grant_type     required — "authorization_code"
 *   code           required
 *   redirect_uri   required
 *   client_id      required
 *   client_secret  required
 */
export async function token(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const body = req.body as Record<string, string>;
    const { grant_type, code, redirect_uri, client_id, client_secret } = body;

    if (!grant_type || !code || !redirect_uri || !client_id || !client_secret) {
      res.status(400).json({
        error: 'invalid_request',
        error_description: 'grant_type, code, redirect_uri, client_id, and client_secret are required',
      });
      return;
    }

    const ip = getClientIp(req);
    const ua = getUserAgent(req);
    const result = await brokerService.exchangeAuthCode({
      grantType: grant_type,
      code,
      redirectUri: redirect_uri,
      clientId: client_id,
      clientSecret: client_secret,
      ...(ip ? { ipAddress: ip } : {}),
      ...(ua ? { userAgent: ua } : {}),
    });

    // Cache-Control: no-store is required by RFC 6749 §5.1
    res.set('Cache-Control', 'no-store').json(result);
  } catch (err) {
    if (err instanceof BrokerError) {
      // OAuth token errors use 400/401 with JSON `error` field (RFC 6749 §5.2)
      res.status(err.status).json({ error: err.code, error_description: err.message });
      return;
    }
    next(err);
  }
}

// ── Admin: client registry ────────────────────────────────────────────────

/** GET /auth/google/broker/clients — list registered OAuth clients (admin only) */
export async function listClients(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const clients = await brokerService.listClients();
    res.json(clients);
  } catch (err) {
    next(err);
  }
}

/** POST /auth/google/broker/clients — register a new OAuth client (admin only) */
export async function createClient(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { name, redirectUris } = req.body as { name: string; redirectUris: string[] };

    if (!name || !Array.isArray(redirectUris) || redirectUris.length === 0) {
      res.status(400).json({ error: 'invalid_request', error_description: 'name and redirectUris (array) are required' });
      return;
    }

    const result = await brokerService.registerClient({ name, redirectUris });
    // 201 — include plaintext secret in body (only time it's visible)
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
}

/** DELETE /auth/google/broker/clients/:clientId — deactivate a client (admin only) */
export async function deleteClient(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { clientId } = req.params as { clientId: string };
    await brokerService.deactivateClient(clientId);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}
