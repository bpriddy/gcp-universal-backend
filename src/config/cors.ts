import type { CorsOptions } from 'cors';
import { config } from './env';
import { logger } from '../services/logger';

export const corsOptions: CorsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin (server-to-server, curl, Postman in dev)
    if (!origin) {
      return callback(null, true);
    }

    if (config.CORS_ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true);
    } else {
      logger.warn({ origin }, 'CORS rejected request from disallowed origin');
      callback(new Error(`Origin '${origin}' not permitted by CORS policy`));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Authorization', 'Content-Type', 'X-Request-ID', 'X-Workspace-Token'],
  exposedHeaders: ['X-Request-ID'],
  credentials: true,
  maxAge: 86_400, // Cache preflight response for 24 hours
};
