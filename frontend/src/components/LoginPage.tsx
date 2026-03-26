import { useEffect, useRef } from 'react';
import type { UseAuthReturn } from '../auth/useAuth';

interface Props {
  auth: UseAuthReturn;
}

export function LoginPage({ auth }: Props) {
  const buttonRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!buttonRef.current) return;

    // Wait for the Google GSI script to be ready
    if (window.google?.accounts?.id) {
      auth.renderGoogleButton(buttonRef.current);
      return;
    }

    // Script loads async — poll until ready
    const interval = setInterval(() => {
      if (window.google?.accounts?.id && buttonRef.current) {
        auth.renderGoogleButton(buttonRef.current);
        clearInterval(interval);
      }
    }, 100);

    return () => clearInterval(interval);
  }, [auth]);

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <div style={styles.logo}>🔐</div>
        <h1 style={styles.title}>GCP Universal Backend</h1>
        <p style={styles.subtitle}>
          Sign in with your Google account to continue.
          <br />
          Your access is determined by your permissions in our system.
        </p>

        {auth.error && (
          <div style={styles.errorBanner}>
            <strong>Login failed:</strong> {auth.error}
          </div>
        )}

        {auth.status === 'loading' ? (
          <div style={styles.spinner}>Signing you in…</div>
        ) : (
          <div ref={buttonRef} style={styles.buttonContainer} />
        )}

        <p style={styles.hint}>
          Only accounts with registered permissions can access applications.
        </p>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
    padding: '1rem',
  },
  card: {
    background: '#fff',
    borderRadius: '16px',
    padding: '2.5rem',
    width: '100%',
    maxWidth: '420px',
    textAlign: 'center',
    boxShadow: '0 20px 60px rgba(0,0,0,0.2)',
  },
  logo: { fontSize: '3rem', marginBottom: '1rem' },
  title: { fontSize: '1.5rem', fontWeight: 700, marginBottom: '0.75rem', color: '#1a1a2e' },
  subtitle: { color: '#6b7280', lineHeight: 1.6, marginBottom: '1.5rem', fontSize: '0.9rem' },
  errorBanner: {
    background: '#fef2f2',
    border: '1px solid #fecaca',
    borderRadius: '8px',
    padding: '0.75rem 1rem',
    color: '#dc2626',
    fontSize: '0.875rem',
    marginBottom: '1.25rem',
    textAlign: 'left',
  },
  buttonContainer: {
    display: 'flex',
    justifyContent: 'center',
    minHeight: '44px',
    marginBottom: '1.5rem',
  },
  spinner: { color: '#6b7280', fontSize: '0.9rem', padding: '0.75rem', marginBottom: '1.5rem' },
  hint: { fontSize: '0.75rem', color: '#9ca3af' },
};
