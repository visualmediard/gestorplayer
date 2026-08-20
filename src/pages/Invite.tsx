import { useState, useEffect, type FormEvent } from 'react'
import { useAuth } from '../auth/AuthContext'
import { supabase } from '../lib/supabase'
import logoNegro from '../assets/logo/logo-negro.png'

// Página pública para canjear un enlace de invitación (?token=xxx).
// - Con sesión activa: un botón acepta directo.
// - Sin sesión: formulario de registro (Confirm email está desactivado, así
//   que tras signUp la sesión queda activa y se puede llamar la RPC).
export default function Invite() {
  const { session, loading } = useAuth()
  const token = new URLSearchParams(window.location.search).get('token')

  const [org, setOrg] = useState<{ name: string; logoUrl: string | null } | null>(null)

  // Branding de la organización que invitó (vía RPC, funciona sin sesión).
  useEffect(() => {
    if (!token) return
    supabase.rpc('invitation_org_info', { p_token: token }).then(({ data }) => {
      const row = Array.isArray(data) ? data[0] : data
      if (row?.org_name) setOrg({ name: row.org_name, logoUrl: row.logo_url ?? null })
    })
  }, [token])

  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Liga el perfil a la organización de la invitación (con el nombre, si se
  // proporciona) y entra al dashboard.
  async function accept(name?: string) {
    const { error: rpcErr } = await supabase.rpc('accept_invitation', {
      p_token: token, p_full_name: name && name.length ? name : null,
    })
    if (rpcErr) { setError(rpcErr.message); setSubmitting(false); return }
    // Recarga completa: AuthProvider vuelve a cargar el perfil ya ligado.
    window.location.replace('/')
  }

  async function acceptWithSession() {
    setSubmitting(true); setError(null)
    await accept()
  }

  async function handleRegister(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (password !== confirm) { setError('Las contraseñas no coinciden.'); return }
    if (password.length < 8) { setError('La contraseña debe tener al menos 8 caracteres.'); return }
    setSubmitting(true)

    const { error: authError } = await supabase.auth.signUp({ email, password })
    if (authError) { setError(authError.message); setSubmitting(false); return }

    // El perfil lo crea la RPC (UPSERT), incluyendo el nombre.
    await accept(fullName.trim())
  }

  // Encabezado: logo de la empresa (prominente) o su nombre, con la atribución
  // "Plataforma GestPlayer" debajo. Sin org conocida → logo GestPlayer.
  function brandHeader() {
    if (org?.logoUrl) {
      return (
        <div style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
          <img src={org.logoUrl} alt={org.name} style={{ maxHeight: '56px', maxWidth: '75%', objectFit: 'contain' }} />
          <div style={{ fontSize: '0.72rem', color: '#94A3B8', marginTop: '0.45rem' }}>Plataforma GestPlayer</div>
        </div>
      )
    }
    if (org?.name) {
      return (
        <div style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
          <div style={{ fontSize: '1.15rem', fontWeight: 800, color: '#0F172A' }}>{org.name}</div>
          <div style={{ fontSize: '0.72rem', color: '#94A3B8', marginTop: '0.25rem' }}>Plataforma GestPlayer</div>
        </div>
      )
    }
    return <div style={s.logoWrap}><img src={logoNegro} alt="GestPlayer" style={{ height: '44px' }} /></div>
  }

  if (loading) {
    return (
      <div style={s.page}><div style={s.card}>
        <div style={{ textAlign: 'center', color: '#94A3B8', fontSize: '0.9rem' }}>Cargando…</div>
      </div></div>
    )
  }

  if (!token) {
    return (
      <div style={s.page}><div style={s.card}>
        <div style={s.logoWrap}><img src={logoNegro} alt="GestPlayer" style={{ height: '44px' }} /></div>
        <div style={s.divider} />
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '2.5rem', marginBottom: '0.75rem' }}>⚠️</div>
          <h2 style={s.heading}>Enlace inválido</h2>
          <p style={s.subheading}>Este enlace de invitación no es válido o está incompleto.</p>
          <a href="/" style={{ ...s.btn, display: 'inline-block', textDecoration: 'none', marginTop: '1.25rem' }}>Ir al inicio</a>
        </div>
      </div></div>
    )
  }

  // Con sesión activa: aceptar directo.
  if (session) {
    return (
      <div style={s.page}><div style={s.card}>
        {brandHeader()}
        <div style={s.divider} />
        <h2 style={s.heading}>Aceptar invitación</h2>
        <p style={s.subheading}>Te unirás a la organización que te invitó con la sesión actual.</p>
        {error && <div style={s.errorBox}>{error}</div>}
        <button onClick={acceptWithSession} disabled={submitting} style={{ ...s.btn, marginTop: '1.5rem', opacity: submitting ? 0.7 : 1 }}>
          {submitting ? 'Aceptando…' : 'Aceptar invitación'}
        </button>
      </div></div>
    )
  }

  // Sin sesión: registro.
  return (
    <div style={s.page}><div style={s.card}>
      {brandHeader()}
      <div style={s.divider} />
      <h2 style={s.heading}>Aceptar invitación</h2>
      <p style={s.subheading}>Crea tu cuenta para unirte a la organización que te invitó</p>

      <form onSubmit={handleRegister} style={{ display: 'flex', flexDirection: 'column', gap: '0.875rem', marginTop: '1.5rem' }}>
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

        {error && <div style={s.errorBox}>{error}</div>}

        <button type="submit" disabled={submitting} style={{ ...s.btn, opacity: submitting ? 0.7 : 1, marginTop: '0.25rem' }}>
          {submitting ? 'Uniéndote…' : 'Crear cuenta y unirme'}
        </button>
      </form>

      <p style={s.loginLink}>
        ¿Ya tienes cuenta?{' '}
        <a href={`/?next=${encodeURIComponent(window.location.pathname + window.location.search)}`} style={{ color: '#2563EB', fontWeight: 600, textDecoration: 'none' }}>Inicia sesión</a>
      </p>
    </div></div>
  )
}

