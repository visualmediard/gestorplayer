import { useState, type FormEvent } from 'react'
import { useAuth } from '../auth/AuthContext'
import logoNegro from '../assets/logo/logo-negro.png'

export default function Login() {
  const { signIn } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    const { error } = await signIn(email, password)
    setSubmitting(false)
    if (error) setError('Correo o contraseña incorrectos.')
  }

  return (
    <div style={s.page}>
      <div style={s.card}>
        {/* Logo */}
        <div style={s.logoWrap}>
          <img src={logoNegro} alt="GestorPlayer" style={{ height: '44px', width: 'auto' }} />
          <span style={s.betaBadge}>BETA</span>
        </div>

        <div style={s.divider} />

        <h2 style={s.heading}>Iniciar sesión</h2>
        <p style={s.subheading}>Acceso restringido — equipo de administración</p>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1rem', marginTop: '1.5rem' }}>
          <div style={s.fieldGroup}>
            <label style={s.label}>Correo electrónico</label>
            <input
              type="email" value={email} onChange={e => setEmail(e.target.value)}
              required style={s.input} placeholder="tu@empresa.com" autoComplete="email"
            />
          </div>

          <div style={s.fieldGroup}>
            <label style={s.label}>Contraseña</label>
            <input
              type="password" value={password} onChange={e => setPassword(e.target.value)}
              required style={s.input} placeholder="••••••••" autoComplete="current-password"
            />
          </div>

          {error && (
            <div style={s.errorBox}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
              {error}
            </div>
          )}

          <button type="submit" disabled={submitting} style={{ ...s.btn, opacity: submitting ? 0.7 : 1 }}>
            {submitting ? 'Entrando...' : 'Entrar'}
          </button>
        </form>

        <p style={s.registerLink}>
          ¿Tu empresa no tiene cuenta?{' '}
          <a href="/register" style={{ color: '#2563EB', fontWeight: 600, textDecoration: 'none' }}>Regístrate</a>
        </p>
      </div>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  page: {
    minHeight: '100vh',
    background: '#F8FAFC',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontFamily: "'Inter', system-ui, sans-serif",
    padding: '1rem',
  },
  card: {
    background: '#fff',
    borderRadius: '16px',
    padding: '2.5rem',
    width: '100%',
    maxWidth: '400px',
    boxShadow: '0 4px 24px rgba(0,0,0,0.08)',
    border: '1px solid #E2E8F0',
  },
  logoWrap: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '0.5rem',
    marginBottom: '1.5rem',
  },
  logoIcon: {
    width: '36px', height: '36px',
    background: '#3B82F6',
    borderRadius: '10px',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    flexShrink: 0,
  },
  logoText: {
    fontWeight: 800,
    fontSize: '1.25rem',
    color: '#0F172A',
  },
  betaBadge: {
    fontSize: '0.6rem', fontWeight: 700,
    background: '#EFF6FF', color: '#3B82F6',
    border: '1px solid #BFDBFE',
    borderRadius: '4px', padding: '2px 6px',
    letterSpacing: '0.05em',
  },
  divider: {
    height: '1px',
    background: '#F1F5F9',
    marginBottom: '1.5rem',
  },
  heading: {
    fontSize: '1.25rem',
    fontWeight: 700,
    color: '#0F172A',
    textAlign: 'center',
  },
  subheading: {
    fontSize: '0.85rem',
    color: '#94A3B8',
    textAlign: 'center',
    marginTop: '0.25rem',
  },
  fieldGroup: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.35rem',
  },
  label: {
    fontSize: '0.8rem',
    fontWeight: 600,
    color: '#374151',
  },
  input: {
    padding: '0.65rem 0.875rem',
    borderRadius: '8px',
    border: '1px solid #E2E8F0',
    background: '#F8FAFC',
    color: '#0F172A',
    fontSize: '0.9rem',
    outline: 'none',
    transition: 'border-color 0.15s',
  },
  errorBox: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    background: '#FFF5F5',
    border: '1px solid #FECACA',
    borderRadius: '8px',
    padding: '0.6rem 0.875rem',
    color: '#EF4444',
    fontSize: '0.8rem',
    fontWeight: 500,
  },
  btn: {
    padding: '0.7rem',
    borderRadius: '8px',
    border: 'none',
    background: '#2563EB',
    color: '#fff',
    fontWeight: 700,
    fontSize: '0.95rem',
    cursor: 'pointer',
    marginTop: '0.25rem',
  },
  registerLink: {
    textAlign: 'center',
    color: '#94A3B8',
    fontSize: '0.8rem',
    marginTop: '1.25rem',
  },
}