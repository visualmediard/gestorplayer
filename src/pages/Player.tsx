import { useEffect, useRef, useState } from 'react'
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

// ─────────────────────────────────────────────────────────────────────────
//  BATCHING DE REPRODUCCIONES — misma lógica que player/index.html:
//  en vez de un INSERT por reproducción, se acumulan en memoria (agrupadas
//  por content|zone con un contador) y se envían en UN solo INSERT cada
//  10 minutos, al volver online o al ocultar la pestaña. El lote se espeja
//  en localStorage (escritura síncrona, fiable en beforeunload) para no
//  perder nada al cerrar. Requiere playback_events.count (migración 20260721).
// ─────────────────────────────────────────────────────────────────────────

const FLUSH_INTERVAL_MS = 10 * 60 * 1000
const BATCH_STORAGE_KEY = 'gp_pending_batch'

type BatchRow = { screen_id: string; zone_id: string; content_id: string; played_at: string; count: number }

// Estado a nivel de módulo: sobrevive re-renders y no depende del ciclo React.
const batchMap = new Map<string, BatchRow>()
let batchSaveTimer: ReturnType<typeof setTimeout> | null = null
let flushingNow = false

function addToBatch(evt: Omit<BatchRow, 'count'>) {
  const key = evt.content_id + '|' + evt.zone_id
  const row = batchMap.get(key)
  if (row) {
    row.count += 1
    row.played_at = evt.played_at   // se conserva la última reproducción
  } else {
    batchMap.set(key, { ...evt, count: 1 })
  }
  persistBatchDebounced()
}

// Espejo local del lote (debounce 2s). localStorage es síncrono: la escritura
// en beforeunload queda garantizada, a diferencia de IndexedDB.
function persistBatchNow() {
  try {
    localStorage.setItem(BATCH_STORAGE_KEY, JSON.stringify([...batchMap.values()]))
  } catch { /* storage lleno/bloqueado: el lote sigue en memoria */ }
}

function persistBatchDebounced() {
  if (batchSaveTimer) return
  batchSaveTimer = setTimeout(() => { batchSaveTimer = null; persistBatchNow() }, 2000)
}

// Envía todo el lote en UN solo INSERT. Si falla, se conserva intacto y se
// reintenta en el próximo ciclo / evento online.
async function flushBatch() {
  if (flushingNow || !navigator.onLine || batchMap.size === 0) return
  flushingNow = true
  const payload = [...batchMap.values()].map(r => ({ ...r }))
  try {
    const { error } = await supabase.from('playback_events').insert(payload)
    if (!error) {
      // Descuenta solo lo enviado; lo reproducido DURANTE el envío queda
      // para el próximo lote (no se pierde ni se duplica).
      for (const p of payload) {
        const key = p.content_id + '|' + p.zone_id
        const row = batchMap.get(key)
        if (!row) continue
        if (row.count <= p.count) batchMap.delete(key)
        else row.count -= p.count
      }
      persistBatchNow()
    }
  } catch { /* red caída: el lote se conserva */ }
  flushingNow = false
}

// Al arrancar: recupera el lote persistido del cierre anterior. Las filas
// llevan su propio screen_id, así que restaurar es seguro aunque la pestaña
// se abra ahora con otro token.
function restorePendingBatch() {
  try {
    const raw = localStorage.getItem(BATCH_STORAGE_KEY)
    if (!raw) return
    for (const r of JSON.parse(raw) as BatchRow[]) {
      const key = r.content_id + '|' + r.zone_id
      const ex = batchMap.get(key)
      if (ex) {
        ex.count += r.count || 1
        if ((r.played_at || '') > (ex.played_at || '')) ex.played_at = r.played_at
      } else {
        batchMap.set(key, { ...r, count: r.count || 1 })
      }
    }
  } catch {
    // JSON corrupto: se descarta para no bloquear arranques futuros.
    try { localStorage.removeItem(BATCH_STORAGE_KEY) } catch { /* noop */ }
  }
}

// Solo en desarrollo: expone el batching para pruebas en consola.
if (import.meta.env.DEV) {
  ;(window as unknown as Record<string, unknown>).__gpBatch =
    { batchMap, addToBatch, flushBatch, restorePendingBatch, persistBatchNow }
}

