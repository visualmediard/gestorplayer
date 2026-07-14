import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

type Screen = { id: string; name: string; location: string | null; device_token: string | null }

export default function Pair() {
  const code = new URLSearchParams(window.location.search).get('code') || ''
  const [screens, setScreens]   = useState<Screen[]>([])
  const [loading, setLoading]   = useState(true)
  const [saving, setSaving]     = useState<string | null>(null)
  const [done, setDone]         = useState(false)
  const [error, setError]       = useState<string | null>(null)
  const [invalid, setInvalid]   = useState(false)

  useEffect(() => {
    if (!code) { setInvalid(true); setLoading(false); return }

    // Verificar que el código existe en device_pairings
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
    const { error: e } = await supabase
      .from('device_pairings')
      .update({ token })
      .eq('code', code)
    if (e) { setError(e.message); setSaving(null); return }
    setDone(true)
  }

  if (loading) return (
    <div style={wrapStyle}>
      <Logo />
      <div style={cardStyle}>
        <div style={spinnerStyle} />
        <p style={{ color: '#64748B', marginTop: '1rem' }}>Verificando código...</p>
      </div>
    </div>
  )

  if (invalid) return (
    <div style={wrapStyle}>
      <Logo />
      <div style={cardStyle}>
        <div style={{ fontSize: '2.5rem', marginBottom: '0.75rem' }}>❌</div>
        <h2 style={titleStyle}>Código inválido</h2>
        <p style={subStyle}>Este código QR no existe o expiró. Genera uno nuevo desde el player.</p>
      </div>
    </div>
  )

  if (done) return (
    <div style={wrapStyle}>
      <Logo />
      <div style={cardStyle}>
        <div style={{ fontSize: '2.5rem', marginBottom: '0.75rem' }}>✅</div>
        <h2 style={titleStyle}>¡Pantalla conectada!</h2>
        <p style={subStyle}>El reproductor arrancará automáticamente en unos segundos.</p>
        <p style={{ color: '#94A3B8', fontSize: '0.78rem', marginTop: '1.5rem' }}>Puedes cerrar esta página.</p>
      </div>
    </div>
  )

  return (
    <div style={wrapStyle}>
      <Logo />
      <div style={{ ...cardStyle, maxWidth: '440px', width: '100%' }}>
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
