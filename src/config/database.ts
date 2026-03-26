import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { config } from './env';
import { logger } from '../services/logger';

// ── Auth database (Prisma) ───────────────────────────────────────────────────

export const prisma = new PrismaClient({
  log: config.isProduction
    ? [{ emit: 'event', level: 'error' }]
    : [{ emit: 'event', level: 'query' }, { emit: 'event', level: 'error' }],
});

if (!config.isProduction) {
  prisma.$on('query' as never, (e: { query: string; duration: number }) => {
    logger.debug({ query: e.query, duration: e.duration }, 'Prisma query');
  });
}

prisma.$on('error' as never, (e: { message: string }) => {
  logger.error({ err: e.message }, 'Prisma error');
});

// ── Application database pool registry ──────────────────────────────────────

const appDbPools = new Map<string, Pool>();

export function initializeAppDbPools(): void {
  const connections = config.APP_DB_CONNECTIONS;

  for (const [identifier, connectionString] of Object.entries(connections)) {
    const pool = new Pool({
      connectionString,
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });

    pool.on('error', (err) => {
      logger.error({ err, identifier }, 'Unexpected error on idle app DB client');
    });

    appDbPools.set(identifier, pool);
    logger.info({ identifier }, 'App DB pool initialized');
  }
}

export function getAppDbPool(identifier: string): Pool | null {
  return appDbPools.get(identifier) ?? null;
}

export async function closeAllPools(): Promise<void> {
  await prisma.$disconnect();
  const closers = Array.from(appDbPools.values()).map((pool) => pool.end());
  await Promise.all(closers);
  logger.info('All database pools closed');
}
