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

  // ── Google Directory sync ───────────────────────────────────────────────────
  // Service account with domain-wide delegation for reading contacts.google.com/directory.
  // One of key path or base64 is required to enable the sync.
  GOOGLE_DIRECTORY_SA_KEY_PATH: z.string().optional(),
  GOOGLE_DIRECTORY_SA_KEY_B64: z.string().optional(),
  // Email of a domain user to impersonate (any user — directory is visible to all members).
  GOOGLE_DIRECTORY_IMPERSONATE_EMAIL: z.string().email().optional(),

  // ── Workfront integration ───────────────────────────────────────────────────
  // Workfront proxies Maconomy for accounts and campaigns.
  WORKFRONT_BASE_URL: z.string().url().optional(),
  WORKFRONT_API_TOKEN: z.string().optional(),

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

  // ── Google Drive sync ──────────────────────────────────────────────────────
  // Service account shared into each account/campaign's Drive folder.
  // One of path or base64 is required to enable the sync.
  // Falls back to GOOGLE_DIRECTORY_SA_* if drive-specific keys aren't set,
  // so you can reuse a single SA in dev.
  GOOGLE_DRIVE_SA_KEY_PATH: z.string().optional(),
  GOOGLE_DRIVE_SA_KEY_B64: z.string().optional(),
  // Optional impersonation. When unset, operates as the SA directly — fine
  // when folders are shared with the SA's email. Set to a domain user if you
  // need domain-wide delegation to see files the SA isn't explicitly shared on.
  GOOGLE_DRIVE_IMPERSONATE_EMAIL: z.string().email().optional(),

  // Root folder of the shared Drive that houses all account folders.
  // Top-level children that don't map to an existing account's
  // drive_folder_id become "new account" proposals. Required for discovery;
  // per-entity scans (scanEntity) work without it.
  DRIVE_ROOT_FOLDER_ID: z.string().optional(),

  // Pacing knobs (Phase 5 will consume these). Declared now so scripts can read.
  DRIVE_DELAY_BETWEEN_ACCOUNTS_MS: z.string().default('5000').transform(Number),
  DRIVE_DELAY_BETWEEN_CAMPAIGNS_MS: z.string().default('2000').transform(Number),
  DRIVE_DELAY_BETWEEN_FILES_MS: z.string().default('500').transform(Number),
  // Skip files larger than this at extraction time (bytes). Default 25 MB.
  DRIVE_MAX_FILE_SIZE_BYTES: z.string().default('26214400').transform(Number),

  // ── AI / Gemini ────────────────────────────────────────────────────────────
  // When unset, LLM callers fall back to a mock driver that returns empty
  // observations — pipelines still run end-to-end in dev.
  GEMINI_API_KEY: z.string().optional(),
  // How many characters of extracted file text to send. Hard cap on per-file
  // prompt size. Files longer than this are truncated with a trailing marker.
  GEMINI_MAX_INPUT_CHARS: z.string().default('40000').transform(Number),
  // Proposal TTL in days. Expired proposals are swept by Phase 6's review flow.
  DRIVE_PROPOSAL_TTL_DAYS: z.string().default('14').transform(Number),

  // ── Mail ───────────────────────────────────────────────────────────────────
  // Driver selection. In dev, 'console' logs the rendered email to stdout
  // instead of sending — safe default. In production, set to 'mailgun'.
  MAIL_DRIVER: z.enum(['console', 'mailgun']).default('console'),
  // Required when MAIL_DRIVER=mailgun. Region selects api.mailgun.net (us) vs
  // api.eu.mailgun.net (eu). MAILGUN_DOMAIN is the sending domain registered
  // in the Mailgun dashboard (e.g. "mg.example.com").
  MAILGUN_API_KEY: z.string().optional(),
  MAILGUN_DOMAIN: z.string().optional(),
  MAILGUN_REGION: z.enum(['us', 'eu']).default('us'),
  MAIL_FROM_ADDRESS: z.string().email().optional(),
  MAIL_FROM_NAME: z.string().default('GUB'),
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
