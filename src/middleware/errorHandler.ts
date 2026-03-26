import type { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { errors as JoseErrors } from 'jose';
import { GoogleAuthError } from '../services/google.service';
import { TokenReuseDetectedError, InvalidRefreshTokenError } from '../services/token.service';
import { AccountDisabledError } from '../modules/auth/auth.types';
import { logger } from '../services/logger';
import { config } from '../config/env';

interface ApiError {
  code: string;
  message: string;
  details?: unknown;
}

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof ZodError) {
    res.status(400).json({
      code: 'VALIDATION_ERROR',
      message: 'Request validation failed',
      details: err.errors.map((e) => ({ path: e.path.join('.'), message: e.message })),
    } satisfies ApiError & { details: unknown });
    return;
  }

  if (err instanceof GoogleAuthError) {
    res.status(401).json({ code: err.code, message: err.message } satisfies ApiError);
    return;
  }

  if (err instanceof TokenReuseDetectedError) {
    res.status(401).json({ code: err.code, message: err.message } satisfies ApiError);
    return;
  }

  if (err instanceof InvalidRefreshTokenError) {
    res.status(401).json({ code: err.code, message: err.message } satisfies ApiError);
    return;
  }

  if (err instanceof AccountDisabledError) {
    res.status(403).json({ code: err.code, message: err.message } satisfies ApiError);
    return;
  }

  if (err instanceof JoseErrors.JWTExpired) {
    res.status(401).json({ code: 'TOKEN_EXPIRED', message: 'Access token has expired' } satisfies ApiError);
    return;
  }

  if (
    err instanceof JoseErrors.JWTInvalid ||
    err instanceof JoseErrors.JWSInvalid ||
    err instanceof JoseErrors.JWSSignatureVerificationFailed
  ) {
    res.status(401).json({ code: 'INVALID_TOKEN', message: 'Access token is invalid' } satisfies ApiError);
    return;
  }

  // Unknown error — log full details but never expose internals to the client
  logger.error({ err, path: req.path, method: req.method }, 'Unhandled error');

  res.status(500).json({
    code: 'INTERNAL_ERROR',
    message: config.isProduction ? 'An unexpected error occurred' : String(err),
  } satisfies ApiError);
}
