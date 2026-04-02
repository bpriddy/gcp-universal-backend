/**
 * BrokerTestPage.tsx
 *
 * Dev UI for testing the GUB OAuth broker flow end-to-end.
 * Mounted at /broker-test in App.tsx.
 *
 * No credentials are entered here. The browser only:
 *   1. Navigates to the GUB authorize URL → Google consent screen
 *   2. Returns here with a short-lived auth code in the URL
 *   3. POSTs that code to /dev/broker-test/exchange on GUB
 *      → GUB reads the client credentials from its own env and does the exchange
 *
 * The client_secret never touches the browser.
 * For the full headless simulation (no browser at all except Google consent):
 *   node scripts/test-broker-flow.mjs --client-id gub_xxx --client-secret xxx
 */

import { useEffect, useRef, useState } from 'react';

const GUB_URL = import.meta.env['VITE_API_BASE_URL'] ?? 'http://localhost:3000';
const REDIRECT_URI = `${window.location.origin}/broker-test`;

interface TokenResult {
  accessToken?: string;
  refreshToken?: string;
  expiresIn?: number;
  tokenType?: string;
  user?: { id: string; email: string; displayName: string | null };
  error?: string;
  error_description?: string;
}

interface JwtPayload {
  sub: string;
  email: string;
  isAdmin: boolean;
  permissions: Array<{ appId: string; role: string }>;
  exp: number;
  iat: number;
}

function decodeJwt(token: string): JwtPayload | null {
  try {
    return JSON.parse(atob(token.split('.')[1])) as JwtPayload;
  } catch {
    return null;
  }
}

type Status = 'idle' | 'exchanging' | 'done' | 'error';

export function BrokerTestPage() {
  const params       = new URLSearchParams(window.location.search);
  const inboundCode  = params.get('code');
  const inboundState = params.get('state');
  const inboundError = params.get('error');

  const [status, setStatus]   = useState<Status>('idle');
  const [result, setResult]   = useState<TokenResult | null>(null);
  const [payload, setPayload] = useState<JwtPayload | null>(null);
  const exchanged             = useRef(false);

  // ── Auto-exchange on callback ────────────────────────────────────────────
  useEffect(() => {
    if (!inboundCode || exchanged.current) return;
    exchanged.current = true;
    setStatus('exchanging');

    void (async () => {
      try {
        const res = await fetch(`${GUB_URL}/dev/broker-test/exchange`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: inboundCode }),
        });
        const data = await res.json() as TokenResult;
        setResult(data);
        if (res.ok && data.accessToken) {
          setPayload(decodeJwt(data.accessToken));
          setStatus('done');
        } else {
          setStatus('error');
        }
      } catch (err) {
        setResult({ error: 'FETCH_ERROR', error_description: String(err) });
        setStatus('error');
      }
    })();
  }, [inboundCode]);

  function startFlow() {
    // State is just a random nonce for CSRF protection — nothing sensitive
    const state = `test-${Math.random().toString(36).slice(2, 10)}`;
    const qs = new URLSearchParams({
      response_type: 'code',
      redirect_uri:  REDIRECT_URI,
      state,
    });
    // Client ID comes from GUB env (BROKER_TEST_CLIENT_ID) — not entered here
    // GUB's /dev/broker-test/exchange knows which client to use
    // We still need to pass a client_id to /authorize. Read it from GUB's config
    // by redirecting to a dev shortcut that fills it in automatically.
    window.location.href = `${GUB_URL}/dev/broker-test/start?${qs.toString()}`;
  }

  // ── Google error ─────────────────────────────────────────────────────────
  if (inboundError) {
    return (
      <Page>
        <Card>
          <Heading color="#dc2626">Google returned an error</Heading>
          <Pre>{inboundError}: {params.get('error_description') ?? ''}</Pre>
          <BackLink />
        </Card>
      </Page>
    );
  }

  // ── Exchanging ───────────────────────────────────────────────────────────
  if (status === 'exchanging') {
    return (
      <Page>
        <Card>
          <Heading>Exchanging auth code…</Heading>
          <p style={s.muted}>GUB is trading the code for tokens server-side.</p>
        </Card>
      </Page>
    );
  }

  // ── Result ───────────────────────────────────────────────────────────────
  if (status === 'done' || status === 'error') {
    const ok = status === 'done';
    return (
      <Page>
        <Card>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Heading color={ok ? '#16a34a' : '#dc2626'}>
              {ok ? '✓ Token exchange successful' : '✗ Token exchange failed'}
            </Heading>
            <BackLink />
          </div>

          {ok && payload && (
            <div style={s.infoBox}>
              <Row label="User"        value={`${result?.user?.displayName ?? result?.user?.email} (${result?.user?.email})`} />
              <Row label="User ID"     value={result?.user?.id ?? ''} mono />
              <Row label="isAdmin"     value={String(payload.isAdmin)} />
              <Row label="Permissions" value={payload.permissions.length === 0 ? '(none)' : payload.permissions.map(p => `${p.appId}:${p.role}`).join(', ')} />
              <Row label="Expires"     value={new Date(payload.exp * 1000).toLocaleTimeString()} />
              {inboundState && <Row label="State echoed" value={inboundState} mono />}
            </div>
          )}

          <p style={{ ...s.label, marginTop: '0.75rem' }}>Raw response</p>
          <Pre>{JSON.stringify(result, null, 2)}</Pre>
        </Card>
      </Page>
    );
  }

  // ── Start form ───────────────────────────────────────────────────────────
  return (
    <Page>
      <Card>
        <Heading>OAuth Broker — End-to-End Test</Heading>
        <p style={s.muted}>
          Tests the full server-side OAuth flow. Your client credentials stay
          in GUB's environment — nothing sensitive enters the browser.
        </p>

        <div style={s.callout}>
          <strong>Before starting, make sure:</strong>
          <ol style={{ margin: '0.5rem 0 0 1.25rem', padding: 0, fontSize: '0.8125rem', lineHeight: 1.7 }}>
            <li><code style={s.code}>{REDIRECT_URI}</code> is registered in GCP Console (Authorized redirect URIs)</li>
            <li>The same URI is registered on your OAuth client record in gub-admin</li>
            <li><code style={s.code}>BROKER_TEST_CLIENT_ID</code> and <code style={s.code}>BROKER_TEST_CLIENT_SECRET</code> are set in GUB's <code style={s.code}>.env</code></li>
          </ol>
        </div>

        <div style={s.step}>
          <span style={s.stepNum}>1</span>
          <div>
            <p style={s.stepTitle}>Your browser opens Google sign-in</p>
            <p style={s.muted}>GUB constructs the authorize URL using the client ID from its env.</p>
          </div>
        </div>
        <div style={s.step}>
          <span style={s.stepNum}>2</span>
          <div>
            <p style={s.stepTitle}>You sign in and approve</p>
            <p style={s.muted}>Google redirects back here with a short-lived auth code.</p>
          </div>
        </div>
        <div style={s.step}>
          <span style={s.stepNum}>3</span>
          <div>
            <p style={s.stepTitle}>GUB exchanges the code server-side</p>
            <p style={s.muted}>This page sends only the code to GUB. GUB reads the client secret from its env and does the token exchange — your secret never leaves the server.</p>
          </div>
        </div>

        <button style={s.btn} onClick={startFlow}>
          Start OAuth flow →
        </button>

        <p style={{ ...s.muted, marginTop: '1rem', fontSize: '0.75rem' }}>
          For a fully headless test (no browser UI at all):{' '}
          <code style={s.code}>
            node scripts/test-broker-flow.mjs --client-id gub_xxx --client-secret xxx
          </code>
        </p>
      </Card>
    </Page>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function Page({ children }: { children: React.ReactNode }) {
  return <div style={s.page}>{children}</div>;
}

function Card({ children }: { children: React.ReactNode }) {
  return <div style={s.card}>{children}</div>;
}

function Heading({ children, color = '#111827' }: { children: React.ReactNode; color?: string }) {
  return <h1 style={{ ...s.heading, color }}>{children}</h1>;
}

function Pre({ children }: { children: React.ReactNode }) {
  return <pre style={s.pre}>{children}</pre>;
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div style={{ display: 'flex', gap: '0.5rem', fontSize: '0.8125rem' }}>
      <span style={{ color: '#6b7280', minWidth: '110px', flexShrink: 0 }}>{label}:</span>
      <span style={mono ? s.code : undefined}>{value}</span>
    </div>
  );
}

