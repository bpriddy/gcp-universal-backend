import { useAuth } from './auth/useAuth';
import { LoginPage } from './components/LoginPage';
import { Dashboard } from './components/Dashboard';

export default function App() {
  const auth = useAuth();

  if (auth.status === 'loading') {
    return (
      <div style={loadingStyles.page}>
        <div style={loadingStyles.spinner}>
          <div style={loadingStyles.dot} />
        </div>
        <p style={loadingStyles.text}>Restoring session…</p>
      </div>
    );
  }

  if (auth.status === 'authenticated') {
    return <Dashboard auth={auth} />;
  }

  // 'unauthenticated' or 'error'
  return <LoginPage auth={auth} />;
}

const loadingStyles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: '100vh',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
    gap: '1rem',
  },
  spinner: {
    width: '40px', height: '40px', borderRadius: '50%',
    border: '3px solid rgba(255,255,255,0.3)',
    borderTopColor: '#fff',
    animation: 'spin 0.8s linear infinite',
  },
  dot: {},
  text: { color: 'rgba(255,255,255,0.8)', fontSize: '0.875rem' },
};
