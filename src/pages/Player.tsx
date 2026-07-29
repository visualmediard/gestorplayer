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

const HEARTBEAT_MS = 30_000      // ping "online" cada 30s (igual que Android)
const POLL_MS = 15_000           // poll de publicación/ajustes cada 15s (igual que Android)

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
//  DEVICE LOCKING por SESIÓN: un token solo reproduce en UNA pestaña a la vez.
//  La identidad vive en sessionStorage (única por pestaña, sobrevive a un
//  reload pero NO se comparte entre pestañas ni al cerrar), así dos pestañas
//  del mismo navegador se detectan como sesiones distintas. Sin sessionStorage
//  → '' y el locking se omite (fail-open, igual que Android).
// ─────────────────────────────────────────────────────────────────────────
function getWebSessionId(): string {
  try {
    let id = sessionStorage.getItem('gp_session_id')
    if (!id) {
      id = typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`
      sessionStorage.setItem('gp_session_id', id)
    }
    return id
  } catch { return '' }
}

// Umbral de liveness: si el dueño no refresca last_seen_at en este tiempo, se
// considera muerto (pestaña cerrada / dispositivo reiniciado) y otra sesión
// puede tomar el relevo. El dueño lo refresca en cada poll (15s).
const OWNER_STALE_MS = 90_000

// Ventana operativa con hora LOCAL del dispositivo (paridad con Android). Sin
// start/end → siempre activa. Soporta cruce de medianoche (ej. 06:00 a 02:00).
function isWithinOperatingHours(start: string | null, end: string | null): boolean {
  if (!start || !end) return true
  const now = new Date()
  const cur = now.getHours() * 60 + now.getMinutes()
  const [sh, sm] = start.split(':').map(Number)
  const [eh, em] = end.split(':').map(Number)
  const s = sh * 60 + sm
  const e = eh * 60 + em
  if (s === e) return true
  return s < e ? (cur >= s && cur < e) : (cur >= s || cur < e)
}

export default function Player() {
  const token = new URLSearchParams(window.location.search).get('token') || ''
  const [status, setStatus] = useState<'loading' | 'no-token' | 'invalid' | 'no-program' | 'playing' | 'locked' | 'released'>('loading')
  const [screen, setScreen] = useState<{ id: string; name: string } | null>(null)
  const [programId, setProgramId] = useState<string | null>(null)
  // true solo cuando este navegador confirmó ser el dueño del token (reclamó
  // la pantalla o su huella coincide). Evita desparearse sin ser dueño.
  const claimedRef = useRef(false)
  // Paridad con Android: disparador único de re-sync sin recargar + horario.
  const bootedAtRef = useRef(new Date().toISOString())
  const lastPublishedRef = useRef<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [withinHours, setWithinHours] = useState(true)

  // Fuerza un re-fetch en ScreenStage SOLO si el published_at es nuevo. El poll
  // de 15s y el evento realtime comparan ambos contra esta misma referencia,
  // así que el segundo en llegar con el mismo valor no dispara nada (sin doble
  // carga). La primera lectura solo registra el valor (ScreenStage ya cargó).
  function bumpIfNewPublish(pub: string | null) {
    if (!pub) return
    if (lastPublishedRef.current === null) { lastPublishedRef.current = pub; return }
    if (pub !== lastPublishedRef.current) {
      lastPublishedRef.current = pub
      setReloadKey(k => k + 1)
    }
  }

  async function checkScreen() {
    if (!token) { setStatus('no-token'); return }
    try {
      const { data: sc } = await supabase.from('screens')
        .select('id, name, current_program_id, device_fingerprint, last_seen_at, operating_start, operating_end, operating_hours, reset_requested_at')
        .eq('device_token', token).maybeSingle()
      if (!sc) { setStatus('invalid'); return }

      // ── Device locking por SESIÓN (una pestaña a la vez) ──
      const mySession = getWebSessionId()
      const dbFp = (sc.device_fingerprint ?? null) as string | null
      const lastSeen = (sc as any).last_seen_at as string | null
      const ownerStale = !lastSeen || (Date.now() - new Date(lastSeen).getTime() > OWNER_STALE_MS)
      const claim = async () => {
        const { error } = await supabase.from('screens')
          .update({ device_fingerprint: mySession, last_seen_at: new Date().toISOString() } as any)
          .eq('id', sc.id)
        if (!error) claimedRef.current = true
      }
      if (mySession) {
        if (!claimedRef.current) {
          if (!dbFp || dbFp === mySession) {
            await claim()               // libre, o reload de esta misma pestaña
          } else if (ownerStale) {
            await claim()               // el dueño murió → tomar el relevo
          } else {
            // Otra sesión activa es la dueña → bloqueado.
            setScreen(null); setProgramId(null); setStatus('locked')
            return
          }
        } else if (dbFp !== mySession) {
          // Me superó otra sesión o me liberaron desde el panel → detener.
          claimedRef.current = false
          setScreen(null); setProgramId(null); setStatus('released')
          return
        } else {
          // Sigo siendo dueño → refresco last_seen_at (liveness para el relevo).
          supabase.from('screens').update({ last_seen_at: new Date().toISOString() } as any).eq('id', sc.id)
        }
      }

      setScreen({ id: sc.id, name: sc.name })

      // ── Horario operativo: fuera de horas → pantalla negra (sin stats) ──
      setWithinHours(isWithinOperatingHours((sc as any).operating_start ?? null, (sc as any).operating_end ?? null))

      // ── Reset remoto: fuerza re-sync y limpia el flag (web es anon con
      // permiso de UPDATE en screens). Compara con Date() (no strings ISO). ──
      const resetAt = (sc as any).reset_requested_at as string | null
      if (resetAt && new Date(resetAt) > new Date(bootedAtRef.current)) {
        supabase.from('screens').update({ reset_requested_at: null } as any).eq('id', sc.id)
        setReloadKey(k => k + 1)
      }

      if (!sc.current_program_id) { setProgramId(null); setStatus('no-program'); return }
      setProgramId(sc.current_program_id)   // mismo valor → ScreenStage no recarga por programId
      setStatus('playing')

      // ── Detección de nueva publicación (published_at, fallback updated_at) ──
      const { data: prog } = await supabase.from('programs')
        .select('published_at, updated_at').eq('id', sc.current_program_id).maybeSingle()
      if (prog) bumpIfNewPublish(((prog as any).published_at ?? (prog as any).updated_at) ?? null)
    } catch { /* offline: se reintenta en el próximo ciclo de 15s */ }
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
    // Al reconectar: envía el lote Y re-chequea publicación/ajustes al instante
    // (paridad con Android, que re-sincroniza contenido al volver online).
    const onOnline = () => { flushBatch(); checkScreen() }
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
    const pl = setInterval(checkScreen, POLL_MS)
    return () => { clearInterval(hb); clearInterval(pl) }
  }, [screen?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // Realtime: reacciona al instante a una nueva publicación del programa.
  // Compara contra lastPublishedRef igual que el poll → nunca doble carga.
  useEffect(() => {
    if (!programId) return
    const ch = supabase.channel('web-player-' + programId)
      .on('postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'programs', filter: 'id=eq.' + programId },
        (payload) => {
          const np = (((payload.new as any)?.published_at) ?? ((payload.new as any)?.updated_at)) ?? null
          bumpIfNewPublish(np)
        })
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [programId]) // eslint-disable-line react-hooks/exhaustive-deps

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
      {withinHours && programId && <ScreenStage client={supabase} programId={programId} reloadKey={reloadKey} onPlay={logPlay} />}
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
