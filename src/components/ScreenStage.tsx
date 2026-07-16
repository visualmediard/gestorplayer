import { useEffect, useRef, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'

// Reusable playback engine: loads a program's zones + playlists and renders
// them scaled to fit its parent (letterboxed), cycling each zone's content.
// Used both by the full-screen Player and by the "Captura" preview modal.

type Program = { id: string; name: string; width: number; height: number }
type Zone = { id: string; name: string; x: number; y: number; width: number; height: number; background_color: string }
type PlayItem = {
  id: string; type: 'image' | 'video' | 'url'
  storage_path: string; url: string | null
  duration_seconds: number | null; expires_at: string | null
}
type Entry = { kind: 'item'; item: PlayItem } | { kind: 'sub'; items: PlayItem[] }
type ZoneData = { zone: Zone; entries: Entry[] }

function isExpired(item: PlayItem) {
  if (!item.expires_at) return false
  const expiry = new Date(item.expires_at); expiry.setHours(23, 59, 59, 999)
  return new Date() > expiry
}

function ImageSlide({ url, ms, onDone }: { url: string; ms: number; onDone: () => void }) {
  useEffect(() => { const t = setTimeout(onDone, ms); return () => clearTimeout(t) }, [url, ms])
  return <img src={url} style={{ width: '100%', height: '100%', objectFit: 'cover', position: 'absolute', inset: 0 }} />
}

function UrlTimer({ ms, onDone }: { ms: number; onDone: () => void }) {
  useEffect(() => { const t = setTimeout(onDone, ms); return () => clearTimeout(t) }, [ms])
  return null
}

function ZonePlayer({ z, scale, pub, onPlay }: {
  z: ZoneData; scale: number
  pub: (p: string) => string
  onPlay?: (contentId: string, zoneId: string) => void
}) {
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
      <span style={{ color: 'rgba(255,255,255,0.4)', fontSize: `${Math.max(9, 13 * scale)}px` }}>{zone.name}</span>
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

  useEffect(() => { if (item && onPlay) onPlay(item.id, zone.id) }, [step]) // eslint-disable-line react-hooks/exhaustive-deps

  let content: React.ReactNode
  if (item.type === 'url') {
    content = <iframe src={item.url ?? ''} style={{ width: '100%', height: '100%', border: 'none' }} title={item.id} />
  } else if (item.type === 'image') {
    content = <ImageSlide key={`${item.id}-${step}`} url={pub(item.storage_path)} ms={(item.duration_seconds ?? 10) * 1000} onDone={next} />
  } else {
    content = <video key={`${item.id}-${step}`} src={pub(item.storage_path)} muted autoPlay playsInline
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

export default function ScreenStage({ client, programId, onPlay, onEmpty }: {
  client: SupabaseClient
  programId: string
  onPlay?: (contentId: string, zoneId: string) => void
  onEmpty?: (empty: boolean) => void
}) {
  const [program, setProgram] = useState<Program | null>(null)
  const [zones, setZones] = useState<ZoneData[]>([])
  const [box, setBox] = useState({ w: 0, h: 0 })
  const ref = useRef<HTMLDivElement>(null)

  const pub = (path: string) => path ? client.storage.from('media').getPublicUrl(path).data.publicUrl : ''

  // Load program + zones + playlists
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const { data: prog } = await client.from('programs')
        .select('id, name, width, height').eq('id', programId).maybeSingle()
      if (cancelled || !prog) { setProgram(null); setZones([]); return }
      setProgram(prog as Program)

      const { data: zoneRows } = await client.from('zones')
        .select('id, name, x, y, width, height, background_color').eq('program_id', prog.id).order('sort_order')

      const built: ZoneData[] = []
      for (const zone of (zoneRows ?? []) as Zone[]) {
        const [{ data: items }, { data: subs }] = await Promise.all([
          client.from('media_content').select('id, type, storage_path, url, duration_seconds, expires_at, sort_order')
            .eq('zone_id', zone.id).is('sub_playlist_id', null).is('archived_at', null).order('sort_order'),
          client.from('sub_playlists').select('id, sort_order').eq('zone_id', zone.id).is('archived_at', null).order('sort_order'),
        ])
        const subItems: Record<string, PlayItem[]> = {}
        for (const sub of (subs ?? [])) {
          const { data: si } = await client.from('media_content')
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
      if (cancelled) return
      setZones(built)
      if (onEmpty) onEmpty(built.every(z => z.entries.length === 0))
    })()
    return () => { cancelled = true }
  }, [programId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Measure container for scaling
  useEffect(() => {
    const measure = () => { if (ref.current) setBox({ w: ref.current.clientWidth, h: ref.current.clientHeight }) }
    measure()
    const ro = new ResizeObserver(measure)
    if (ref.current) ro.observe(ref.current)
    return () => ro.disconnect()
  }, [])

  const scale = program && box.w && box.h ? Math.min(box.w / program.width, box.h / program.height) : 0

  return (
    <div ref={ref} style={{ position: 'absolute', inset: 0, background: '#000', overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      {program && scale > 0 && (
        <div style={{ position: 'relative', width: program.width * scale, height: program.height * scale, background: '#000' }}>
          {zones.map(z => <ZonePlayer key={z.zone.id} z={z} scale={scale} pub={pub} onPlay={onPlay} />)}
        </div>
      )}
    </div>
  )
}
