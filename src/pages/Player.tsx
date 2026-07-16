import { useEffect, useRef, useState } from 'react'
import { createClient } from '@supabase/supabase-js'

// Dedicated anonymous client: a screen is never "logged in", and even when an
// admin previews /play in the same browser we must write as anon so RLS lets
// heartbeats and playback_events through. persistSession:false ignores any
// stored admin session.
const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } }
)

// ── Types ──
type Program = { id: string; name: string; width: number; height: number }
type Zone = { id: string; name: string; x: number; y: number; width: number; height: number; background_color: string }
type PlayItem = {
  id: string; type: 'image' | 'video' | 'url'
  storage_path: string; url: string | null
  duration_seconds: number | null; expires_at: string | null
}
type Entry = { kind: 'item'; item: PlayItem } | { kind: 'sub'; items: PlayItem[] }
type ZoneData = { zone: Zone; entries: Entry[] }

const HEARTBEAT_MS = 30_000      // ping "online" every 30s
const RELOAD_MS = 60_000         // re-check the assigned program every 60s

function getPublicUrl(path: string) {
  if (!path) return ''
  return supabase.storage.from('media').getPublicUrl(path).data.publicUrl
}

function isExpired(item: PlayItem) {
  if (!item.expires_at) return false
  const expiry = new Date(item.expires_at); expiry.setHours(23, 59, 59, 999)
  return new Date() > expiry
}

// ── Image slide: shows for `ms` then calls onDone ──
function ImageSlide({ url, ms, onDone }: { url: string; ms: number; onDone: () => void }) {
  useEffect(() => { const t = setTimeout(onDone, ms); return () => clearTimeout(t) }, [url, ms])
  return <img src={url} style={{ width: '100%', height: '100%', objectFit: 'cover', position: 'absolute', inset: 0 }} />
}

