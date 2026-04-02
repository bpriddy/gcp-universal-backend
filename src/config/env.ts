import fs from 'fs';
import { z } from 'zod';

const AppDbConnectionsSchema = z
  .string()
  .transform((val, ctx) => {
    try {
      const parsed = JSON.parse(val) as unknown;
      return z.record(z.string()).parse(parsed);
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'APP_DB_CONNECTIONS must be valid JSON object of {identifier: connectionString}' });
      return z.NEVER;
    }
  });

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().default('3000').transform(Number),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  APP_DB_CONNECTIONS: AppDbConnectionsSchema,

  GOOGLE_CLIENT_ID: z.string().min(1, 'GOOGLE_CLIENT_ID is required'),
  GOOGLE_ALLOWED_AUDIENCES: z
    .string()
    .default('')
    .transform((val) => val.split(',').map((s) => s.trim()).filter(Boolean)),

  // Key material — one of path-based or base64-based must be set
  JWT_PRIVATE_KEY_PATH: z.string().optional(),
  JWT_PUBLIC_KEY_PATH: z.string().optional(),
  JWT_PRIVATE_KEY_B64: z.string().optional(),
  JWT_PUBLIC_KEY_B64: z.string().optional(),

  JWT_KEY_ID: z.string().default('key-v1'),
  JWT_ACCESS_TOKEN_TTL: z.string().default('900').transform(Number),
  JWT_REFRESH_TOKEN_TTL: z.string().default('2592000').transform(Number),
  JWT_ISSUER: z.string().default('https://auth.example.com'),
  JWT_AUDIENCE: z.string().default('https://api.example.com'),

  CORS_ALLOWED_ORIGINS: z
    .string()
    .default('http://localhost:5173')
    .transform((val) => val.split(',').map((s) => s.trim()).filter(Boolean)),

  RATE_LIMIT_WINDOW_MS: z.string().default('900000').transform(Number),
  RATE_LIMIT_MAX: z.string().default('100').transform(Number),
  AUTH_RATE_LIMIT_MAX: z.string().default('10').transform(Number),

  GCP_PROJECT_ID: z.string().optional(),

  // ── Okta integration ───────────────────────────────────────────────────────
  // OKTA_ORG_URL: full Okta org base URL, e.g. https://yourorg.okta.com
  // OKTA_API_TOKEN: a service account API token (read-only scopes sufficient)
  OKTA_ORG_URL: z.string().url().optional(),
  OKTA_API_TOKEN: z.string().optional(),

  // ── OAuth Broker ───────────────────────────────────────────────────────────
  // Used only by the headless server-side OAuth flow (e.g. Agentspace MCP).
  // GOOGLE_CLIENT_SECRET: the OAuth 2.0 client secret paired with GOOGLE_CLIENT_ID
  // GOOGLE_BROKER_REDIRECT_URI: the /auth/google/broker/callback URL GUB is registered as
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_BROKER_REDIRECT_URI: z.string().url().optional(),

  // ── Broker dev test ────────────────────────────────────────────────────────
  // Used only by POST /dev/broker-test/exchange (never mounted in production).
  // Set to the client_id + secret of a registered OAuth client for the test UI.
  BROKER_TEST_CLIENT_ID: z.string().optional(),
  BROKER_TEST_CLIENT_SECRET: z.string().optional(),
  BROKER_TEST_REDIRECT_URI: z.string().url().optional(),
});

function loadKeyMaterial(
  pathEnv: string | undefined,
  b64Env: string | undefined,
  label: string,
): string {
  if (b64Env) {
    return Buffer.from(b64Env, 'base64').toString('utf-8');
  }
  if (pathEnv) {
    if (!fs.existsSync(pathEnv)) {
      throw new Error(
        `${label} key file not found at path: ${pathEnv}. Run 'npm run keys:generate' to create keys.`,
      );
    }
    return fs.readFileSync(pathEnv, 'utf-8');
  }
  throw new Error(
    `${label} key not configured. Set ${label.toUpperCase().replace(' ', '_')}_KEY_PATH or ${label.toUpperCase().replace(' ', '_')}_KEY_B64 in your .env`,
  );
}

function buildConfig() {
  const parsed = EnvSchema.safeParse(process.env);

  if (!parsed.success) {
    const errors = parsed.error.errors
      .map((e) => `  ${e.path.join('.')}: ${e.message}`)
      .join('\n');
    throw new Error(`Environment configuration invalid:\n${errors}`);
  }

  const env = parsed.data;

  const privateKeyPem = loadKeyMaterial(
    env.JWT_PRIVATE_KEY_PATH,
    env.JWT_PRIVATE_KEY_B64,
    'JWT private',
  );
  const publicKeyPem = loadKeyMaterial(
    env.JWT_PUBLIC_KEY_PATH,
    env.JWT_PUBLIC_KEY_B64,
    'JWT public',
  );

  // Ensure the client ID is always in the allowed audiences list
  const allowedAudiences = Array.from(
    new Set([env.GOOGLE_CLIENT_ID, ...env.GOOGLE_ALLOWED_AUDIENCES]),
  );

  return {
    ...env,
    privateKeyPem,
    publicKeyPem,
    GOOGLE_ALLOWED_AUDIENCES: allowedAudiences,
    isProduction: env.NODE_ENV === 'production',
  } as const;
}

export const config = buildConfig();
export type Config = typeof config;
