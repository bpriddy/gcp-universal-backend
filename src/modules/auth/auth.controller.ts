import type { Request, Response, NextFunction } from 'express';
import type { ParamsDictionary } from 'express-serve-static-core';
import * as authService from './auth.service';
import type { GoogleLoginInput, RefreshInput, LogoutInput, AccessTokenExchangeInput } from './auth.schema';

function getClientIp(req: Request): string | undefined {
  // Express resolves req.ip from X-Forwarded-For when trust proxy is set
  return req.ip ?? undefined;
}

function getUserAgent(req: Request): string | undefined {
  const ua = req.headers['user-agent'];
  return ua ? ua.slice(0, 512) : undefined; // cap length for DB storage
}

export async function googleLogin(
  req: Request<ParamsDictionary, unknown, GoogleLoginInput>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    // The browser-set Origin header is what the strict same-row
    // pairing check binds against. For non-browser callers (curl, etc.)
    // origin will be undefined and pairing is skipped — but those
    // callers also don't go through this endpoint in the SDK flow.
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    const result = await authService.googleLogin(
      req.body.idToken,
      getClientIp(req),
      getUserAgent(req),
      req.body.appId,
      origin,
    );
    // pending_approval is a 202 — authenticated but not yet authorized for this app
    const status = 'status' in result && result.status === 'pending_approval' ? 202 : 200;
    res.status(status).json(result);
  } catch (err) {
    next(err);
  }
}

export async function refreshTokens(
  req: Request<ParamsDictionary, unknown, RefreshInput>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const result = await authService.refreshTokens(
      req.body.refreshToken,
      getClientIp(req),
      getUserAgent(req),
    );
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function logout(
  req: Request<ParamsDictionary, unknown, LogoutInput>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    await authService.logout(req.body.refreshToken);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

export async function logoutAll(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    // req.user is guaranteed by the authenticate middleware on this route
    const userId = req.user!.sub;
    await authService.logoutAll(userId);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

/**
 * POST /auth/google/access-token-exchange
 * ADK / Gemini Enterprise bridge. Accepts a Google OAuth access token
 * (injected into the agent's ToolContext by Gemini Enterprise) and returns
 * a GUB JWT so the agent can call GUB APIs on behalf of the user.
 */
export async function accessTokenExchange(
  req: Request<ParamsDictionary, unknown, AccessTokenExchangeInput>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const result = await authService.exchangeGoogleAccessToken(
      req.body.accessToken,
      getClientIp(req),
      getUserAgent(req),
      req.body.appId,
    );
    const status = 'status' in result && result.status === 'pending_approval' ? 202 : 200;
    res.status(status).json(result);
  } catch (err) {
    next(err);
  }
}

export async function getJwks(
  _req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { getJwks } = await import('../../services/jwt.service');
    const jwks = await getJwks();
    // Cache JWKS for 24h — it rarely changes and downstream services poll it
    res.set('Cache-Control', 'public, max-age=86400').json(jwks);
  } catch (err) {
    next(err);
  }
}
