/**
 * AppDataExample.tsx
 * Demonstrates making an authenticated API call to a specific application's
 * database endpoint using the JWT Bearer token + requireAppAccess middleware.
 */

import { useState } from 'react';
import { apiClient } from '../api/apiClient';
import { AuthApiError } from '../auth/authClient';

interface Props {
  appId: string;
  label: string;
  endpoint: string;
}

type FetchState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; data: unknown }
  | { status: 'error'; message: string; code: string };

export function AppDataExample({ appId, label, endpoint }: Props) {
  const [fetchState, setFetchState] = useState<FetchState>({ status: 'idle' });

  async function fetchData() {
    setFetchState({ status: 'loading' });
    try {
      const { data } = await apiClient.get(endpoint);
      setFetchState({ status: 'success', data });
    } catch (err) {
      if (err instanceof AuthApiError) {
        setFetchState({ status: 'error', message: err.message, code: err.code });
      } else {
        setFetchState({ status: 'error', message: 'Unexpected error', code: 'UNKNOWN' });
      }
    }
  }

  return (
    <div style={styles.card}>
      <div style={styles.header}>
        <span style={styles.appBadge}>{appId}</span>
        <h3 style={styles.label}>{label}</h3>
      </div>
      <p style={styles.endpoint}>
        <code>{endpoint}</code>
      </p>

      <button
        style={styles.button}
        onClick={() => void fetchData()}
        disabled={fetchState.status === 'loading'}
      >
        {fetchState.status === 'loading' ? 'Fetching…' : 'Fetch Data'}
      </button>

      {fetchState.status === 'success' && (
        <div style={styles.resultBox}>
          <div style={styles.resultLabel}>✅ Response</div>
          <pre style={styles.pre}>{JSON.stringify(fetchState.data, null, 2)}</pre>
        </div>
      )}

      {fetchState.status === 'error' && (
        <div style={{ ...styles.resultBox, ...styles.errorBox }}>
          <div style={styles.resultLabel}>
            ❌ {fetchState.code === 'FORBIDDEN' ? 'Access Denied' : 'Error'}
          </div>
          <p style={styles.errorText}>
            {fetchState.code === 'FORBIDDEN'
              ? "Your account doesn't have permission to access this application."
              : fetchState.message}
          </p>
          <code style={styles.errorCode}>{fetchState.code}</code>
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  card: {
    background: '#fff',
    border: '1px solid #e5e7eb',
    borderRadius: '12px',
    padding: '1.25rem',
    marginBottom: '1rem',
  },
  header: { display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.5rem' },
  appBadge: {
    background: '#ede9fe',
    color: '#7c3aed',
    fontSize: '0.7rem',
    fontWeight: 700,
    padding: '0.2rem 0.6rem',
    borderRadius: '999px',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  },
  label: { fontSize: '1rem', fontWeight: 600, color: '#111827' },
  endpoint: { fontSize: '0.8rem', color: '#6b7280', marginBottom: '1rem' },
  button: {
    background: '#7c3aed',
    color: '#fff',
    border: 'none',
    borderRadius: '8px',
    padding: '0.5rem 1.25rem',
    fontSize: '0.875rem',
    fontWeight: 600,
    cursor: 'pointer',
    transition: 'opacity 0.15s',
  },
  resultBox: {
    marginTop: '1rem',
    background: '#f0fdf4',
    border: '1px solid #bbf7d0',
    borderRadius: '8px',
    padding: '0.75rem',
  },
  errorBox: { background: '#fef2f2', border: '1px solid #fecaca' },
  resultLabel: { fontSize: '0.75rem', fontWeight: 700, marginBottom: '0.5rem', color: '#374151' },
  pre: {
    fontSize: '0.75rem',
    color: '#1a1a2e',
    overflowX: 'auto',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
    margin: 0,
  },
  errorText: { fontSize: '0.875rem', color: '#dc2626', marginBottom: '0.25rem' },
  errorCode: { fontSize: '0.75rem', color: '#9ca3af' },
};