// ── One zone: cycles through its entries; round-robin inside sub-playlists ──
function ZonePlayer({ z, scale, onPlay }: { z: ZoneData; scale: number; onPlay: (contentId: string, zoneId: string) => void }) {
  const [step, setStep] = useState(0)
  const subPtr = useRef<Record<number, number>>({})
  const { zone, entries } = z

  const style: React.CSSProperties = {
    position: 'absolute', left: zone.x * scale, top: zone.y * scale,
    width: zone.width * scale, height: zone.height * scale,
    background: zone.background_color || '#000', overflow: 'hidden', boxSizing: 'border-box',
  }

  if (entries.length === 0) {
    return <div style={{ ...style, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <span style={{ color: 'rgba(255,255,255,0.4)', fontSize: `${Math.max(10, 14 * scale)}px` }}>{zone.name}</span>
    </div>
  }

  const entryIdx = step % entries.length
  const entry = entries[entryIdx]
  const item = entry.kind === 'item'
    ? entry.item
    : entry.items[(subPtr.current[entryIdx] ?? 0) % entry.items.length]

  const next = () => {
    if (entry.kind === 'sub') subPtr.current[entryIdx] = (subPtr.current[entryIdx] ?? 0) + 1
    setStep(s => s + 1)
  }

  // Log a playback event each time an item becomes active.
  useEffect(() => { if (item) onPlay(item.id, zone.id) }, [step]) // eslint-disable-line react-hooks/exhaustive-deps

  let content: React.ReactNode
  if (item.type === 'url') {
    content = <iframe src={item.url ?? ''} style={{ width: '100%', height: '100%', border: 'none' }} title={item.id} />
    // advance URL slides on their duration
    // (handled by keyed timeout below)
  } else if (item.type === 'image') {
    content = <ImageSlide key={`${item.id}-${step}`} url={getPublicUrl(item.storage_path)} ms={(item.duration_seconds ?? 10) * 1000} onDone={next} />
  } else {
    content = <video key={`${item.id}-${step}`} src={getPublicUrl(item.storage_path)} muted autoPlay playsInline
      onEnded={next} onError={next}
      style={{ width: '100%', height: '100%', objectFit: 'cover', position: 'absolute', inset: 0 }} />
  }

  return (
    <div style={style}>
      {content}
      {item.type === 'url' && <UrlTimer key={`${item.id}-${step}`} ms={(item.duration_seconds ?? 30) * 1000} onDone={next} />}
    </div>
  )
}

function UrlTimer({ ms, onDone }: { ms: number; onDone: () => void }) {
  useEffect(() => { const t = setTimeout(onDone, ms); return () => clearTimeout(t) }, [ms])
  return null
}

// ── Full-screen player ──
export default function Player() {
  const token = new URLSearchParams(window.location.search).get('token') || ''
  const [status, setStatus] = useState<'loading' | 'no-token' | 'invalid' | 'no-program' | 'playing'>('loading')
  const [screen, setScreen] = useState<{ id: string; name: string } | null>(null)
  const [program, setProgram] = useState<Program | null>(null)
  const [zones, setZones] = useState<ZoneData[]>([])
  const [viewport, setViewport] = useState({ w: window.innerWidth, h: window.innerHeight })
  const currentProgramRef = useRef<string | null>(null)

  // Load everything for the current token.
  async function loadAll(initial = false) {
    if (!token) { setStatus('no-token'); return }
    const { data: sc } = await supabase.from('screens')
      .select('id, name, current_program_id').eq('device_token', token).maybeSingle()
    if (!sc) { setStatus('invalid'); return }
    setScreen({ id: sc.id, name: sc.name })

    if (!sc.current_program_id) { currentProgramRef.current = null; setProgram(null); setZones([]); setStatus('no-program'); return }

    // Only rebuild if the program changed (avoids flicker on polling).
    if (!initial && sc.current_program_id === currentProgramRef.current && status === 'playing') return
    currentProgramRef.current = sc.current_program_id

    const { data: prog } = await supabase.from('programs')
      .select('id, name, width, height').eq('id', sc.current_program_id).maybeSingle()
    if (!prog) { setStatus('no-program'); return }
    setProgram(prog as Program)

    const { data: zoneRows } = await supabase.from('zones')
      .select('id, name, x, y, width, height, background_color').eq('program_id', prog.id).order('sort_order')

    const built: ZoneData[] = []
    for (const zone of (zoneRows ?? []) as Zone[]) {
      const [{ data: items }, { data: subs }] = await Promise.all([
        supabase.from('media_content').select('id, type, storage_path, url, duration_seconds, expires_at, sort_order')
          .eq('zone_id', zone.id).is('sub_playlist_id', null).is('archived_at', null).order('sort_order'),
        supabase.from('sub_playlists').select('id, sort_order').eq('zone_id', zone.id).is('archived_at', null).order('sort_order'),
      ])
      const subItems: Record<string, PlayItem[]> = {}
      for (const sub of (subs ?? [])) {
        const { data: si } = await supabase.from('media_content')
          .select('id, type, storage_path, url, duration_seconds, expires_at, sort_order')
          .eq('sub_playlist_id', sub.id).is('archived_at', null).order('sort_order')
        subItems[sub.id] = ((si ?? []) as PlayItem[]).filter(i => !isExpired(i))
      }
      const combined: { sort_order: number; entry: Entry }[] = [
        ...((items ?? []) as (PlayItem & { sort_order: number })[]).filter(i => !isExpired(i))
          .map(i => ({ sort_order: i.sort_order, entry: { kind: 'item' as const, item: i } })),
        ...((subs ?? []) as { id: string; sort_order: number }[])
          .filter(s => (subItems[s.id] ?? []).length > 0)
          .map(s => ({ sort_order: s.sort_order, entry: { kind: 'sub' as const, items: subItems[s.id] } })),
      ]
      combined.sort((a, b) => a.sort_order - b.sort_order)
      built.push({ zone, entries: combined.map(c => c.entry) })
    }
    setZones(built)
    setStatus('playing')
  }

  // Fire-and-forget: record a play + refresh the "online" heartbeat.
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

  useEffect(() => { loadAll(true) }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Heartbeat + periodic reload
  useEffect(() => {
    if (!screen) return
    heartbeat()
    const hb = setInterval(heartbeat, HEARTBEAT_MS)
    const rl = setInterval(() => loadAll(false), RELOAD_MS)
    return () => { clearInterval(hb); clearInterval(rl) }
  }, [screen?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // Track viewport for scaling
  useEffect(() => {
    const onResize = () => setViewport({ w: window.innerWidth, h: window.innerHeight })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // ── Render states ──
  if (status === 'loading') return <Center><Spinner /><p style={msg}>Conectando…</p></Center>
  if (status === 'no-token') return <Center>
    <h1 style={title}>Reproductor GestorPlayer</h1>
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

  // Playing
  const scale = program ? Math.min(viewport.w / program.width, viewport.h / program.height) : 1
  const stageW = program ? program.width * scale : viewport.w
  const stageH = program ? program.height * scale : viewport.h

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#000', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', cursor: 'none' }}>
      <div style={{ position: 'relative', width: stageW, height: stageH, background: '#000' }}>
        {zones.map(z => <ZonePlayer key={z.zone.id} z={z} scale={scale} onPlay={logPlay} />)}
        {zones.length === 0 && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span style={{ color: 'rgba(255,255,255,0.4)' }}>Programa sin zonas con contenido.</span>
          </div>
        )}
      </div>
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
