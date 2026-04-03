import { useState } from 'react';
import type { UseAuthReturn } from '../auth/useAuth';
import { AppDataExample } from './AppDataExample';

interface Props {
  auth: UseAuthReturn;
}

export function Dashboard({ auth }: Props) {
  const [showTokenInfo, setShowTokenInfo] = useState(false);

  const user = auth.user!;
  const initials = user.displayName
    ? user.displayName.split(' ').map((n) => n[0]).join('').toUpperCase().slice(0, 2)
    : user.email[0]?.toUpperCase() ?? '?';

  return (
    <div style={styles.page}>
      {/* ── Header ── */}
      <header style={styles.header}>
        <div style={styles.headerInner}>
          <div style={styles.brand}>
            <span style={styles.brandIcon}>🔐</span>
            <span style={styles.brandName}>GCP Universal Backend</span>
          </div>
          <div style={styles.userMenu}>
            <div style={styles.avatar}>{initials}</div>
            <div style={styles.userInfo}>
              <div style={styles.userName}>{user.displayName ?? 'User'}</div>
              <div style={styles.userEmail}>{user.email}</div>
            </div>
            <div style={styles.logoutGroup}>
              <button style={styles.btnSecondary} onClick={() => void auth.logout()}>
                Sign out
              </button>
              <button
                style={{ ...styles.btnSecondary, ...styles.btnDanger }}
                onClick={() => void auth.logoutAll()}
                title="Signs out of all devices"
              >
                All devices
              </button>
            </div>
          </div>
        </div>
      </header>

      <main style={styles.main}>
        {/* ── Session info ── */}
        <section style={styles.section}>
          <div style={styles.sectionHeader}>
            <h2 style={styles.sectionTitle}>Active Session</h2>
            <button
              style={styles.btnLink}
              onClick={() => setShowTokenInfo((v) => !v)}
            >
              {showTokenInfo ? 'Hide token details' : 'Show token details'}
            </button>
          </div>

          <div style={styles.infoGrid}>
            <InfoRow label="User ID" value={user.id} mono />
            <InfoRow label="Email" value={user.email} />
            <InfoRow label="Display name" value={user.displayName ?? '—'} />
            <InfoRow
              label="Access token"
              value="In memory only — never written to storage"
              subtle
            />
            <InfoRow
              label="Refresh token"
              value="Stored in localStorage (SHA-256 hash stored in DB)"
              subtle
            />
          </div>

          {showTokenInfo && <TokenDebugPanel />}
        </section>

        {/* ── Org data demo ── */}
        <section style={styles.section}>
          <h2 style={styles.sectionTitle}>Org Data</h2>
          <p style={styles.sectionDesc}>
            Each request below sends your JWT Bearer token. The backend checks your
            grants and returns only the data you have access to.
            Try an endpoint you haven't been granted — you'll get a{' '}
            <code>403 FORBIDDEN</code>.
          </p>

          <AppDataExample
            appId="accounts"
            label="Accounts"
            endpoint="/org/accounts"
          />
          <AppDataExample
            appId="staff"
            label="Staff Directory"
            endpoint="/org/staff"
          />
          <AppDataExample
            appId="access-requests"
            label="My Access Requests"
            endpoint="/org/access-requests"
          />
        </section>
      </main>
    </div>
  );
}

function InfoRow({
  label,
  value,
  mono = false,
  subtle = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
  subtle?: boolean;
}) {
  return (
    <div style={styles.infoRow}>
      <span style={styles.infoLabel}>{label}</span>
      <span
        style={{
          ...styles.infoValue,
          ...(mono ? styles.infoMono : {}),
          ...(subtle ? styles.infoSubtle : {}),
        }}
      >
        {value}
      </span>
    </div>
  );
}

