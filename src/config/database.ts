import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { config } from './env';
import { logger } from '../services/logger';
import { getUserContext } from '../context/userContext';

// ── Auth database (Prisma + RLS) ─────────────────────────────────────────────
//
// The exported `prisma` client is extended with a query middleware that injects
// the authenticated user's ID into every database transaction via PostgreSQL's
// `set_config('app.current_user_id', ...)`. This allows RLS policies to filter
// rows by the current user without any changes to individual query call sites.
//
// How it works:
//   1. setUserContext Express middleware (org router) calls
//      userContextStorage.run({ userId }, next) after JWT verification.
//   2. The $extends query hook reads getUserContext() via AsyncLocalStorage.
//   3. If a context exists, it wraps the query in a batch transaction:
//      [set_config, actualQuery] — both share the same DB connection, so
//      `set_config(..., true)` (local to transaction) is visible to the query.
//   4. If no context (auth routes, health checks), the query runs normally.
//
// Transaction pooling compatibility:
//   PgBouncer in transaction mode holds the connection for the full duration of
//   a transaction. The batch $transaction([set_config, query]) counts as one
//   transaction, so the session variable is visible to the query. ✓
//
// Known limitation:
//   Operations inside interactive transactions (prisma.$transaction(async tx =>
//   {...})) use the `tx` client, which bypasses this $extends middleware.
//   Those paths are admin operations routed through gub-admin (BYPASSRLS).

const prismaBase = new PrismaClient({
  log: config.isProduction
    ? [{ emit: 'event', level: 'error' }]
    : [{ emit: 'event', level: 'query' }, { emit: 'event', level: 'error' }],
});

if (!config.isProduction) {
  prismaBase.$on('query' as never, (e: { query: string; duration: number }) => {
    logger.debug({ query: e.query, duration: e.duration }, 'Prisma query');
  });
}

prismaBase.$on('error' as never, (e: { message: string }) => {
  logger.error({ err: e.message }, 'Prisma error');
});

export const prisma = prismaBase.$extends({
  query: {
    $allModels: {
      async $allOperations({ args, query }) {
        const context = getUserContext();

        // No authenticated user context — run query as-is.
        // RLS policies allow this only for the gub_admin role (BYPASSRLS)
        // or when the queried table has no RLS policy enabled.
        if (!context?.userId) {
          return query(args);
        }

        // Batch transaction: set_config + query share the same connection.
        // set_config(..., true) means "local to current transaction" —
        // the setting is automatically cleared when the transaction ends.
        const [, result] = await prismaBase.$transaction([
          prismaBase.$executeRaw`SELECT set_config('app.current_user_id', ${context.userId}, true)`,
          query(args) as never,
        ]);

        return result;
      },
    },
  },
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
  await prismaBase.$disconnect();
  const closers = Array.from(appDbPools.values()).map((pool) => pool.end());
  await Promise.all(closers);
  logger.info('All database pools closed');
}
