import rateLimit from 'express-rate-limit';
import { config } from '../config/env';
import { logger } from '../services/logger';

/**
 * General rate limiter — applied to all routes.
 * Generous limits for normal API usage.
 */
export const generalLimiter = rateLimit({
  windowMs: config.RATE_LIMIT_WINDOW_MS,
  max: config.RATE_LIMIT_MAX,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req, res) => {
    logger.warn({ ip: req.ip, path: req.path }, 'General rate limit exceeded');
    res.status(429).json({
      code: 'RATE_LIMITED',
      message: 'Too many requests, please try again later',
    });
  },
  // Skip rate limiting in test environment
  skip: () => config.NODE_ENV === 'test',
});

/**
 * Auth-specific rate limiter — tighter limits on login/refresh endpoints
 * to slow brute-force and credential-stuffing attacks.
 */
export const authLimiter = rateLimit({
  windowMs: config.RATE_LIMIT_WINDOW_MS,
  max: config.AUTH_RATE_LIMIT_MAX,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req, res) => {
    logger.warn({ ip: req.ip, path: req.path }, 'Auth rate limit exceeded');
    res.status(429).json({
      code: 'AUTH_RATE_LIMITED',
      message: 'Too many authentication attempts, please try again later',
    });
  },
  skip: () => config.NODE_ENV === 'test',
});