function TokenDebugPanel() {
  const rt = localStorage.getItem('gcp_refresh_token');
  return (
    <div style={styles.debugPanel}>
      <p style={styles.debugTitle}>🔍 Debug — localStorage contents</p>
      <div style={styles.debugRow}>
        <span style={styles.debugKey}>gcp_refresh_token</span>
        <span style={styles.debugValue}>
          {rt ? `${rt.slice(0, 12)}…${rt.slice(-6)} (${rt.length} chars)` : 'not set'}
        </span>
      </div>
      <p style={styles.debugNote}>
        The access token lives only in memory — it disappears on page refresh.
        The refresh token here is the raw opaque value; the backend stores only its SHA-256 hash.
      </p>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: { minHeight: '100vh', background: '#f0f2f5' },
  header: { background: '#fff', borderBottom: '1px solid #e5e7eb', position: 'sticky', top: 0, zIndex: 10 },
  headerInner: {
    maxWidth: '900px', margin: '0 auto', padding: '0 1.5rem',
    height: '64px', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  },
  brand: { display: 'flex', alignItems: 'center', gap: '0.5rem' },
  brandIcon: { fontSize: '1.25rem' },
  brandName: { fontWeight: 700, fontSize: '1rem', color: '#1a1a2e' },
  userMenu: { display: 'flex', alignItems: 'center', gap: '0.75rem' },
  avatar: {
    width: '36px', height: '36px', borderRadius: '50%',
    background: '#7c3aed', color: '#fff', fontWeight: 700,
    fontSize: '0.875rem', display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  userInfo: { display: 'flex', flexDirection: 'column' },
  userName: { fontSize: '0.875rem', fontWeight: 600, color: '#111827' },
  userEmail: { fontSize: '0.75rem', color: '#6b7280' },
  logoutGroup: { display: 'flex', gap: '0.5rem', marginLeft: '0.5rem' },
  btnSecondary: {
    background: 'none', border: '1px solid #d1d5db', borderRadius: '6px',
    padding: '0.35rem 0.75rem', fontSize: '0.8rem', cursor: 'pointer', color: '#374151',
  },
  btnDanger: { color: '#dc2626', borderColor: '#fca5a5' },
  btnLink: {
    background: 'none', border: 'none', color: '#7c3aed',
    fontSize: '0.8rem', cursor: 'pointer', textDecoration: 'underline',
  },
  main: { maxWidth: '900px', margin: '0 auto', padding: '2rem 1.5rem' },
  section: { marginBottom: '2rem' },
  sectionHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem' },
  sectionTitle: { fontSize: '1.1rem', fontWeight: 700, color: '#111827' },
  sectionDesc: { color: '#6b7280', fontSize: '0.875rem', lineHeight: 1.6, marginBottom: '1.25rem' },
  infoGrid: {
    background: '#fff', border: '1px solid #e5e7eb', borderRadius: '12px',
    overflow: 'hidden',
  },
  infoRow: {
    display: 'flex', alignItems: 'flex-start', gap: '1rem',
    padding: '0.75rem 1.25rem', borderBottom: '1px solid #f3f4f6',
  },
  infoLabel: { width: '140px', flexShrink: 0, fontSize: '0.8rem', color: '#6b7280', fontWeight: 500, paddingTop: '1px' },
  infoValue: { fontSize: '0.875rem', color: '#111827', wordBreak: 'break-all' },
  infoMono: { fontFamily: 'monospace', fontSize: '0.8rem' },
  infoSubtle: { color: '#9ca3af', fontStyle: 'italic' },
  debugPanel: {
    marginTop: '1rem', background: '#1e1e2e', borderRadius: '10px',
    padding: '1rem 1.25rem', color: '#cdd6f4',
  },
  debugTitle: { fontSize: '0.8rem', fontWeight: 600, marginBottom: '0.75rem', color: '#cba6f7' },
  debugRow: { display: 'flex', gap: '1rem', marginBottom: '0.75rem', alignItems: 'flex-start' },
  debugKey: { fontSize: '0.75rem', color: '#89b4fa', fontFamily: 'monospace', flexShrink: 0 },
  debugValue: { fontSize: '0.75rem', fontFamily: 'monospace', color: '#a6e3a1', wordBreak: 'break-all' },
  debugNote: { fontSize: '0.75rem', color: '#6c7086', lineHeight: 1.5, marginTop: '0.5rem' },
};
