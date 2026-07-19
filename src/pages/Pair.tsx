import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../auth/AuthContext'

// La página /pair sirve dos flujos:
//
//   /pair?token=XXXX  → NUEVO. QR por pantalla generado en el dashboard.
//                       Exige login y vincula la pantalla a la organización
//                       del usuario tras confirmar.
//
//   /pair?code=XXXX   → LEGACY. Vinculación auto-generada por el player HTML
//                       (device_pairings): el usuario elige de una lista.
//
export default function Pair() {
  const params = new URLSearchParams(window.location.search)
  const token = params.get('token') || ''
  const code = params.get('code') || ''

  if (token) return <PairByToken token={token} />
  return <PairByCode code={code} />
}

/* ══════════════════════════════════════════════════════════════════
   NUEVO — vinculación por token con login + confirmación de org
   ══════════════════════════════════════════════════════════════════ */

type ScreenRow = { id: string; name: string; location: string | null; organization_id: string | null }
type Phase = 'loading' | 'invalid' | 'confirm' | 'linking' | 'wrong-org' | 'error' | 'done'

function PairByToken({ token }: { token: string }) {
  const { session, loading: authLoading } = useAuth()
  const [phase, setPhase] = useState<Phase>('loading')
  const [screen, setScreen] = useState<ScreenRow | null>(null)
  const [orgName, setOrgName] = useState('tu organización')
  const [userOrgId, setUserOrgId] = useState<string | null>(null)
  const [errMsg, setErrMsg] = useState('')

  useEffect(() => {
    if (authLoading) return

    // Sin sesión → guardar destino y mandar a login; al autenticarse, el Gate
    // devuelve al usuario a este mismo enlace.
    if (!session) {
      localStorage.setItem('post_login_redirect', '/pair?token=' + encodeURIComponent(token))
      window.location.replace('/')
      return
    }

    let cancelled = false
    ;(async () => {
      const { data: sc } = await supabase
        .from('screens')
        .select('id, name, location, organization_id')
        .eq('device_token', token)
        .maybeSingle()
      if (cancelled) return
      if (!sc) { setPhase('invalid'); return }
      setScreen(sc as ScreenRow)

      const { data: prof } = await supabase
        .from('profiles').select('organization_id').eq('id', session.user.id).single()
      const oid = prof?.organization_id ?? null
      setUserOrgId(oid)
      if (oid) {
        const { data: org } = await supabase.from('organizations').select('name').eq('id', oid).single()
        if (org?.name) setOrgName(org.name)
      }
      if (!cancelled) setPhase('confirm')
    })()

    return () => { cancelled = true }
  }, [authLoading, session, token])

  async function confirmLink() {
    if (!screen) return
    setPhase('linking')

    // Ya pertenece a otra organización → no se puede vincular.
    if (screen.organization_id && screen.organization_id !== userOrgId) {
      setPhase('wrong-org')
      return
    }

    // Sin dueño → reclamar para la organización del usuario.
    if (!screen.organization_id) {
      const { error } = await supabase
        .from('screens').update({ organization_id: userOrgId }).eq('id', screen.id)
      if (error) { setErrMsg(error.message); setPhase('error'); return }
    }

    // Pertenece (o ya reclamada) → abrir el reproductor.
    setPhase('done')
    setTimeout(() => {
      window.location.replace('/player?token=' + encodeURIComponent(token))
    }, 1200)
  }

  if (phase === 'loading') return (
    <Shell><div style={spinnerStyle} /><p style={{ color: '#64748B', marginTop: '1rem' }}>Cargando…</p></Shell>
  )

  if (phase === 'invalid') return (
    <Shell>
      <div style={{ fontSize: '2.5rem', marginBottom: '0.75rem' }}>❌</div>
      <h2 style={titleStyle}>Token no encontrado</h2>
      <p style={subStyle}>Esta pantalla no existe o no pertenece a tu organización.</p>
    </Shell>
  )

  if (phase === 'wrong-org') return (
    <Shell>
      <div style={{ fontSize: '2.5rem', marginBottom: '0.75rem' }}>🚫</div>
      <h2 style={titleStyle}>Sin acceso</h2>
      <p style={subStyle}>Este token no pertenece a tu organización.</p>
    </Shell>
  )

  if (phase === 'error') return (
    <Shell>
      <div style={{ fontSize: '2.5rem', marginBottom: '0.75rem' }}>⚠️</div>
      <h2 style={titleStyle}>No se pudo vincular</h2>
      <p style={subStyle}>{errMsg || 'Ocurrió un error. Intenta de nuevo.'}</p>
    </Shell>
  )

  if (phase === 'done') return (
    <Shell>
      <div style={{ fontSize: '2.5rem', marginBottom: '0.75rem' }}>✅</div>
      <h2 style={titleStyle}>¡Pantalla vinculada!</h2>
      <p style={subStyle}>Abriendo el reproductor…</p>
    </Shell>
  )

  // confirm / linking
  return (
    <Shell>
      <div style={{ width: '56px', height: '56px', borderRadius: '14px', background: '#EFF6FF', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 1rem' }}>
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#2563EB" strokeWidth="2"><rect x="2" y="3" width="20" height="14" rx="2" /><line x1="8" y1="21" x2="16" y2="21" /><line x1="12" y1="17" x2="12" y2="21" /></svg>
      </div>
      <h2 style={titleStyle}>Vincular pantalla</h2>
      <p style={{ ...subStyle, marginBottom: '0.25rem' }}>
        <b style={{ color: '#0F172A' }}>{screen?.name}</b>{screen?.location ? ` · ${screen.location}` : ''}
      </p>
      <p style={subStyle}>¿Vincular esta pantalla a <b style={{ color: '#2563EB' }}>{orgName}</b>?</p>

      <div style={{ display: 'flex', gap: '0.6rem', marginTop: '1.5rem', width: '100%' }}>
        <button
          onClick={() => window.close()}
          disabled={phase === 'linking'}
          style={{ flex: 1, padding: '0.75rem', borderRadius: '10px', border: '1px solid #E2E8F0', background: '#fff', color: '#64748B', fontWeight: 600, fontSize: '0.9rem', cursor: 'pointer' }}
        >Cancelar</button>
        <button
          onClick={confirmLink}
          disabled={phase === 'linking'}
          style={{ flex: 1, padding: '0.75rem', borderRadius: '10px', border: 'none', background: '#2563EB', color: '#fff', fontWeight: 700, fontSize: '0.9rem', cursor: 'pointer', opacity: phase === 'linking' ? 0.6 : 1 }}
        >{phase === 'linking' ? 'Vinculando…' : 'Confirmar'}</button>
      </div>
    </Shell>
  )
}

/* ══════════════════════════════════════════════════════════════════
   LEGACY — vinculación por código (player HTML / device_pairings)
   ══════════════════════════════════════════════════════════════════ */

type Screen = { id: string; name: string; location: string | null; device_token: string | null }

function PairByCode({ code }: { code: string }) {
  const [screens, setScreens] = useState<Screen[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [invalid, setInvalid] = useState(false)

  useEffect(() => {
    if (!code) { setInvalid(true); setLoading(false); return }

    supabase.from('device_pairings').select('code').eq('code', code).single()
      .then(({ error: e }) => {
        if (e) setInvalid(true)
        return supabase.from('screens').select('id, name, location, device_token').order('name')
      })
      .then(({ data }) => { setScreens(data || []); setLoading(false) })
  }, [code])

  async function pair(token: string, screenName: string) {
    if (!token) return
    setSaving(screenName)
    const { error: e } = await supabase.from('device_pairings').update({ token }).eq('code', code)
    if (e) { setError(e.message); setSaving(null); return }
    setDone(true)
  }

  if (loading) return (
    <Shell><div style={spinnerStyle} /><p style={{ color: '#64748B', marginTop: '1rem' }}>Verificando código...</p></Shell>
  )

  if (invalid) return (
    <Shell>
      <div style={{ fontSize: '2.5rem', marginBottom: '0.75rem' }}>❌</div>
      <h2 style={titleStyle}>Código inválido</h2>
      <p style={subStyle}>Este código QR no existe o expiró. Genera uno nuevo desde el player.</p>
    </Shell>
  )

  if (done) return (
    <Shell>
      <div style={{ fontSize: '2.5rem', marginBottom: '0.75rem' }}>✅</div>
      <h2 style={titleStyle}>¡Pantalla conectada!</h2>
      <p style={subStyle}>El reproductor arrancará automáticamente en unos segundos.</p>
      <p style={{ color: '#94A3B8', fontSize: '0.78rem', marginTop: '1.5rem' }}>Puedes cerrar esta página.</p>
    </Shell>
  )

  return (
    <Shell wide>
      <div style={{ background: '#EFF6FF', borderRadius: '8px', padding: '0.6rem 1rem', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <span style={{ fontFamily: 'monospace', fontWeight: 700, fontSize: '1.1rem', color: '#2563EB', letterSpacing: '0.15em' }}>{code}</span>
        <span style={{ color: '#64748B', fontSize: '0.8rem' }}>— selecciona la pantalla a conectar</span>
      </div>

      <h2 style={{ ...titleStyle, marginBottom: '1rem' }}>Elige la pantalla</h2>

      {error && (
        <div style={{ background: '#FFF5F5', border: '1px solid #FECACA', borderRadius: '8px', padding: '0.75rem', color: '#EF4444', fontSize: '0.85rem', marginBottom: '1rem' }}>
          {error}
        </div>
      )}

      {screens.length === 0 ? (
        <p style={subStyle}>No hay pantallas registradas. Créalas en el dashboard.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
          {screens.map(s => (
            <button
              key={s.id}
              onClick={() => pair(s.device_token || '', s.name)}
              disabled={saving !== null || !s.device_token}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '0.85rem 1rem', borderRadius: '10px', cursor: s.device_token ? 'pointer' : 'default',
                border: '1px solid #E2E8F0', background: saving === s.name ? '#EFF6FF' : '#F8FAFC',
                opacity: !s.device_token ? 0.45 : 1, transition: 'background 0.15s',
                width: '100%', textAlign: 'left',
              }}
            >
              <div>
                <div style={{ fontWeight: 600, color: '#0F172A', fontSize: '0.95rem' }}>{s.name}</div>
                {s.location && <div style={{ color: '#94A3B8', fontSize: '0.78rem', marginTop: '2px' }}>{s.location}</div>}
                {!s.device_token && <div style={{ color: '#F59E0B', fontSize: '0.75rem', marginTop: '2px' }}>Sin token asignado</div>}
              </div>
              {saving === s.name
                ? <div style={{ ...spinnerStyle, width: '18px', height: '18px', borderWidth: '2px' }} />
                : s.device_token
                  ? <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#3B82F6" strokeWidth="2.5"><polyline points="9 18 15 12 9 6" /></svg>
                  : null
              }
            </button>
          ))}
        </div>
      )}
    </Shell>
  )
}

/* ── Presentación compartida ── */

function Shell({ children, wide }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <div style={wrapStyle}>
      <Logo />
      <div style={{ ...cardStyle, maxWidth: wide ? '440px' : '380px', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        {children}
      </div>
    </div>
  )
}

function Logo() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1.75rem' }}>
      <div style={{ width: '36px', height: '36px', background: '#3B82F6', borderRadius: '10px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="white"><polygon points="5,3 19,12 5,21" /></svg>
      </div>
      <span style={{ fontWeight: 800, fontSize: '1.2rem', color: '#0F172A' }}>GestorPlayer</span>
    </div>
  )
}

const wrapStyle: React.CSSProperties = {
  minHeight: '100vh', background: '#F8FAFC',
  display: 'flex', flexDirection: 'column', alignItems: 'center',
  justifyContent: 'center', padding: '1.5rem', fontFamily: 'system-ui, -apple-system, sans-serif',
}
const cardStyle: React.CSSProperties = {
  background: '#fff', border: '1px solid #E2E8F0', borderRadius: '16px',
  padding: '2rem', textAlign: 'center',
  boxShadow: '0 4px 24px rgba(0,0,0,0.07)', width: '100%',
}
const titleStyle: React.CSSProperties = { fontSize: '1.15rem', fontWeight: 700, color: '#0F172A', margin: 0 }
const subStyle: React.CSSProperties = { color: '#94A3B8', fontSize: '0.88rem', margin: '0.5rem 0 0' }
const spinnerStyle: React.CSSProperties = {
  width: '28px', height: '28px', border: '3px solid #E2E8F0',
  borderTop: '3px solid #3B82F6', borderRadius: '50%',
  animation: 'spin 1s linear infinite', margin: '0 auto',
}