function BackLink() {
  return (
    <a
      href="/broker-test"
      onClick={(e) => { e.preventDefault(); window.history.replaceState({}, '', '/broker-test'); window.location.reload(); }}
      style={s.link}
    >
      ← Test again
    </a>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  page:      { minHeight: '100vh', background: '#f9fafb', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '3rem 1rem' },
  card:      { background: '#fff', border: '1px solid #e5e7eb', borderRadius: '12px', padding: '2rem', width: '100%', maxWidth: '560px', display: 'flex', flexDirection: 'column', gap: '1rem' },
  heading:   { fontSize: '1.25rem', fontWeight: 600, margin: 0 },
  muted:     { fontSize: '0.875rem', color: '#6b7280', margin: 0 },
  label:     { fontSize: '0.75rem', color: '#6b7280', fontWeight: 500, margin: 0 },
  callout:   { background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: '8px', padding: '0.75rem 1rem', fontSize: '0.8125rem', color: '#1d4ed8' },
  infoBox:   { background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: '8px', padding: '0.75rem 1rem', display: 'flex', flexDirection: 'column', gap: '4px' },
  step:      { display: 'flex', gap: '0.75rem', alignItems: 'flex-start' },
  stepNum:   { background: '#111827', color: '#fff', borderRadius: '50%', width: '22px', height: '22px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.75rem', fontWeight: 600, flexShrink: 0, marginTop: '1px' },
  stepTitle: { fontSize: '0.875rem', fontWeight: 500, margin: '0 0 2px' },
  btn:       { background: '#111827', color: '#fff', border: 'none', borderRadius: '6px', padding: '0.625rem 1.25rem', fontSize: '0.875rem', cursor: 'pointer' },
  pre:       { background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: '6px', padding: '1rem', fontSize: '0.75rem', overflowX: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: 0, maxHeight: '400px', overflowY: 'auto' },
  code:      { fontFamily: 'monospace', fontSize: '0.8em', background: '#f3f4f6', padding: '1px 4px', borderRadius: '3px' },
  link:      { color: '#2563eb', fontSize: '0.875rem', textDecoration: 'none' },
};