const s: Record<string, React.CSSProperties> = {
  page: { minHeight: '100vh', background: '#F8FAFC', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: "'Inter', system-ui, sans-serif", padding: '1.5rem' },
  card: { background: '#fff', borderRadius: '16px', padding: '2.5rem', width: '100%', maxWidth: '420px', boxShadow: '0 4px 24px rgba(0,0,0,0.08)', border: '1px solid #E2E8F0' },
  logoWrap: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', marginBottom: '1.5rem' },
  divider: { height: '1px', background: '#F1F5F9', marginBottom: '1.5rem' },
  heading: { fontSize: '1.1rem', fontWeight: 700, color: '#0F172A', textAlign: 'center', margin: 0 },
  subheading: { color: '#94A3B8', fontSize: '0.82rem', textAlign: 'center', marginTop: '0.25rem' },
  fieldGroup: { display: 'flex', flexDirection: 'column', gap: '0.35rem' },
  label: { fontSize: '0.8rem', fontWeight: 600, color: '#374151' },
  input: { padding: '0.65rem 0.875rem', borderRadius: '8px', border: '1px solid #E2E8F0', background: '#F8FAFC', color: '#0F172A', fontSize: '0.9rem', outline: 'none' },
  errorBox: { display: 'flex', alignItems: 'center', gap: '0.5rem', background: '#FFF5F5', border: '1px solid #FECACA', borderRadius: '8px', padding: '0.6rem 0.875rem', color: '#EF4444', fontSize: '0.8rem', fontWeight: 500, marginTop: '0.75rem' },
  btn: { padding: '0.7rem', borderRadius: '8px', border: 'none', background: '#2563EB', color: '#fff', fontWeight: 700, fontSize: '0.95rem', cursor: 'pointer', width: '100%', textAlign: 'center' },
  loginLink: { textAlign: 'center', color: '#94A3B8', fontSize: '0.8rem', marginTop: '1.25rem' },
}
