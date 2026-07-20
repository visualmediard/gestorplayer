import { useEffect, useState } from 'react'
import { createClient } from '@supabase/supabase-js'
import ScreenStage from '../components/ScreenStage'

// Dedicated anonymous client: a screen is never "logged in", and even when an
// admin previews /play in the same browser we must write as anon so RLS lets
// heartbeats and playback_events through. persistSession:false ignores any
// stored admin session.
const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } }
)

const HEARTBEAT_MS = 30_000      // ping "online" every 30s
const RELOAD_MS = 60_000         // re-check the assigned program every 60s

export default function Player() {
  const token = new URLSearchParams(window.location.search).get('token') || ''
  const [status, setStatus] = useState<'loading' | 'no-token' | 'invalid' | 'no-program' | 'playing'>('loading')
  const [screen, setScreen] = useState<{ id: string; name: string } | null>(null)
  const [programId, setProgramId] = useState<string | null>(null)

  async function checkScreen() {
    if (!token) { setStatus('no-token'); return }
    const { data: sc } = await supabase.from('screens')
      .select('id, name, current_program_id').eq('device_token', token).maybeSingle()
    if (!sc) { setStatus('invalid'); return }
    setScreen({ id: sc.id, name: sc.name })
    if (!sc.current_program_id) { setProgramId(null); setStatus('no-program'); return }
    setProgramId(sc.current_program_id)   // same value → ScreenStage won't reload
    setStatus('playing')
  }

  // Fire-and-forget: record a play.
  function logPlay(contentId: string, zoneId: string) {
    if (!screen) return
    supabase.from('playback_events').insert({
      screen_id: screen.id, content_id: contentId, zone_id: zoneId, played_at: new Date().toISOString(),
    }).then(() => {}, () => {})
  }

  async function heartbeat() {
    if (!screen) return
    await supabase.from('screens').update({ last_heartbeat: new Date().toISOString() } as any).eq('id', screen.id)
  }

  useEffect(() => { checkScreen() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!screen) return
    heartbeat()
    const hb = setInterval(heartbeat, HEARTBEAT_MS)
    const rl = setInterval(checkScreen, RELOAD_MS)
    return () => { clearInterval(hb); clearInterval(rl) }
  }, [screen?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  if (status === 'loading') return <Center><Spinner /><p style={msg}>Conectando…</p></Center>
  if (status === 'no-token') return <Center>
    <h1 style={title}>Reproductor GestPlayer</h1>
    <p style={msg}>Falta el token de la pantalla en la URL.</p>
    <p style={{ ...msg, opacity: 0.7 }}>Usa: <code style={code}>/play?token=TU_TOKEN</code></p>
    <p style={{ ...msg, opacity: 0.7 }}>Copia el token desde <b>Pantallas</b> en el panel.</p>
  </Center>
  if (status === 'invalid') return <Center>
    <div style={{ fontSize: '3rem' }}>❌</div>
    <h1 style={title}>Token inválido</h1>
    <p style={msg}>No hay ninguna pantalla con ese token.</p>
  </Center>
  if (status === 'no-program') return <Center>
    <div style={{ fontSize: '3rem' }}>📺</div>
    <h1 style={title}>{screen?.name ?? 'Pantalla'}</h1>
    <p style={msg}>Sin programa asignado. Asígnale uno desde <b>Pantallas</b>.</p>
    <p style={{ ...msg, opacity: 0.6, fontSize: '0.8rem' }}>Se conectará automáticamente cuando lo asignes.</p>
  </Center>

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#000', cursor: 'none' }}>
      {programId && <ScreenStage client={supabase} programId={programId} onPlay={logPlay} />}
    </div>
  )
}

// ── Small presentational helpers ──
function Center({ children }: { children: React.ReactNode }) {
  return <div style={{ position: 'fixed', inset: 0, background: '#0B1120', color: '#fff', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', textAlign: 'center', padding: '1.5rem', fontFamily: 'system-ui, sans-serif' }}>{children}</div>
}
function Spinner() {
  return <div style={{ width: 34, height: 34, border: '3px solid rgba(255,255,255,0.15)', borderTop: '3px solid #3B82F6', borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
}
const title: React.CSSProperties = { fontSize: '1.4rem', fontWeight: 700, margin: '0.5rem 0 0' }
const msg: React.CSSProperties = { color: '#CBD5E1', fontSize: '0.95rem', margin: 0 }
const code: React.CSSProperties = { background: 'rgba(255,255,255,0.1)', padding: '2px 6px', borderRadius: 4, fontFamily: 'monospace' }
