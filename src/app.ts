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
import orgRouter from './modules/org/org.router';
import directoryRouter from './modules/integrations/google-directory/directory.router';
import groupsRouter from './modules/integrations/google-groups/groups.router';
import workfrontRouter from './modules/integrations/workfront/workfront.router';
import driveRouter from './modules/integrations/google-drive/drive.router';
import metadataImportRouter from './modules/integrations/staff-metadata-import/metadata-import.router';
import syncRunsRouter from './modules/integrations/sync-runs.router';
import devRouter from './modules/dev/dev.router';
import mcpRouter from './modules/mcp/mcp.router';
import { attachWorkspaceToken } from './modules/workspace';
import { getJwks as getJwksHandler } from './modules/auth/auth.controller';

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
        paths: [
          'req.headers.authorization',
          'req.headers["x-workspace-token"]',
          'req.body.idToken',
          'req.body.refreshToken',
        ],
        censor: '[REDACTED]',
      },
    }),
  );

  // ── Body parsing ──────────────────────────────────────────────────────────
  app.use(express.json({ limit: '10kb' }));
  // OAuth token endpoint accepts application/x-www-form-urlencoded (RFC 6749 §4.1.3)
  app.use(express.urlencoded({ extended: false, limit: '4kb' }));

  // ── Global rate limiter ───────────────────────────────────────────────────
  app.use(generalLimiter);

  // ── Workspace pass-through token ──────────────────────────────────────────
  // Extracts `X-Workspace-Token` (a short-lived Google access token the client
  // already holds) onto req. Permissive: never 401s — routes decide whether
  // to require it via resolveWorkspaceCreds.
  app.use(attachWorkspaceToken);

  // ── Routes ────────────────────────────────────────────────────────────────
  app.use('/health', healthRouter);
  app.use('/auth', authLimiter, authRouter);
  app.use('/org', orgRouter);
  app.use('/integrations/google-directory', directoryRouter);
  app.use('/integrations/google-groups', groupsRouter);
  app.use('/integrations/workfront', workfrontRouter);
  app.use('/integrations/google-drive', driveRouter);
  app.use('/integrations/staff-metadata', metadataImportRouter);
  app.use('/integrations/sync-runs', syncRunsRouter);

  // MCP endpoint — delegated auth (Bearer token required on every request)
  app.use('/mcp', mcpRouter);

  // Dev-only routes — never available in production
  if (!config.isProduction) {
    app.use('/dev', devRouter);
    logger.info('Dev routes mounted at /dev (non-production only)');
  }

  // Standard JWKS discovery endpoint — consumed by downstream backend SDKs
  app.get('/.well-known/jwks.json', getJwksHandler);

  // OAuth 2.0 Authorization Server Metadata (RFC 8414)
  // Agentspace / OAuth clients can auto-discover endpoints from this URL.
  app.get('/.well-known/oauth-authorization-server', (_req, res) => {
    const base = config.JWT_ISSUER.replace(/\/$/, '');
    res.json({
      issuer: base,
      authorization_endpoint: `${base}/auth/google/broker/authorize`,
      token_endpoint: `${base}/auth/google/broker/token`,
      jwks_uri: `${base}/.well-known/jwks.json`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      token_endpoint_auth_methods_supported: ['client_secret_post'],
      scopes_supported: ['openid', 'email', 'profile'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
    });
  });

  // ── 404 handler ───────────────────────────────────────────────────────────
  app.use((_req, res) => {
    res.status(404).json({ code: 'NOT_FOUND', message: 'Route not found' });
  });

  // ── Centralized error handler (must be last) ──────────────────────────────
  app.use(errorHandler);

  return app;
}
