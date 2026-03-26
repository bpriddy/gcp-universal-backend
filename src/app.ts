import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { pinoHttp } from 'pino-http';
import { corsOptions } from './config/cors';
import { config } from './config/env';
import { generalLimiter } from './middleware/rateLimiter';
import { errorHandler } from './middleware/errorHandler';
import { authLimiter } from './middleware/rateLimiter';
import { logger } from './services/logger';
import authRouter from './modules/auth/auth.router';
import healthRouter from './modules/health/health.router';

export function createApp(): express.Application {
  const app = express();

  // Trust the GCP load balancer / Cloud Run proxy for correct req.ip resolution
  app.set('trust proxy', 1);

  // ── Security headers ──────────────────────────────────────────────────────
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'none'"],
          frameAncestors: ["'none'"],
        },
      },
      hsts: { maxAge: 31_536_000, includeSubDomains: true, preload: true },
      referrerPolicy: { policy: 'no-referrer' },
    }),
  );

  // ── CORS ──────────────────────────────────────────────────────────────────
  app.use(cors(corsOptions));

  // ── Structured request logging ────────────────────────────────────────────
  app.use(
    pinoHttp({
      logger,
      // Do not log health check noise
      autoLogging: {
        ignore: (req) => req.url === '/health/live',
      },
      // Redact sensitive fields from request logs
      redact: {
        paths: ['req.headers.authorization', 'req.body.idToken', 'req.body.refreshToken'],
        censor: '[REDACTED]',
      },
    }),
  );

  // ── Body parsing ──────────────────────────────────────────────────────────
  app.use(express.json({ limit: '10kb' }));

  // ── Global rate limiter ───────────────────────────────────────────────────
  app.use(generalLimiter);

  // ── Routes ────────────────────────────────────────────────────────────────
  app.use('/health', healthRouter);
  app.use('/auth', authLimiter, authRouter);

  // ── 404 handler ───────────────────────────────────────────────────────────
  app.use((_req, res) => {
    res.status(404).json({ code: 'NOT_FOUND', message: 'Route not found' });
  });

  // ── Centralized error handler (must be last) ──────────────────────────────
  app.use(errorHandler);

  return app;
}
