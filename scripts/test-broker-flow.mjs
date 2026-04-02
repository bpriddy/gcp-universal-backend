#!/usr/bin/env node
/**
 * test-broker-flow.mjs
 *
 * End-to-end simulation of a headless OAuth client using the GUB broker.
 * Mirrors exactly what Agentspace (or any server-side agent) would do.
 *
 * Usage:
 *   node scripts/test-broker-flow.mjs \
 *     --client-id   gub_xxxx \
 *     --client-secret XXXX \
 *     [--gub-url http://localhost:3000] \
 *     [--port 9999]
 *
 * Or via env vars:
 *   BROKER_TEST_CLIENT_ID=gub_xxx \
 *   BROKER_TEST_CLIENT_SECRET=xxx \
 *   node scripts/test-broker-flow.mjs
 *
 * What happens:
 *   1. Spins up a local HTTP server on --port to catch the OAuth callback
 *   2. Builds the GUB authorize URL and opens it in your browser
 *   3. You sign in with Google (the only step that requires a human)
 *   4. Google → GUB callback → GUB issues a short-lived auth code → redirected here
 *   5. This script exchanges the code with GUB's token endpoint (server-to-server)
 *   6. Prints the resulting GUB access token, refresh token, and decoded user payload
 *
 * No credentials ever touch the browser.
 * Zero npm dependencies — uses Node built-ins only (http, crypto, child_process, url).
 */

import http from 'http';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// ── Parse args ────────────────────────────────────────────────────────────────

function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const CLIENT_ID     = arg('--client-id')     ?? process.env.BROKER_TEST_CLIENT_ID;
const CLIENT_SECRET = arg('--client-secret') ?? process.env.BROKER_TEST_CLIENT_SECRET;
const GUB_URL       = (arg('--gub-url')      ?? process.env.GUB_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const PORT          = parseInt(arg('--port') ?? process.env.BROKER_TEST_PORT ?? '9999', 10);

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error(`
Usage:
  node scripts/test-broker-flow.mjs \\
    --client-id   <client_id> \\
    --client-secret <client_secret> \\
    [--gub-url http://localhost:3000] \\
    [--port 9999]

Or set BROKER_TEST_CLIENT_ID and BROKER_TEST_CLIENT_SECRET env vars.
`);
  process.exit(1);
}

const REDIRECT_URI  = `http://localhost:${PORT}/callback`;
const STATE         = `test-${Math.random().toString(36).slice(2, 10)}`;

// ── Open browser helper ───────────────────────────────────────────────────────

async function openBrowser(url) {
  const platform = process.platform;
  const cmd = platform === 'darwin' ? `open "${url}"`
            : platform === 'win32'  ? `start "" "${url}"`
            : `xdg-open "${url}"`;
  try {
    await execAsync(cmd);
  } catch {
    // Fallback — just print the URL
  }
}

// ── Decode JWT (no signature verification — display only) ─────────────────────

function decodeJwt(token) {
  try {
    const payload = token.split('.')[1];
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'));
  } catch {
    return null;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n── GUB OAuth Broker — End-to-End Test ──────────────────────────────\n');
  console.log(`  GUB URL:      ${GUB_URL}`);
  console.log(`  Client ID:    ${CLIENT_ID}`);
  console.log(`  Callback:     ${REDIRECT_URI}`);
  console.log(`  State:        ${STATE}`);
  console.log('');

  // Step 1: build the authorize URL
  const authorizeParams = new URLSearchParams({
    client_id:     CLIENT_ID,
    redirect_uri:  REDIRECT_URI,
    response_type: 'code',
    state:         STATE,
  });
  const authorizeUrl = `${GUB_URL}/auth/google/broker/authorize?${authorizeParams}`;

  // Step 2: wait for callback on local HTTP server
  const { code, returnedState } = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://localhost:${PORT}`);

      if (url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }

      const code  = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const error = url.searchParams.get('error');

      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/html' }).end(
          `<h2>Error: ${error}</h2><p>${url.searchParams.get('error_description') ?? ''}</p>`,
        );
        server.close();
        reject(new Error(`Google returned error: ${error}`));
        return;
      }

      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/html' }).end('<h2>Missing code</h2>');
        server.close();
        reject(new Error('Callback received but no code present'));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html' }).end(`
        <html><body style="font-family:sans-serif;padding:2rem">
          <h2 style="color:#16a34a">✓ Auth code received</h2>
          <p>Exchanging for GUB tokens… you can close this tab.</p>
        </body></html>
      `);
      server.close();
      resolve({ code, returnedState: state });
    });

    server.listen(PORT, () => {
      console.log(`  Listening for callback on port ${PORT}…`);
      console.log('\n  Opening browser to Google sign-in.\n');
      console.log(`  (If it doesn't open automatically, visit this URL manually:)\n`);
      console.log(`  ${authorizeUrl}\n`);
      void openBrowser(authorizeUrl);
    });

    server.on('error', reject);

    // Timeout after 5 minutes
    setTimeout(() => {
      server.close();
      reject(new Error('Timed out waiting for callback (5 min)'));
    }, 5 * 60 * 1000);
  });

  // Step 3: validate state
  if (returnedState !== STATE) {
    throw new Error(`State mismatch! Expected "${STATE}", got "${returnedState}"`);
  }
  console.log('  ✓ State validated\n');

  // Step 4: exchange code for GUB tokens (server-to-server)
  console.log('  Exchanging auth code for GUB tokens…');
  const tokenRes = await fetch(`${GUB_URL}/auth/google/broker/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type:    'authorization_code',
      code,
      redirect_uri:  REDIRECT_URI,
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
  });

  const tokenData = await tokenRes.json();

  if (!tokenRes.ok) {
    console.error('\n  ✗ Token exchange failed:\n');
    console.error(JSON.stringify(tokenData, null, 2));
    process.exit(1);
  }

  // Step 5: print results
  const payload = decodeJwt(tokenData.accessToken);

  console.log('\n── Result ───────────────────────────────────────────────────────────\n');
  console.log('  User:');
  console.log(`    email:       ${tokenData.user?.email}`);
  console.log(`    displayName: ${tokenData.user?.displayName ?? '(none)'}`);
  console.log(`    id:          ${tokenData.user?.id}`);
  console.log('');
  console.log('  Tokens:');
  console.log(`    tokenType:   ${tokenData.tokenType}`);
  console.log(`    expiresIn:   ${tokenData.expiresIn}s`);
  console.log(`    accessToken: ${tokenData.accessToken?.slice(0, 40)}…`);
  console.log(`    refreshToken: ${tokenData.refreshToken?.slice(0, 20)}…`);

  if (payload) {
    const exp = new Date(payload.exp * 1000).toLocaleTimeString();
    console.log('');
    console.log('  Decoded access token payload:');
    console.log(`    sub:         ${payload.sub}`);
    console.log(`    email:       ${payload.email}`);
    console.log(`    isAdmin:     ${payload.isAdmin}`);
    console.log(`    permissions: ${JSON.stringify(payload.permissions ?? [])}`);
    console.log(`    expires at:  ${exp}`);
  }

  console.log('\n── Full token response (JSON) ───────────────────────────────────────\n');
  console.log(JSON.stringify(tokenData, null, 2));
  console.log('\n────────────────────────────────────────────────────────────────────\n');
}

main().catch((err) => {
  console.error('\n  ✗ Error:', err.message);
  process.exit(1);
});