// ─────────────────────────────────────────────────────────────────────────
//  DEVICE LOCKING (paridad con el player Android): un token solo reproduce
//  en el equipo que lo reclamó primero. La identidad del navegador es un
//  id estable en localStorage. Si localStorage no está disponible, se
//  devuelve '' y el locking se omite (fail-open, igual que Android).
// ─────────────────────────────────────────────────────────────────────────
function getWebDeviceId(): string {
  try {
    let id = localStorage.getItem('gp_device_id')
    if (!id) {
      id = typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`
      localStorage.setItem('gp_device_id', id)
    }
    return id
  } catch { return '' }
}

export default function Player() {
  const token = new URLSearchParams(window.location.search).get('token') || ''
  const [status, setStatus] = useState<'loading' | 'no-token' | 'invalid' | 'no-program' | 'playing' | 'locked' | 'released'>('loading')
  const [screen, setScreen] = useState<{ id: string; name: string } | null>(null)
  const [programId, setProgramId] = useState<string | null>(null)
  // true solo cuando este navegador confirmó ser el dueño del token (reclamó
  // la pantalla o su huella coincide). Evita desparearse sin ser dueño.
  const claimedRef = useRef(false)

  async function checkScreen() {
    if (!token) { setStatus('no-token'); return }
    const { data: sc } = await supabase.from('screens')
      .select('id, name, current_program_id, device_fingerprint').eq('device_token', token).maybeSingle()
    if (!sc) { setStatus('invalid'); return }

    // ── Device locking: se evalúa ANTES de arrancar reproducción ──
    // El check corre dentro de checkScreen (cada 60s, consulta que YA
    // existía — cero requests periódicos nuevos).
    const myId = getWebDeviceId()
    const dbFp = (sc.device_fingerprint ?? null) as string | null
    if (myId) {
      if (!claimedRef.current) {
        if (dbFp && dbFp !== myId) {
          // Otro equipo es el dueño → bloqueado (no reproducir, no insistir).
          setScreen(null); setProgramId(null); setStatus('locked')
          return
        }
        if (!dbFp) {
          // Pantalla libre → reclamarla (única request extra, solo una vez).
          const { error } = await supabase.from('screens')
            .update({ device_fingerprint: myId, last_seen_at: new Date().toISOString() } as any)
            .eq('id', sc.id)
          if (!error) claimedRef.current = true
          // Con error: fail-open — reproduce sin lock; se reintenta luego.
        } else {
          claimedRef.current = true   // dbFp === myId: mismo navegador
        }
      } else if (dbFp !== myId) {
        // Éramos dueños y ya no (liberada desde el panel u otro equipo la
        // reclamó) → detener y pedir re-vinculación.
        claimedRef.current = false
        setScreen(null); setProgramId(null); setStatus('released')
        return
      }
    }

    setScreen({ id: sc.id, name: sc.name })
    if (!sc.current_program_id) { setProgramId(null); setStatus('no-program'); return }
    setProgramId(sc.current_program_id)   // same value → ScreenStage won't reload
    setStatus('playing')
  }

  // Batching: acumula en memoria (espejo en localStorage) — el envío real
  // ocurre en lotes cada 10 min / al volver online / al ocultar la pestaña.
  function logPlay(contentId: string, zoneId: string) {
    if (!screen) return
    addToBatch({
      screen_id: screen.id, zone_id: zoneId, content_id: contentId,
      played_at: new Date().toISOString(),
    })
  }

  async function heartbeat() {
    if (!screen) return
    await supabase.from('screens').update({ last_heartbeat: new Date().toISOString() } as any).eq('id', screen.id)
  }

  useEffect(() => { checkScreen() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Ciclo de vida del batching: restaurar pendientes + flush inicial,
  // intervalo de 10 min (único intervalo de red nuevo), flush al volver
  // online y al ocultar la pestaña, persistencia síncrona al cerrar.
  useEffect(() => {
    restorePendingBatch()
    flushBatch()
    const iv = setInterval(flushBatch, FLUSH_INTERVAL_MS)
    const onOnline = () => { flushBatch() }
    const onVis = () => {
      if (document.visibilityState === 'hidden') { persistBatchNow(); flushBatch() }
    }
    const onUnload = () => { persistBatchNow() }
    window.addEventListener('online', onOnline)
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('beforeunload', onUnload)
    return () => {
      clearInterval(iv)
      window.removeEventListener('online', onOnline)
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('beforeunload', onUnload)
      persistBatchNow()
    }
  }, [])

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
  if (status === 'locked') return <Center>
    <div style={{ fontSize: '3rem' }}>🔒</div>
    <h1 style={title}>Este token ya está activo en otro dispositivo.</h1>
    <p style={msg}>Contacta a tu administrador para liberar el acceso.</p>
  </Center>
  if (status === 'released') return <Center>
    <div style={{ fontSize: '3rem' }}>🔓</div>
    <h1 style={title}>Pantalla liberada</h1>
    <p style={msg}>Esta pantalla fue liberada desde el panel de administración.</p>
    <button onClick={() => window.location.reload()} style={btnRelink}>Volver a vincular</button>
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
const btnRelink: React.CSSProperties = { marginTop: '1rem', padding: '0.65rem 1.4rem', borderRadius: 8, border: 'none', background: '#3B82F6', color: '#fff', fontWeight: 600, fontSize: '0.95rem', cursor: 'pointer' }
