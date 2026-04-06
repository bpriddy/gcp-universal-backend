import { createApp } from './app';
import { config } from './config/env';
import { initializeAppDbPools, closeAllPools, prisma } from './config/database';
import { logger } from './services/logger';

async function connectWithRetry(retries = 5, delayMs = 2000): Promise<void> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await prisma.$connect();
      logger.info('Database connected');
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ attempt, retries, message }, 'Database connect failed, retrying...');
      if (attempt === retries) throw err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

async function main(): Promise<void> {
  // Connect to DB with retry (Cloud SQL socket may not be immediately available)
  await connectWithRetry();

  // Initialize application database connection pools
  initializeAppDbPools();

  const app = createApp();

  const server = app.listen(config.PORT, () => {
    logger.info(
      {
        port: config.PORT,
        env: config.NODE_ENV,
        issuer: config.JWT_ISSUER,
      },
      'gcp-universal-backend started',
    );
  });

  // ── Graceful shutdown ──────────────────────────────────────────────────────
  async function shutdown(signal: string): Promise<void> {
    logger.info({ signal }, 'Shutdown signal received, closing gracefully');

    server.close(async () => {
      try {
        await closeAllPools();
        logger.info('Shutdown complete');
        process.exit(0);
      } catch (err) {
        logger.error({ err }, 'Error during shutdown');
        process.exit(1);
      }
    });

    // Force exit after 10 seconds if graceful shutdown stalls
    setTimeout(() => {
      logger.error('Forced shutdown after timeout');
      process.exit(1);
    }, 10_000).unref();
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.error({
      reason,
      errorMessage: reason instanceof Error ? reason.message : String(reason),
      errorStack: reason instanceof Error ? reason.stack : undefined,
    }, 'Unhandled promise rejection');
    process.exit(1);
  });

  process.on('uncaughtException', (err) => {
    logger.error({ err }, 'Uncaught exception');
    process.exit(1);
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal startup error:', err);
  process.exit(1);
});
