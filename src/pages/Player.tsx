import { useEffect, useRef, useState } from 'react'
import { createClient } from '@supabase/supabase-js'
import QRCode from 'qrcode'
import ScreenStage, { type PlayerPayload } from '../components/ScreenStage'
import logoNegro from '../assets/logo/logo-negro.png'

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
// Cuándo reclamó esta pantalla. En localStorage y no en memoria a propósito:
// tiene que sobrevivir a un reinicio para que el servidor pueda decir "te
// liberaron mientras estabas apagado".
const CLAIM_AT_KEY = 'gp_claimed_at'

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
  const tok = readStoredToken()
  if (!tok) return          // sin token no hay a qué organización atribuirlos
  flushingNow = true
  const payload = [...batchMap.values()].map(r => ({ ...r }))
  try {
    // Vía RPC: el token acota a qué organización se puede escribir. Con el
    // INSERT directo, cualquier anónimo podía falsear estadísticas ajenas.
    const { error } = await supabase.rpc('player_log_events', { p_token: tok, p_events: payload })
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

// El umbral de liveness (90 s) vive ahora dentro de get_player_payload: quién
// es el dueño lo decide el servidor, no el cliente.

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

// Clave de token persistido: un TV ya vinculado que reinicie y abra /play (sin
// token en la URL) retoma solo, sin re-vincular.
const TOKEN_STORAGE_KEY = 'gp_device_token'
function readStoredToken(): string { try { return localStorage.getItem(TOKEN_STORAGE_KEY) || '' } catch { return '' } }
// Momento del último claim. null si nunca reclamó: el servidor lo trata como
// "anterior a cualquier liberación", que es lo correcto para un dispositivo
// que aún no tenía asignada esta pantalla.
function readClaimedAt(): string | null { try { return localStorage.getItem(CLAIM_AT_KEY) } catch { return null } }

// Versión del bundle, enviada en cada heartbeat. Permite comprobar, antes de
// cerrar las tablas al player anónimo (fase 5), que no queda ninguna pantalla
// con la versión vieja — en Android el bundle va congelado dentro del APK.
const APP_VERSION = 'web-2026.08.10'

export default function Player() {
  const urlToken = new URLSearchParams(window.location.search).get('token') || ''
  const [token, setToken] = useState(() => urlToken || readStoredToken())
  // Ya no hay estado 'released': una liberación borra el token y devuelve al
  // QR directamente, para poder instalar la pantalla en otro sitio.
  const [status, setStatus] = useState<'loading' | 'no-token' | 'no-program' | 'playing' | 'locked'>('loading')
  // Vinculación por QR (cuando no hay token).
  const [pairCode, setPairCode] = useState('')
  const [qrDataUrl, setQrDataUrl] = useState('')
  const [pairError, setPairError] = useState<string | null>(null)
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
  // Contenido resuelto por get_player_payload; se lo pasamos a ScreenStage.
  const [payload, setPayload] = useState<PlayerPayload | null>(null)

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
      // Acuse inmediato. Aplicar la publicación es cuestión de un segundo --la
      // suscripción en tiempo real la trae al instante-- pero sin esto el panel
      // no se entera hasta el siguiente latido, hasta 30 s después, y el
      // usuario ve "Sincronizando…" mucho despues de que la pantalla ya esté
      // mostrando el anuncio nuevo. El retraso era del mensajero, no del envío.
      heartbeat()
    }
  }

  async function checkScreen() {
    if (!token) { setStatus('no-token'); return }
    try {
      // Una sola llamada: pantalla + programa + zonas + media. El bloqueo por
      // sesión lo resuelve el servidor (antes lo decidía el cliente sobre
      // columnas que cualquier anónimo podía escribir).
      const mySession = getWebSessionId()
      const { data, error } = await supabase.rpc('get_player_payload', {
        p_token: token,
        p_session: mySession || null,
        p_had_claim: claimedRef.current,
        p_claimed_at: readClaimedAt(),
      })
      if (error) return                      // red/servidor: reintento en 15s
      const res = data as (PlayerPayload & { status: string; screen: any }) | null
      if (!res) return

      // Token inválido (borrado del panel) o pantalla liberada: en ambos casos
      // este dispositivo deja de estar asignado, así que se olvida el token y
      // se vuelve al QR para poder instalarlo en otro sitio.
      if (res.status === 'invalid' || res.status === 'released') {
        claimedRef.current = false
        try {
          localStorage.removeItem(TOKEN_STORAGE_KEY)
          localStorage.removeItem(CLAIM_AT_KEY)
        } catch { /* noop */ }
        setScreen(null); setProgramId(null); setPayload(null)
        setToken('')
        return
      }

      // 'taken' = otra sesión se quedó con la pantalla; 'locked' = nunca fuimos
      // dueños. En ninguno de los dos se borra el token: no estamos liberados,
      // solo desplazados, y podemos recuperar el turno si la otra sesión muere.
      if (res.status === 'taken' || res.status === 'locked') {
        claimedRef.current = false
        setScreen(null); setProgramId(null); setPayload(null)
        setStatus('locked')
        return
      }

      // Primera vez que somos dueños: se anota cuándo, para que una liberación
      // futura sea detectable aunque el equipo se reinicie.
      if (!claimedRef.current) {
        try { localStorage.setItem(CLAIM_AT_KEY, new Date().toISOString()) } catch { /* noop */ }
      }
      claimedRef.current = true
      const sc = res.screen
      setScreen({ id: sc.id, name: sc.name })

      // ── Horario operativo: fuera de horas → pantalla negra (sin stats) ──
      setWithinHours(isWithinOperatingHours(sc.operating_start ?? null, sc.operating_end ?? null))

      // ── Reset remoto: fuerza re-sync y limpia el flag vía RPC. Compara con
      // Date() (no strings ISO). ──
      const resetAt = sc.reset_requested_at as string | null
      if (resetAt && new Date(resetAt) > new Date(bootedAtRef.current)) {
        supabase.rpc('player_ack_reset', { p_token: token })
        setReloadKey(k => k + 1)
      }

      if (!sc.current_program_id) {
        setProgramId(null); setPayload(null); setStatus('no-program'); return
      }
      setProgramId(sc.current_program_id)   // mismo valor → ScreenStage no recarga por programId
      setPayload({ program: res.program ?? null, zones: res.zones ?? [] })
      setStatus('playing')

      // ── Detección de nueva publicación (published_at, fallback updated_at) ──
      const prog = res.program as any
      if (prog) bumpIfNewPublish((prog.published_at ?? prog.updated_at) ?? null)
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
    if (!screen || !token) return
    // app_version viaja aquí para poder comprobar, antes de cerrar las tablas
    // (fase 5), que ninguna pantalla sigue con el bundle viejo.
    //
    // p_synced_published_at es el acuse de recibo de la publicación: le dice al
    // panel QUÉ versión tiene aplicada esta pantalla, para que pueda distinguir
    // "sincronizada" de "esperando conexión" sin adivinarlo. Viaja dentro del
    // latido y no en una llamada aparte: si llega uno, llega el otro.
    //
    // Se manda lastPublishedRef, que es el valor que bumpIfNewPublish dio por
    // aplicado. Entre que se marca y que ScreenStage termina de recargar pasan
    // milisegundos, y el latido es cada 30 s, así que en la práctica el acuse
    // siempre va por detrás de la recarga real. Mientras el player no haya
    // leído todavía ninguna publicación va NULL, que el panel interpreta como
    // "desconocido" y nunca como "desincronizada".
    await supabase.rpc('player_heartbeat', {
      p_token: token,
      p_app_version: APP_VERSION,
      p_synced_published_at: lastPublishedRef.current,
    })
  }

  // Re-chequea al montar y cada vez que el token cambia (p. ej. tras vincular
  // por QR: setToken → arranca la reproducción sin recargar la página).
  useEffect(() => { checkScreen() }, [token]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Vinculación por QR: activa solo cuando no hay token ──────────────────
  useEffect(() => {
    if (token) return
    let cancelled = false
    let poll: ReturnType<typeof setInterval> | null = null
    let lifetime: ReturnType<typeof setTimeout> | null = null

    async function newCode() {
      if (cancelled) return
      if (poll) { clearInterval(poll); poll = null }
      if (lifetime) { clearTimeout(lifetime); lifetime = null }
      setPairError(null); setQrDataUrl('')

      // El código lo genera el servidor con gen_random_bytes: Math.random() no
      // es criptográficamente seguro. La RPC inserta la fila y devuelve el
      // código, así que el player ya no escribe en device_pairings.
      const { data: code, error } = await supabase.rpc('create_pairing_code')
      if (cancelled) return
      if (error || !code) { setPairError('No se pudo generar el código. Reintentando…'); lifetime = setTimeout(newCode, 5000); return }
      setPairCode(code as string)

      try {
        const dataUrl = await QRCode.toDataURL(`${window.location.origin}/pair?code=${code}`, {
          width: 320, margin: 1, color: { dark: '#0F172A', light: '#FFFFFF' },
        })
        if (!cancelled) setQrDataUrl(dataUrl)
      } catch { if (!cancelled) setPairError('No se pudo generar el QR.') }

      // Polling: cuando el admin vincula desde /pair, la RPC devuelve el token
      // y borra la fila en la misma transacción (sin ventana de robo). Mientras
      // no esté vinculado devuelve null y la fila se queda intacta.
      poll = setInterval(async () => {
        const { data: claimed } = await supabase.rpc('claim_pairing_token', { p_code: code })
        if (cancelled || !claimed) return
        if (poll) clearInterval(poll)
        if (lifetime) clearTimeout(lifetime)
        try { localStorage.setItem(TOKEN_STORAGE_KEY, claimed as string) } catch { /* noop */ }
        setToken(claimed as string)   // → dispara checkScreen y arranca a reproducir
      }, 2000)

      // Rota el código cada 5 min (las filas no expiran solas).
      lifetime = setTimeout(newCode, 5 * 60 * 1000)
    }

    newCode()
    return () => {
      cancelled = true
      if (poll) clearInterval(poll)
      if (lifetime) clearTimeout(lifetime)
      // Ya no se borra la fila desde aquí: el player deja de escribir en
      // device_pairings. Los códigos sin vincular los recoge el job de pg_cron
      // (cleanup_device_pairings, cada 10 min).
    }
  }, [token]) // eslint-disable-line react-hooks/exhaustive-deps

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
  if (status === 'no-token') return (
    <div style={pairWrap}>
      <img src={logoNegro} alt="GestPlayer" style={{ height: '46px', width: 'auto', marginBottom: '1.75rem' }} />
      <div style={pairCard}>
        <div style={pairIcon}>
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#2563EB" strokeWidth="2"><rect x="2" y="3" width="20" height="14" rx="2" /><line x1="8" y1="21" x2="16" y2="21" /><line x1="12" y1="17" x2="12" y2="21" /></svg>
        </div>
        <h2 style={pairTitle}>Vincula esta pantalla</h2>
        <p style={pairSub}>Escanea el código con tu teléfono, inicia sesión y elige esta pantalla.</p>
        <div style={pairQrBox}>
          {qrDataUrl
            ? <img src={qrDataUrl} alt="Código QR de vinculación" width={220} height={220} style={{ display: 'block' }} />
            : <div style={{ width: 220, height: 220, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><div style={pairSpinner} /></div>}
        </div>
        {pairCode && <p style={pairCodeText}>{pairCode}</p>}
        <p style={{ ...pairSub, color: pairError ? '#EF4444' : '#94A3B8', margin: '0.6rem 0 0' }}>{pairError ?? 'Esperando conexión…'}</p>
      </div>
    </div>
  )
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

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#000', cursor: 'none' }}>
      {withinHours && programId && <ScreenStage payload={payload} programId={programId} reloadKey={reloadKey} onPlay={logPlay} />}
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

// Pantalla de vinculación por QR: misma línea gráfica que /pair y el login.
const pairWrap: React.CSSProperties = { position: 'fixed', inset: 0, background: '#F8FAFC', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '1.5rem', fontFamily: 'system-ui, -apple-system, sans-serif' }
const pairCard: React.CSSProperties = { background: '#fff', border: '1px solid #E2E8F0', borderRadius: '16px', padding: '2rem', boxShadow: '0 4px 24px rgba(0,0,0,0.07)', textAlign: 'center', maxWidth: '380px', width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center' }
const pairIcon: React.CSSProperties = { width: '56px', height: '56px', borderRadius: '14px', background: '#EFF6FF', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: '1rem' }
const pairTitle: React.CSSProperties = { fontSize: '1.15rem', fontWeight: 700, color: '#0F172A', margin: 0 }
const pairSub: React.CSSProperties = { color: '#94A3B8', fontSize: '0.88rem', margin: '0.5rem 0 1.25rem' }
const pairQrBox: React.CSSProperties = { background: '#fff', padding: 12, borderRadius: 14, border: '1px solid #E2E8F0' }
const pairCodeText: React.CSSProperties = { fontFamily: 'monospace', fontSize: '1.5rem', letterSpacing: '0.3em', color: '#0F172A', fontWeight: 700, margin: '1.1rem 0 0' }
const pairSpinner: React.CSSProperties = { width: '30px', height: '30px', border: '3px solid #E2E8F0', borderTop: '3px solid #3B82F6', borderRadius: '50%', animation: 'spin 1s linear infinite' }
