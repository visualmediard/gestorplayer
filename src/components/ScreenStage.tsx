import { useEffect, useRef, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'

// Reusable playback engine: loads a program's zones + playlists and renders
// them filling the whole surface, with each zone placed by percentage of the
// program canvas — so the program's (0,0) is the top-left corner and every
// zone lands exactly where it was designed (same as the Android player).

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

function ZonePlayer({ z, program, pub, onPlay }: {
  z: ZoneData; program: Program
  pub: (p: string) => string
  onPlay?: (contentId: string, zoneId: string) => void
}) {
  const [step, setStep] = useState(0)
  const subPtr = useRef<Record<number, number>>({})
  const { zone, entries } = z

  // Position by percentage of the program canvas → (0,0) is the top-left
  // corner and zones fill their exact designed area.
  const style: React.CSSProperties = {
    position: 'absolute',
    left: `${(zone.x / program.width) * 100}%`,
    top: `${(zone.y / program.height) * 100}%`,
    width: `${(zone.width / program.width) * 100}%`,
    height: `${(zone.height / program.height) * 100}%`,
    background: zone.background_color || '#000',
    overflow: 'hidden', boxSizing: 'border-box',
  }

  if (entries.length === 0) {
    return <div style={{ ...style, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <span style={{ color: 'rgba(255,255,255,0.35)', fontSize: '0.9rem' }}>{zone.name}</span>
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

  const pub = (path: string) => path ? client.storage.from('media').getPublicUrl(path).data.publicUrl : ''

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

  // The program canvas fills the whole surface (edge to edge); (0,0) is the
  // top-left corner. Areas not covered by a zone stay black.
  return (
    <div style={{ position: 'absolute', inset: 0, background: '#000', overflow: 'hidden' }}>
      {program && zones.map(z => <ZonePlayer key={z.zone.id} z={z} program={program} pub={pub} onPlay={onPlay} />)}
    </div>
  )
}
