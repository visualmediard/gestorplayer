import { useState, useEffect, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import logoNegro from '../assets/logo/logo-negro.png'

export default function Register() {
  const [orgName, setOrgName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [fullName, setFullName] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    supabase.auth.signOut().then(() => setReady(true))
  }, [])

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (password !== confirm) { setError('Las contraseñas no coinciden.'); return }
    if (password.length < 8) { setError('La contraseña debe tener al menos 8 caracteres.'); return }
    if (!orgName.trim()) { setError('El nombre de la empresa es requerido.'); return }
    setSubmitting(true)

    const { data: authData, error: authError } = await supabase.auth.signUp({ email, password })
    if (authError || !authData.user) { setError(authError?.message ?? 'Error creando usuario.'); setSubmitting(false); return }

    const slug = orgName.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') + '-' + Math.random().toString(36).substring(2, 6)

    const { error: fnError } = await supabase.rpc('register_organization', {
      p_org_name: orgName.trim(), p_slug: slug,
      p_email: email, p_full_name: fullName.trim() || orgName.trim(),
      p_user_id: authData.user.id,
    })

    setSubmitting(false)
    if (fnError) { setError('Error en registro: ' + fnError.message); return }
    setSuccess(true)
  }

  if (success) {
    return (
      <div style={s.page}>
        <div style={s.card}>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>✅</div>
            <h2 style={{ color: '#0F172A', fontWeight: 700, fontSize: '1.25rem', marginBottom: '0.5rem' }}>¡Cuenta creada!</h2>
            <p style={{ color: '#64748B', fontSize: '0.9rem', marginBottom: '1.5rem' }}>
              Tu empresa y usuario administrador han sido registrados exitosamente.
            </p>
            <a href="/" style={{ ...s.btn, display: 'inline-block', textDecoration: 'none', textAlign: 'center' }}>
              Ir al login
            </a>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div style={s.page}>
      <div style={s.card}>
        {/* Logo */}
        <div style={s.logoWrap}>
          <div style={{ width: '160px', height: '44px', overflow: 'hidden', position: 'relative', flexShrink: 0 }}>
            <img src={logoNegro} alt="GestorPlayer" style={{ position: 'absolute', width: '500px', top: '-191px', left: '-55px' }} />
          </div>
          <span style={s.betaBadge}>BETA</span>
        </div>

        <div style={s.divider} />

        <h2 style={s.heading}>Crear cuenta empresarial</h2>
        <p style={s.subheading}>Registra tu empresa para empezar a gestionar tus pantallas</p>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '0.875rem', marginTop: '1.5rem' }}>
          <div style={s.fieldGroup}>
            <label style={s.label}>Nombre de la empresa</label>
            <input style={s.input} value={orgName} onChange={e => setOrgName(e.target.value)} placeholder="Ej: Outdoor Media RD" required />
          </div>

          <div style={s.fieldGroup}>
            <label style={s.label}>Tu nombre</label>
            <input style={s.input} value={fullName} onChange={e => setFullName(e.target.value)} placeholder="Ej: Juan Pérez" />
          </div>

          <div style={s.fieldGroup}>
            <label style={s.label}>Correo electrónico</label>
            <input type="email" style={s.input} value={email} onChange={e => setEmail(e.target.value)} placeholder="tu@empresa.com" required autoComplete="email" />
          </div>

          <div style={s.fieldGroup}>
            <label style={s.label}>Contraseña</label>
            <input type="password" style={s.input} value={password} onChange={e => setPassword(e.target.value)} placeholder="Mínimo 8 caracteres" required />
          </div>

          <div style={s.fieldGroup}>
            <label style={s.label}>Confirmar contraseña</label>
            <input type="password" style={s.input} value={confirm} onChange={e => setConfirm(e.target.value)} required />
          </div>

          {error && (
            <div style={s.errorBox}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
              {error}
            </div>
          )}

          <button type="submit" disabled={submitting || !ready} style={{ ...s.btn, opacity: submitting || !ready ? 0.7 : 1, marginTop: '0.25rem' }}>
            {!ready ? 'Preparando...' : submitting ? 'Creando cuenta...' : 'Crear cuenta'}
          </button>
        </form>

        <p style={s.loginLink}>
          ¿Ya tienes cuenta?{' '}
          <a href="/" style={{ color: '#2563EB', fontWeight: 600, textDecoration: 'none' }}>Inicia sesión</a>
        </p>
      </div>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  page: {
    minHeight: '100vh', background: '#F8FAFC',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontFamily: "'Inter', system-ui, sans-serif", padding: '1.5rem',
  },
  card: {
    background: '#fff', borderRadius: '16px', padding: '2.5rem',
    width: '100%', maxWidth: '420px',
    boxShadow: '0 4px 24px rgba(0,0,0,0.08)', border: '1px solid #E2E8F0',
  },
  logoWrap: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', marginBottom: '1.5rem' },
  logoIcon: { width: '36px', height: '36px', background: '#3B82F6', borderRadius: '10px', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  logoText: { fontWeight: 800, fontSize: '1.25rem', color: '#0F172A' },
  betaBadge: { fontSize: '0.6rem', fontWeight: 700, background: '#EFF6FF', color: '#3B82F6', border: '1px solid #BFDBFE', borderRadius: '4px', padding: '2px 6px', letterSpacing: '0.05em' },
  divider: { height: '1px', background: '#F1F5F9', marginBottom: '1.5rem' },
  heading: { fontSize: '1.1rem', fontWeight: 700, color: '#0F172A', textAlign: 'center', margin: 0 },
  subheading: { color: '#94A3B8', fontSize: '0.82rem', textAlign: 'center', marginTop: '0.25rem' },
  fieldGroup: { display: 'flex', flexDirection: 'column', gap: '0.35rem' },
  label: { fontSize: '0.8rem', fontWeight: 600, color: '#374151' },
  input: { padding: '0.65rem 0.875rem', borderRadius: '8px', border: '1px solid #E2E8F0', background: '#F8FAFC', color: '#0F172A', fontSize: '0.9rem', outline: 'none' },
  errorBox: { display: 'flex', alignItems: 'center', gap: '0.5rem', background: '#FFF5F5', border: '1px solid #FECACA', borderRadius: '8px', padding: '0.6rem 0.875rem', color: '#EF4444', fontSize: '0.8rem', fontWeight: 500 },
  btn: { padding: '0.7rem', borderRadius: '8px', border: 'none', background: '#2563EB', color: '#fff', fontWeight: 700, fontSize: '0.95rem', cursor: 'pointer', width: '100%' },
  loginLink: { textAlign: 'center', color: '#94A3B8', fontSize: '0.8rem', marginTop: '1.25rem' },
}