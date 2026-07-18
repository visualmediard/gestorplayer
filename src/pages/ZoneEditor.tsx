import { useEffect, useState, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { uploadToR2 } from '../lib/uploadToR2'
import { resolveMediaUrl, isRemoteUrl } from '../lib/mediaUrl'
import { fileTooLargeMessage } from '../lib/fileLimit'
import { useAuth } from '../auth/AuthContext'

type Program = { id: string; name: string; width: number; height: number }
type Zone = { id: string; name: string; x: number; y: number; width: number; height: number; background_color: string; daily_frequency: number | null; is_unlimited: boolean }
type SubPlaylist = { id: string; name: string; sort_order: number; is_unlimited: boolean; daily_frequency: number | null }
type MediaItem = { id: string; name: string; type: 'image' | 'video' | 'url'; storage_path: string; url?: string; duration_seconds: number | null; sort_order: number; daily_frequency: number | null; is_unlimited: boolean; sub_playlist_id: string | null; expires_at: string | null }
type PlaylistEntry = { kind: 'item'; item: MediaItem } | { kind: 'sub'; sub: SubPlaylist; items: MediaItem[] }
type Props = { programId: string; onBack: () => void }

const COLORS = ['#E2E8F0', '#DBEAFE', '#D1FAE5', '#FEE2E2', '#EDE9FE', '#FEF3C7']
const OPERATING_HOURS = 20

function ImageSlide({ url, duration, onDone }: { url: string; duration: number; onDone: () => void }) {
  useEffect(() => { const t = setTimeout(onDone, duration); return () => clearTimeout(t) }, [url])
  return <img src={url} style={{ width: '100%', height: '100%', objectFit: 'cover', position: 'absolute', inset: 0 }} />
}

export default function ZoneEditor({ programId, onBack }: Props) {
  const { profile } = useAuth()
  const [program, setProgram] = useState<Program | null>(null)
  const [zones, setZones] = useState<Zone[]>([])
  const [selectedZone, setSelectedZone] = useState<string | null>(null)
  const [entries, setEntries] = useState<PlaylistEntry[]>([])
  const [showZoneForm, setShowZoneForm] = useState(false)
  const [saving, setSaving] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [published, setPublished] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [playIndex, setPlayIndex] = useState(0)
  const [previewPlaylist, setPreviewPlaylist] = useState<MediaItem[]>([])

  const [name, setName] = useState('')
  const [x, setX] = useState(0)
  const [y, setY] = useState(0)
  const [w, setW] = useState(960)
  const [h, setH] = useState(540)
  const [color, setColor] = useState('#E2E8F0')
  const [isUnlimited, setIsUnlimited] = useState(true)
  const [freq, setFreq] = useState(10)

  const [uploadTarget, setUploadTarget] = useState<{ type: 'zone' | 'sub'; id: string } | null>(null)
  const [showLibrary, setShowLibrary] = useState(false)
  const [library, setLibrary] = useState<MediaItem[]>([])
  const [libraryLoading, setLibraryLoading] = useState(false)
  const [librarySearch, setLibrarySearch] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [duration, setDuration] = useState(10)
  const [uploading, setUploading] = useState(false)
  const [progress, setProgress] = useState(0)
  const fileRef = useRef<HTMLInputElement>(null)

  const [showSubForm, setShowSubForm] = useState(false)
  const [subName, setSubName] = useState('')
  const [showUrlForm, setShowUrlForm] = useState(false)
  const [urlValue, setUrlValue] = useState('')
  const [urlName, setUrlName] = useState('')
  const [urlDuration, setUrlDuration] = useState(30)
  const [urlFreq, setUrlFreq] = useState(0)

  const [editingFreq, setEditingFreq] = useState<string | null>(null)
  const [freqValue, setFreqValue] = useState(0)
  const [editingUrl, setEditingUrl] = useState<string | null>(null)
  const [editUrlValue, setEditUrlValue] = useState('')
  const [editUrlName, setEditUrlName] = useState('')
  const [editUrlDuration, setEditUrlDuration] = useState(30)
  const [editingExpiry, setEditingExpiry] = useState<string | null>(null)
  const [expiryValue, setExpiryValue] = useState('')
  const [editingZone, setEditingZone] = useState<Zone | null>(null)
  const [editZoneName, setEditZoneName] = useState('')
  const [editZoneX, setEditZoneX] = useState(0)
  const [editZoneY, setEditZoneY] = useState(0)
  const [editZoneW, setEditZoneW] = useState(0)
  const [editZoneH, setEditZoneH] = useState(0)
  const [editZoneColor, setEditZoneColor] = useState('#E2E8F0')

  // Replace
  const [replacingItem, setReplacingItem] = useState<MediaItem | null>(null)
  const [replacing, setReplacing] = useState(false)
  const [replaceProgress, setReplaceProgress] = useState(0)
  const replaceRef = useRef<HTMLInputElement>(null)
  const [showReplaceLibrary, setShowReplaceLibrary] = useState(false)
  const [replaceLibrarySearch, setReplaceLibrarySearch] = useState('')

  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null)
  const dragIdx = useRef<number | null>(null)
  const [subDragOver, setSubDragOver] = useState<{ subId: string; idx: number } | null>(null)
  const subDragIdx = useRef<{ subId: string; idx: number } | null>(null)

  async function load() {
    const { data: prog } = await supabase.from('programs').select('*').eq('id', programId).single()
    const { data: zns } = await supabase.from('zones').select('*').eq('program_id', programId).order('sort_order')
    if (prog) setProgram(prog as Program)
    if (zns) setZones(zns as Zone[])
  }

  async function loadEntries(zoneId: string) {
    const { data: items } = await supabase.from('media_content').select('*').eq('zone_id', zoneId).is('sub_playlist_id', null).is('archived_at', null).order('sort_order')
    const { data: subs } = await supabase.from('sub_playlists').select('*').eq('zone_id', zoneId).is('archived_at', null).order('sort_order')
    const subItems: Record<string, MediaItem[]> = {}
    if (subs) {
      for (const sub of subs) {
        const { data: si } = await supabase.from('media_content').select('*').eq('sub_playlist_id', sub.id).is('archived_at', null).order('sort_order')
        subItems[sub.id] = (si ?? []) as MediaItem[]
      }
    }
    const allEntries: PlaylistEntry[] = []
    const combined: { sort_order: number; entry: PlaylistEntry }[] = [
      ...((items ?? []) as MediaItem[]).map(i => ({ sort_order: i.sort_order, entry: { kind: 'item' as const, item: i } })),
      ...((subs ?? []) as SubPlaylist[]).map(s => ({ sort_order: s.sort_order, entry: { kind: 'sub' as const, sub: s, items: subItems[s.id] ?? [] } })),
    ]
    combined.sort((a, b) => a.sort_order - b.sort_order)
    combined.forEach(c => allEntries.push(c.entry))
    setEntries(allEntries)
    const flat: MediaItem[] = []
    combined.forEach(c => {
      if (c.entry.kind === 'item') flat.push(c.entry.item)
      else if (c.entry.kind === 'sub' && c.entry.items.length > 0) flat.push(c.entry.items[0])
    })
    setPreviewPlaylist(flat); setPlayIndex(0)
  }

  async function loadLibrary() {
    setLibraryLoading(true)
    const { data } = await supabase.from('media_content').select('*').is('archived_at', null).order('created_at', { ascending: false })
    if (data) setLibrary(data as MediaItem[])
    setLibraryLoading(false)
  }

  useEffect(() => { load() }, [programId])
  useEffect(() => {
    if (selectedZone) loadEntries(selectedZone)
    else { setEntries([]); setPreviewPlaylist([]) }
  }, [selectedZone])

  const getPublicUrl = resolveMediaUrl

  function freqLabel(item: { is_unlimited: boolean; daily_frequency: number | null }) {
    if (item.is_unlimited) return '∞ Ilimitado'
    const reps = item.daily_frequency ?? 1
    const mins = (OPERATING_HOURS * 60) / reps
    return `🔁 ${reps}x/día · ${mins >= 60 ? `c/${(mins / 60).toFixed(1)}h` : `c/${Math.round(mins)}min`}`
  }

  function isExpired(item: MediaItem) {
    if (!item.expires_at) return false
    const expiry = new Date(item.expires_at); expiry.setHours(23, 59, 59, 999)
    return new Date() > expiry
  }

  function itemMetaLabel(item: MediaItem, idx: number) {
    if (item.type === 'url') return `🌐 URL · ${item.duration_seconds ?? 30}s · Pos ${idx + 1}`
    if (item.type === 'video') return `Video · Pos ${idx + 1}`
    return `Imagen · ${item.duration_seconds ?? 10}s · Pos ${idx + 1}`
  }

  function renderThumb(item: MediaItem) {
    if (item.type === 'url') return <div style={{ width: '100%', height: '100%', background: '#DBEAFE', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.2rem' }}>🌐</div>
    if (item.type === 'image') return <img src={getPublicUrl(item.storage_path)} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
    return <video src={getPublicUrl(item.storage_path)} style={{ width: '100%', height: '100%', objectFit: 'cover' }} preload="metadata" muted onLoadedMetadata={e => { e.currentTarget.currentTime = 1 }} />
  }

  async function handlePublish() {
    setPublishing(true)
    const now = new Date().toISOString()
    await supabase.from('programs').update({ published_at: now }).eq('id', programId)
    await supabase.from('screens').update({ updated_at: now } as any).eq('current_program_id', programId)
    setPublishing(false); setPublished(true)
    setTimeout(() => setPublished(false), 3000)
  }

  async function handleCreateZone() {
    if (!name.trim()) { setError('El nombre es requerido.'); return }
    setSaving(true); setError(null)
    const { error } = await supabase.from('zones').insert({ program_id: programId, name: name.trim(), x, y, width: w, height: h, background_color: color, is_unlimited: isUnlimited, daily_frequency: isUnlimited ? null : freq, sort_order: zones.length })
    setSaving(false)
    if (error) { setError(error.message); return }
    setName(''); setX(0); setY(0); setW(960); setH(540); setShowZoneForm(false); load()
  }

  async function handleSaveZone() {
    if (!editingZone) return
    await supabase.from('zones').update({ name: editZoneName.trim(), x: editZoneX, y: editZoneY, width: editZoneW, height: editZoneH, background_color: editZoneColor }).eq('id', editingZone.id)
    setEditingZone(null); load()
  }

  async function handleDeleteZone(id: string) {
    if (!confirm('¿Eliminar esta zona?')) return
    await supabase.from('zones').delete().eq('id', id); setSelectedZone(null); load()
  }

  async function handleAddUrl() {
    if (!urlValue.trim() || !selectedZone) return
    await supabase.from('media_content').insert({ zone_id: selectedZone, name: urlName.trim() || urlValue.trim(), type: 'url', storage_path: '', url: urlValue.trim(), duration_seconds: urlDuration, is_unlimited: urlFreq === 0, daily_frequency: urlFreq === 0 ? null : urlFreq, uploaded_by: profile?.id, sort_order: entries.length, sub_playlist_id: null })
    setUrlValue(''); setUrlName(''); setUrlDuration(30); setUrlFreq(0); setShowUrlForm(false); loadEntries(selectedZone)
  }

  async function handleSaveUrl(itemId: string) {
    await supabase.from('media_content').update({ name: editUrlName.trim() || editUrlValue.trim(), url: editUrlValue.trim(), duration_seconds: editUrlDuration }).eq('id', itemId)
    setEditingUrl(null); loadEntries(selectedZone!)
  }

  async function handleSaveExpiry(itemId: string) {
    await supabase.from('media_content').update({ expires_at: expiryValue || null }).eq('id', itemId)
    setEditingExpiry(null); loadEntries(selectedZone!)
  }

  async function handleCreateSub() {
    if (!subName.trim() || !selectedZone) return
    await supabase.from('sub_playlists').insert({ zone_id: selectedZone, name: subName.trim(), sort_order: entries.length, is_unlimited: true })
    setSubName(''); setShowSubForm(false); loadEntries(selectedZone)
  }

  async function handleDeleteSub(subId: string) {
    if (!confirm('¿Eliminar esta sub-playlist?')) return
    await supabase.from('sub_playlists').delete().eq('id', subId); loadEntries(selectedZone!)
  }

  async function handleAddFromLibrary(item: MediaItem) {
    if (!uploadTarget) return
    const insertData: any = {
      zone_id: selectedZone, name: item.name, type: item.type,
      storage_path: item.storage_path, url: item.url,
      duration_seconds: item.duration_seconds,
      is_unlimited: true, daily_frequency: null,
      uploaded_by: profile?.id, expires_at: null, sub_playlist_id: null,
    }
    if (uploadTarget.type === 'zone') {
      insertData.sort_order = entries.length
    } else {
      const entry = entries.find(e => e.kind === 'sub' && e.sub.id === uploadTarget.id)
      const subItems = entry?.kind === 'sub' ? entry.items : []
      insertData.sub_playlist_id = uploadTarget.id
      insertData.sort_order = subItems.length
    }
    await supabase.from('media_content').insert(insertData)
    setShowLibrary(false); setUploadTarget(null)
    loadEntries(selectedZone!)
  }

  async function handleReplaceFromLibrary(sourceItem: MediaItem) {
    if (!replacingItem) return
    await supabase.from('media_content').update({
      name: sourceItem.name,
      type: sourceItem.type,
      storage_path: sourceItem.storage_path,
      url: sourceItem.url ?? null,
      duration_seconds: sourceItem.duration_seconds ?? replacingItem.duration_seconds,
    }).eq('id', replacingItem.id)
    setShowReplaceLibrary(false); setReplacingItem(null)
    loadEntries(selectedZone!)
  }

  async function handleReplaceFromFile(file: File) {
    if (!replacingItem) return
    setReplacing(true)
    const isVideo = file.type.startsWith('video/')
    const { url, error: storageError } = await uploadToR2(file, setReplaceProgress)
    if (storageError || !url) { alert('Error: ' + (storageError?.message ?? 'desconocido')); setReplacing(false); return }
    // Solo borramos de Supabase si el archivo viejo vivía ahí; los de R2 no se
    // borran desde el cliente (quedan huérfanos, aceptable).
    if (replacingItem.storage_path && !isRemoteUrl(replacingItem.storage_path)) {
      await supabase.storage.from('media').remove([replacingItem.storage_path])
    }
    await supabase.from('media_content').update({
      name: file.name, type: isVideo ? 'video' : 'image',
      storage_path: url, duration_seconds: isVideo ? null : (replacingItem.duration_seconds ?? 10),
    }).eq('id', replacingItem.id)
    setReplacing(false); setReplaceProgress(0)
    setReplacingItem(null); setShowReplaceLibrary(false)
    if (replaceRef.current) replaceRef.current.value = ''
    loadEntries(selectedZone!)
  }

  async function handleUpload() {
    if (!file || !uploadTarget) return
    setUploading(true); setError(null)
    const isVideo = file.type.startsWith('video/')
    const { url, error: storageError } = await uploadToR2(file, setProgress)
    if (storageError || !url) { setError('Error: ' + (storageError?.message ?? 'desconocido')); setUploading(false); return }
    const insertData: any = { name: file.name, type: isVideo ? 'video' : 'image', storage_path: url, duration_seconds: isVideo ? null : duration, uploaded_by: profile?.id, is_unlimited: true, daily_frequency: null }
    if (uploadTarget.type === 'zone') { insertData.zone_id = selectedZone; insertData.sort_order = entries.length; insertData.sub_playlist_id = null }
    else { const entry = entries.find(e => e.kind === 'sub' && e.sub.id === uploadTarget.id); const subItems = entry?.kind === 'sub' ? entry.items : []; insertData.zone_id = selectedZone; insertData.sub_playlist_id = uploadTarget.id; insertData.sort_order = subItems.length }
    await supabase.from('media_content').insert(insertData)
    setFile(null); setProgress(0); setUploading(false); setDuration(10); setUploadTarget(null); setShowLibrary(false)
    if (fileRef.current) fileRef.current.value = ''; loadEntries(selectedZone!)
  }

  async function handleDeleteItem(item: MediaItem) {
    if (!confirm(`¿Quitar "${item.name}" de esta zona?\n\nSeguirá en Estadísticas hasta que lo elimines definitivamente desde allí.`)) return
    // Soft delete: keep the row (and its file) so statistics survive. The zone
    // editor and player already filter out archived_at rows.
    await supabase.from('media_content').update({ archived_at: new Date().toISOString() }).eq('id', item.id)
    loadEntries(selectedZone!)
  }

  async function handleSaveFreq(targetId: string, table: 'media_content' | 'sub_playlists') {
    await supabase.from(table).update({ is_unlimited: freqValue === 0, daily_frequency: freqValue === 0 ? null : freqValue }).eq('id', targetId)
    setEditingFreq(null); loadEntries(selectedZone!)
  }

  async function dragDropEntry(fromIdx: number, toIdx: number) {
    if (fromIdx === toIdx) return
    const newEntries = [...entries]; const [moved] = newEntries.splice(fromIdx, 1); newEntries.splice(toIdx, 0, moved)
    for (let i = 0; i < newEntries.length; i++) { const e = newEntries[i]; const id = e.kind === 'item' ? e.item.id : e.sub.id; const table = e.kind === 'item' ? 'media_content' : 'sub_playlists'; await supabase.from(table as any).update({ sort_order: i }).eq('id', id) }
    loadEntries(selectedZone!)
  }

  async function dragDropSubItem(items: MediaItem[], fromIdx: number, toIdx: number) {
    if (fromIdx === toIdx) return
    const newItems = [...items]; const [moved] = newItems.splice(fromIdx, 1); newItems.splice(toIdx, 0, moved)
    for (let i = 0; i < newItems.length; i++) await supabase.from('media_content').update({ sort_order: i }).eq('id', newItems[i].id)
    loadEntries(selectedZone!)
  }

  const scale = program ? Math.min(520 / program.width, 293 / program.height) : 1
  const activeZone = zones.find(z => z.id === selectedZone)

  return (
    <div style={{ background: '#F8FAFC', minHeight: '100%' }}>
      {/* Input oculto para reemplazo desde archivo */}
      <input ref={replaceRef} type="file" accept="image/*,video/*" style={{ display: 'none' }}
        onChange={e => { const f = e.target.files?.[0]; const tooBig = f && fileTooLargeMessage(f); if (tooBig) { alert(tooBig); e.target.value = ''; return } if (f && replacingItem) handleReplaceFromFile(f); e.target.value = '' }} />

      <div style={s.topbar}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <button style={s.btnBack} onClick={onBack}>← Volver</button>
          <div>
            <h2 style={s.title}>{program?.name ?? 'Cargando...'}</h2>
            <p style={s.sub}>Editor de zonas · {program?.width} × {program?.height}px · {OPERATING_HOURS}h/día</p>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
          {published && <span style={{ color: '#10B981', fontSize: '0.85rem', fontWeight: 500 }}>✓ Publicado</span>}
          <button style={s.btnOutline} onClick={() => setShowZoneForm(!showZoneForm)}>{showZoneForm ? 'Cancelar' : '+ Nueva zona'}</button>
          <button style={s.btnPublish} onClick={handlePublish} disabled={publishing}>
            {publishing ? (
              <>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" style={{ animation: 'spin 0.8s linear infinite' }}>
                  <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
                </svg>
                Publicando...
              </>
            ) : (
              <>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="22" y1="2" x2="11" y2="13"/>
                  <polygon points="22 2 15 22 11 13 2 9 22 2"/>
                </svg>
                &nbsp;&nbsp;Publicar
              </>
            )}
          </button>
        </div>
      </div>

      {showZoneForm && (
        <div style={s.card}>
          <h3 style={s.cardTitle}>Nueva zona</h3>
          <div style={s.formRow}>
            <div style={s.formGroup}><label style={s.label}>Nombre</label><input style={s.input} value={name} onChange={e => setName(e.target.value)} placeholder="Zona principal" /></div>
            <div style={s.formGroup}><label style={s.label}>X</label><input style={{ ...s.input, width: '80px' }} type="number" value={x} onChange={e => setX(+e.target.value)} /></div>
            <div style={s.formGroup}><label style={s.label}>Y</label><input style={{ ...s.input, width: '80px' }} type="number" value={y} onChange={e => setY(+e.target.value)} /></div>
            <div style={s.formGroup}><label style={s.label}>Ancho</label><input style={{ ...s.input, width: '80px' }} type="number" value={w} onChange={e => setW(+e.target.value)} /></div>
            <div style={s.formGroup}><label style={s.label}>Alto</label><input style={{ ...s.input, width: '80px' }} type="number" value={h} onChange={e => setH(+e.target.value)} /></div>
            <div style={s.formGroup}>
              <label style={s.label}>Color</label>
              <div style={{ display: 'flex', gap: '0.4rem' }}>{COLORS.map(c => <div key={c} onClick={() => setColor(c)} style={{ width: '22px', height: '22px', borderRadius: '4px', background: c, cursor: 'pointer', border: color === c ? '2px solid #3B82F6' : '2px solid #E2E8F0' }} />)}</div>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '1rem' }}>
            <label style={s.label}>Frecuencia:</label>
            <label style={s.radioLabel}><input type="radio" checked={isUnlimited} onChange={() => setIsUnlimited(true)} /> Ilimitada</label>
            <label style={s.radioLabel}><input type="radio" checked={!isUnlimited} onChange={() => setIsUnlimited(false)} /> Limitada a</label>
            {!isUnlimited && <><input style={{ ...s.input, width: '70px' }} type="number" min={1} value={freq} onChange={e => setFreq(+e.target.value)} /><span style={{ color: '#64748B', fontSize: '0.85rem' }}>veces/día</span></>}
          </div>
          {error && <p style={{ color: '#EF4444', fontSize: '0.8rem', marginBottom: '0.75rem' }}>{error}</p>}
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button style={s.btnPrimary} onClick={handleCreateZone} disabled={saving}>{saving ? 'Guardando...' : 'Crear zona'}</button>
            <button style={s.btnOutline} onClick={() => setShowZoneForm(false)}>Cancelar</button>
          </div>
        </div>
      )}

      <div style={s.layout}>
        <div style={{ flexShrink: 0 }}>
          <p style={s.sectionLabel}>Vista previa</p>
          {program && (
            <div style={{ width: program.width * scale, height: program.height * scale, background: '#0F172A', position: 'relative', borderRadius: '10px', border: '1px solid #E2E8F0', overflow: 'hidden', boxShadow: '0 2px 8px rgba(0,0,0,0.1)' }}>
              {zones.map(z => (
                <div key={z.id} onClick={() => setSelectedZone(z.id === selectedZone ? null : z.id)}
                  style={{ position: 'absolute', left: z.x * scale, top: z.y * scale, width: z.width * scale, height: z.height * scale, background: z.background_color, border: z.id === selectedZone ? '2px solid #3B82F6' : '1px solid rgba(255,255,255,0.2)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', boxSizing: 'border-box', overflow: 'hidden' }}>
                  {z.id === selectedZone && previewPlaylist.length > 0 ? (() => {
                    const idx = playIndex % previewPlaylist.length
                    const item = previewPlaylist[idx]
                    const url = getPublicUrl(item.storage_path)
                    const next = () => setPlayIndex(i => i + 1)
                    if (item.type === 'url') return <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#DBEAFE', color: '#2563EB', fontSize: '0.7rem' }}>🌐 {item.name}</div>
                    if (item.type === 'image') return <ImageSlide key={item.id + idx} url={url} duration={(item.duration_seconds ?? 10) * 1000} onDone={next} />
                    return <video key={item.id + idx} src={url} style={{ width: '100%', height: '100%', objectFit: 'cover', position: 'absolute', inset: 0 }} muted autoPlay onEnded={next} />
                  })() : <span style={{ color: '#fff', fontSize: `${Math.max(9, 11 * scale)}px`, opacity: 0.8, fontWeight: 600 }}>{z.name}</span>}
                </div>
              ))}
              {zones.length === 0 && <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><span style={{ color: '#64748B', fontSize: '0.8rem' }}>Sin zonas</span></div>}
            </div>
          )}
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={s.sectionLabel}>Zonas · {zones.length} definidas</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginBottom: '1.5rem' }}>
            {zones.length === 0 && <div style={s.emptyBox}><p style={{ color: '#64748B' }}>Crea tu primera zona.</p></div>}
            {zones.map(z => (
              <div key={z.id} onClick={() => setSelectedZone(z.id === selectedZone ? null : z.id)}
                style={{ ...s.zoneCard, border: z.id === selectedZone ? '1px solid #3B82F6' : '1px solid #E2E8F0', background: z.id === selectedZone ? '#EFF6FF' : '#fff' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                    <div style={{ width: '12px', height: '12px', borderRadius: '3px', background: z.background_color, border: '1px solid #E2E8F0', flexShrink: 0 }} />
                    <span style={{ color: '#0F172A', fontWeight: 600, fontSize: '0.875rem' }}>{z.name}</span>
                  </div>
                  <div style={{ display: 'flex', gap: '0.4rem' }}>
                    <button style={s.btnSm} onClick={e => { e.stopPropagation(); setEditingZone(z); setEditZoneName(z.name); setEditZoneX(z.x); setEditZoneY(z.y); setEditZoneW(z.width); setEditZoneH(z.height); setEditZoneColor(z.background_color) }}>Editar</button>
                    <button style={s.btnSmDanger} onClick={e => { e.stopPropagation(); handleDeleteZone(z.id) }}>Eliminar</button>
                  </div>
                </div>
                <div style={{ color: '#94A3B8', fontSize: '0.75rem', marginTop: '0.2rem' }}>{z.x},{z.y} · {z.width}×{z.height}px</div>
                {editingZone?.id === z.id && (
                  <div style={{ marginTop: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }} onClick={e => e.stopPropagation()}>
                    <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                      <div style={s.formGroup}><label style={s.label}>Nombre</label><input style={s.input} value={editZoneName} onChange={e => setEditZoneName(e.target.value)} /></div>
                      <div style={s.formGroup}><label style={s.label}>X</label><input style={{ ...s.input, width: '75px' }} type="number" value={editZoneX} onChange={e => setEditZoneX(+e.target.value)} /></div>
                      <div style={s.formGroup}><label style={s.label}>Y</label><input style={{ ...s.input, width: '75px' }} type="number" value={editZoneY} onChange={e => setEditZoneY(+e.target.value)} /></div>
                      <div style={s.formGroup}><label style={s.label}>Ancho</label><input style={{ ...s.input, width: '75px' }} type="number" value={editZoneW} onChange={e => setEditZoneW(+e.target.value)} /></div>
                      <div style={s.formGroup}><label style={s.label}>Alto</label><input style={{ ...s.input, width: '75px' }} type="number" value={editZoneH} onChange={e => setEditZoneH(+e.target.value)} /></div>
                      <div style={s.formGroup}><label style={s.label}>Color</label><div style={{ display: 'flex', gap: '0.3rem' }}>{COLORS.map(c => <div key={c} onClick={() => setEditZoneColor(c)} style={{ width: '20px', height: '20px', borderRadius: '3px', background: c, cursor: 'pointer', border: editZoneColor === c ? '2px solid #3B82F6' : '2px solid #E2E8F0' }} />)}</div></div>
                    </div>
                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                      <button style={s.btnPrimary} onClick={handleSaveZone}>Guardar</button>
                      <button style={s.btnOutline} onClick={() => setEditingZone(null)}>Cancelar</button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>

          {selectedZone && activeZone && (
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
                <p style={s.sectionLabel}>Playlist de "{activeZone.name}"</p>
                <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                  <button style={s.btnSm} onClick={() => { setUploadTarget({ type: 'zone', id: selectedZone }); setShowSubForm(false); setShowUrlForm(false); setShowLibrary(true); setShowReplaceLibrary(false); loadLibrary() }}>+ Video/Imagen</button>
                  <button style={{ ...s.btnSm, color: '#2563EB', borderColor: '#BFDBFE' }} onClick={() => { setShowUrlForm(!showUrlForm); setShowSubForm(false); setUploadTarget(null); setShowLibrary(false); setShowReplaceLibrary(false) }}>🌐 URL</button>
                  <button style={{ ...s.btnSm, color: '#D97706', borderColor: '#FDE68A' }} onClick={() => { setShowSubForm(!showSubForm); setUploadTarget(null); setShowUrlForm(false); setShowLibrary(false); setShowReplaceLibrary(false) }}>+ Sub-Playlist</button>
                </div>
              </div>

              {showUrlForm && (
                <div style={{ ...s.card, marginBottom: '0.75rem', borderColor: '#BFDBFE' }}>
                  <label style={{ ...s.label, color: '#2563EB', marginBottom: '0.5rem', display: 'block', fontWeight: 600 }}>🌐 Agregar URL / Stream</label>
                  <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
                    <div style={s.formGroup}><label style={s.label}>Nombre</label><input style={{ ...s.input, width: '180px' }} value={urlName} onChange={e => setUrlName(e.target.value)} placeholder="Stream Noticias" /></div>
                    <div style={s.formGroup}><label style={s.label}>URL</label><input style={{ ...s.input, width: '260px' }} value={urlValue} onChange={e => setUrlValue(e.target.value)} placeholder="https://..." /></div>
                    <div style={s.formGroup}><label style={s.label}>Duración (seg)</label><input style={{ ...s.input, width: '80px' }} type="number" min={5} value={urlDuration} onChange={e => setUrlDuration(+e.target.value)} /></div>
                    <div style={s.formGroup}><label style={s.label}>Rep/día (0=∞)</label><input style={{ ...s.input, width: '80px' }} type="number" min={0} value={urlFreq} onChange={e => setUrlFreq(+e.target.value)} /></div>
                  </div>
                  <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem' }}>
                    <button style={s.btnPrimary} onClick={handleAddUrl}>Agregar</button>
                    <button style={s.btnOutline} onClick={() => setShowUrlForm(false)}>Cancelar</button>
                  </div>
                </div>
              )}

              {showSubForm && (
                <div style={{ ...s.card, marginBottom: '0.75rem', borderColor: '#FDE68A' }}>
                  <label style={{ ...s.label, color: '#D97706', fontWeight: 600 }}>Nueva sub-playlist</label>
                  <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.4rem' }}>
                    <input style={{ ...s.input, flex: 1 }} value={subName} onChange={e => setSubName(e.target.value)} placeholder="Campaña Cliente A" />
                    <button style={s.btnPrimary} onClick={handleCreateSub}>Crear</button>
                    <button style={s.btnOutline} onClick={() => setShowSubForm(false)}>✕</button>
                  </div>
                </div>
              )}

              {/* Replace library */}
              {showReplaceLibrary && replacingItem && (
                <div style={{ ...s.card, marginBottom: '0.75rem', borderColor: '#A7F3D0' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
                    <label style={{ ...s.label, fontWeight: 700, fontSize: '0.875rem', color: '#0F172A' }}>
                      🔄 Reemplazar: <span style={{ color: '#64748B', fontWeight: 400 }}>{replacingItem.name.slice(0, 35)}...</span>
                    </label>
                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                      <button style={{ ...s.btnSm, color: '#059669', borderColor: '#A7F3D0' }} onClick={() => replaceRef.current?.click()}>↑ Subir nuevo</button>
                      <button style={s.btnOutline} onClick={() => { setShowReplaceLibrary(false); setReplacingItem(null) }}>✕</button>
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', background: '#F8FAFC', border: '1px solid #E2E8F0', borderRadius: '8px', padding: '0.4rem 0.75rem', marginBottom: '0.5rem' }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#94A3B8" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                    <input style={{ border: 'none', outline: 'none', fontSize: '0.85rem', color: '#0F172A', width: '100%', background: 'transparent' }} placeholder="Buscar en biblioteca..." value={replaceLibrarySearch} onChange={e => setReplaceLibrarySearch(e.target.value)} />
                  </div>
                  {libraryLoading ? <p style={{ color: '#94A3B8', fontSize: '0.85rem' }}>Cargando...</p> : (
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))', gap: '0.5rem', maxHeight: '250px', overflowY: 'auto' }}>
                      {library.filter(i => i.name.toLowerCase().includes(replaceLibrarySearch.toLowerCase())).map(libItem => (
                        <div key={libItem.id} onClick={() => handleReplaceFromLibrary(libItem)}
                          style={{ border: '1px solid #E2E8F0', borderRadius: '8px', overflow: 'hidden', cursor: 'pointer', background: '#F8FAFC' }}
                          onMouseEnter={e => (e.currentTarget.style.borderColor = '#10B981')}
                          onMouseLeave={e => (e.currentTarget.style.borderColor = '#E2E8F0')}
                        >
                          <div style={{ height: '65px', background: '#F1F5F9', overflow: 'hidden', position: 'relative' }}>
                            {libItem.type === 'image' ? <img src={getPublicUrl(libItem.storage_path)} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                              : libItem.type === 'video' ? <video src={getPublicUrl(libItem.storage_path)} style={{ width: '100%', height: '100%', objectFit: 'cover' }} preload="metadata" muted onLoadedMetadata={e => { e.currentTarget.currentTime = 1 }} />
                              : <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.5rem' }}>🌐</div>}
                            <div style={{ position: 'absolute', top: '3px', right: '3px', background: libItem.type === 'video' ? '#7C3AED' : '#059669', color: '#fff', fontSize: '0.55rem', padding: '1px 4px', borderRadius: '3px', fontWeight: 700 }}>
                              {libItem.type === 'video' ? 'VID' : 'IMG'}
                            </div>
                          </div>
                          <div style={{ padding: '0.3rem 0.4rem' }}>
                            <p style={{ fontSize: '0.65rem', color: '#0F172A', fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{libItem.name}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  {replacing && <div style={{ marginTop: '0.5rem', height: '5px', background: '#E2E8F0', borderRadius: '999px', overflow: 'hidden' }}><div style={{ height: '100%', width: `${replaceProgress}%`, background: '#10B981', borderRadius: '999px', transition: 'width 0.2s' }} /></div>}
                </div>
              )}

              {/* Library picker */}
              {uploadTarget && showLibrary && (
                <div style={{ ...s.card, marginBottom: '0.75rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
                    <label style={{ ...s.label, fontWeight: 700, fontSize: '0.875rem', color: '#0F172A' }}>📁 Seleccionar de biblioteca</label>
                    <button style={{ ...s.btnSm, color: '#2563EB', borderColor: '#BFDBFE' }} onClick={() => setShowLibrary(false)}>↑ Subir nuevo archivo</button>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', background: '#F8FAFC', border: '1px solid #E2E8F0', borderRadius: '8px', padding: '0.4rem 0.75rem', marginBottom: '0.5rem' }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#94A3B8" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                    <input style={{ border: 'none', outline: 'none', fontSize: '0.85rem', color: '#0F172A', width: '100%', background: 'transparent' }} placeholder="Buscar en biblioteca..." value={librarySearch} onChange={e => setLibrarySearch(e.target.value)} />
                    {librarySearch && <button onClick={() => setLibrarySearch('')} style={{ background: 'none', border: 'none', color: '#94A3B8', cursor: 'pointer', fontSize: '1rem' }}>✕</button>}
                  </div>
                  {libraryLoading ? <p style={{ color: '#94A3B8', fontSize: '0.85rem' }}>Cargando biblioteca...</p> : library.length === 0 ? <p style={{ color: '#94A3B8', fontSize: '0.85rem' }}>No hay archivos.</p> : (
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))', gap: '0.5rem', maxHeight: '280px', overflowY: 'auto' }}>
                      {library.filter(i => i.name.toLowerCase().includes(librarySearch.toLowerCase())).map(item => (
                        <div key={item.id} onClick={() => handleAddFromLibrary(item)}
                          style={{ border: '1px solid #E2E8F0', borderRadius: '8px', overflow: 'hidden', cursor: 'pointer', background: '#F8FAFC' }}
                          onMouseEnter={e => (e.currentTarget.style.borderColor = '#3B82F6')}
                          onMouseLeave={e => (e.currentTarget.style.borderColor = '#E2E8F0')}
                        >
                          <div style={{ height: '65px', background: '#F1F5F9', overflow: 'hidden', position: 'relative' }}>
                            {item.type === 'image' ? <img src={getPublicUrl(item.storage_path)} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                              : item.type === 'video' ? <video src={getPublicUrl(item.storage_path)} style={{ width: '100%', height: '100%', objectFit: 'cover' }} preload="metadata" muted onLoadedMetadata={e => { e.currentTarget.currentTime = 1 }} />
                              : <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.5rem' }}>🌐</div>}
                            <div style={{ position: 'absolute', top: '3px', right: '3px', background: item.type === 'video' ? '#7C3AED' : item.type === 'image' ? '#059669' : '#2563EB', color: '#fff', fontSize: '0.55rem', padding: '1px 4px', borderRadius: '3px', fontWeight: 700 }}>
                              {item.type === 'video' ? 'VID' : item.type === 'image' ? 'IMG' : 'URL'}
                            </div>
                          </div>
                          <div style={{ padding: '0.3rem 0.4rem' }}>
                            <p style={{ fontSize: '0.65rem', color: '#0F172A', fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.name}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Upload form */}
              {uploadTarget && !showLibrary && (
                <div style={{ ...s.card, marginBottom: '0.75rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                    <label style={{ ...s.label, fontWeight: 600 }}>Subir nuevo archivo</label>
                    <button style={{ ...s.btnSm, color: '#2563EB', borderColor: '#BFDBFE' }} onClick={() => { setShowLibrary(true); loadLibrary() }}>📁 Elegir de biblioteca</button>
                  </div>
                  <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'center' }}>
                    <input ref={fileRef} type="file" accept="image/*,video/*" style={s.input} onChange={e => {
                      const f = e.target.files?.[0] ?? null
                      const tooBig = f && fileTooLargeMessage(f)
                      if (tooBig) { setError(tooBig); setFile(null); e.target.value = ''; return }
                      setError(null); setFile(f)
                    }} />
                    {file && !file.type.startsWith('video/') && <input style={{ ...s.input, width: '80px' }} type="number" min={1} max={60} value={duration} onChange={e => setDuration(+e.target.value)} placeholder="seg" />}
                    <button style={{ ...s.btnPrimary, opacity: uploading || !file ? 0.6 : 1 }} onClick={handleUpload} disabled={uploading || !file}>{uploading ? `${progress}%` : 'Subir'}</button>
                    <button style={s.btnOutline} onClick={() => { setUploadTarget(null); setFile(null) }}>✕</button>
                  </div>
                  {uploading && <div style={{ marginTop: '0.5rem', height: '5px', background: '#E2E8F0', borderRadius: '999px', overflow: 'hidden' }}><div style={{ height: '100%', width: `${progress}%`, background: '#3B82F6', borderRadius: '999px', transition: 'width 0.2s' }} /></div>}
                </div>
              )}

              {entries.length === 0 ? (
                <div style={s.emptyBox}><p style={{ color: '#64748B' }}>Playlist vacía. Agrega contenido.</p></div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  {entries.map((entry, idx) => {
                    if (entry.kind === 'item') {
                      const item = entry.item
                      const expired = isExpired(item)
                      return (
                        <div key={item.id} draggable
                          onDragStart={() => { dragIdx.current = idx }}
                          onDragOver={e => { e.preventDefault(); setDragOverIdx(idx) }}
                          onDragLeave={() => setDragOverIdx(null)}
                          onDrop={() => { if (dragIdx.current !== null) { dragDropEntry(dragIdx.current, idx); dragIdx.current = null } setDragOverIdx(null) }}
                          onDragEnd={() => { dragIdx.current = null; setDragOverIdx(null) }}
                          style={{ ...s.playlistItem, border: dragOverIdx === idx ? '1px solid #3B82F6' : expired ? '1px solid #FECACA' : '1px solid #E2E8F0', opacity: expired ? 0.6 : 1, cursor: 'grab' }}>
                          <span style={s.dragHandle}>⠿</span>
                          <div style={s.thumb}>{renderThumb(item)}</div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap' }}>
                              <div style={{ color: '#0F172A', fontSize: '0.85rem', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '180px' }}>{item.name}</div>
                              {expired && <span style={{ fontSize: '0.65rem', background: '#FEE2E2', color: '#EF4444', padding: '1px 5px', borderRadius: '4px', flexShrink: 0 }}>VENCIDO</span>}
                              {item.type !== 'url' && (
                                <button onClick={() => { setReplacingItem(item); setShowReplaceLibrary(true); setReplaceLibrarySearch(''); setShowLibrary(false); setUploadTarget(null); loadLibrary() }}
                                  style={{ background: '#F0FDF4', border: '1px solid #A7F3D0', borderRadius: '4px', color: '#059669', fontSize: '0.65rem', padding: '1px 5px', cursor: 'pointer', flexShrink: 0 }}>
                                  {replacing && replacingItem?.id === item.id ? `${replaceProgress}%` : '🔄 Reemplazar'}
                                </button>
                              )}
                              {item.type === 'url' && editingUrl !== item.id && (
                                <button onClick={() => { setEditingUrl(item.id); setEditUrlValue((item as any).url ?? ''); setEditUrlName(item.name); setEditUrlDuration(item.duration_seconds ?? 30) }}
                                  style={{ background: '#EFF6FF', border: '1px solid #BFDBFE', borderRadius: '4px', color: '#2563EB', fontSize: '0.65rem', padding: '1px 5px', cursor: 'pointer', flexShrink: 0 }}>Editar URL</button>
                              )}
                            </div>
                            {editingUrl === item.id && (
                              <div style={{ marginTop: '0.4rem', display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                                <input style={{ ...s.input, fontSize: '0.8rem', padding: '0.25rem 0.4rem' }} value={editUrlName} onChange={e => setEditUrlName(e.target.value)} placeholder="Nombre" />
                                <input style={{ ...s.input, fontSize: '0.8rem', padding: '0.25rem 0.4rem' }} value={editUrlValue} onChange={e => setEditUrlValue(e.target.value)} placeholder="https://..." />
                                <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
                                  <input type="number" min={5} style={{ ...s.input, width: '70px', fontSize: '0.8rem', padding: '0.25rem 0.4rem' }} value={editUrlDuration} onChange={e => setEditUrlDuration(+e.target.value)} />
                                  <span style={{ color: '#64748B', fontSize: '0.75rem' }}>seg</span>
                                  <button style={{ ...s.btnPrimary, padding: '0.25rem 0.6rem', fontSize: '0.75rem' }} onClick={() => handleSaveUrl(item.id)}>Guardar</button>
                                  <button style={{ ...s.btnOutline, padding: '0.25rem 0.6rem', fontSize: '0.75rem' }} onClick={() => setEditingUrl(null)}>✕</button>
                                </div>
                              </div>
                            )}
                            <div style={{ color: '#94A3B8', fontSize: '0.75rem', marginTop: '0.1rem' }}>{itemMetaLabel(item, idx)}</div>
                            {editingFreq === item.id ? (
                              <div style={{ display: 'flex', gap: '0.4rem', marginTop: '0.3rem', alignItems: 'center', flexWrap: 'wrap' }}>
                                <input type="number" min={0} value={freqValue} onChange={e => setFreqValue(+e.target.value)} style={{ ...s.input, width: '70px', padding: '0.2rem 0.4rem', fontSize: '0.8rem' }} />
                                <span style={{ color: '#64748B', fontSize: '0.72rem' }}>0=∞</span>
                                <button style={{ ...s.btnPrimary, padding: '0.2rem 0.5rem', fontSize: '0.75rem' }} onClick={() => handleSaveFreq(item.id, 'media_content')}>OK</button>
                                <button style={{ ...s.btnOutline, padding: '0.2rem 0.5rem', fontSize: '0.75rem' }} onClick={() => setEditingFreq(null)}>✕</button>
                              </div>
                            ) : (
                              <button onClick={() => { setEditingFreq(item.id); setFreqValue(item.daily_frequency ?? 0) }} style={s.freqBtn}>{freqLabel(item)}</button>
                            )}
                            {editingExpiry === item.id ? (
                              <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginTop: '0.25rem', flexWrap: 'wrap' }}>
                                <input type="date" value={expiryValue} onChange={e => setExpiryValue(e.target.value)} style={{ ...s.input, padding: '0.2rem 0.4rem', fontSize: '0.8rem' }} />
                                <button style={{ ...s.btnPrimary, padding: '0.2rem 0.5rem', fontSize: '0.75rem' }} onClick={() => handleSaveExpiry(item.id)}>OK</button>
                                <button style={{ ...s.btnOutline, padding: '0.2rem 0.5rem', fontSize: '0.75rem' }} onClick={() => setEditingExpiry(null)}>✕</button>
                                {item.expires_at && <button style={{ ...s.btnSmDanger, padding: '0.2rem 0.5rem', fontSize: '0.72rem' }} onClick={async () => { await supabase.from('media_content').update({ expires_at: null }).eq('id', item.id); setEditingExpiry(null); loadEntries(selectedZone!) }}>Quitar</button>}
                              </div>
                            ) : (
                              <button onClick={() => { setEditingExpiry(item.id); setExpiryValue(item.expires_at ?? '') }}
                                style={{ marginTop: '0.2rem', background: 'transparent', border: '1px solid #E2E8F0', borderRadius: '4px', fontSize: '0.72rem', padding: '0.15rem 0.5rem', cursor: 'pointer', color: expired ? '#EF4444' : item.expires_at ? '#D97706' : '#94A3B8' }}>
                                {item.expires_at ? expired ? `⛔ Venció: ${new Date(item.expires_at).toLocaleDateString('es-DO')}` : `📅 Vence: ${new Date(item.expires_at).toLocaleDateString('es-DO')}` : '📅 Sin vencimiento'}
                              </button>
                            )}
                          </div>
                          <button style={s.btnSmDanger} onClick={() => handleDeleteItem(item)}>✕</button>
                        </div>
                      )
                    }
                    const sub = entry.sub; const subItems = entry.items
                    return (
                      <div key={sub.id} draggable
                        onDragStart={() => { dragIdx.current = idx }}
                        onDragOver={e => { e.preventDefault(); setDragOverIdx(idx) }}
                        onDragLeave={() => setDragOverIdx(null)}
                        onDrop={() => { if (dragIdx.current !== null) { dragDropEntry(dragIdx.current, idx); dragIdx.current = null } setDragOverIdx(null) }}
                        onDragEnd={() => { dragIdx.current = null; setDragOverIdx(null) }}
                        style={{ border: dragOverIdx === idx ? '2px solid #3B82F6' : '1px solid #FDE68A', borderRadius: '10px', overflow: 'hidden', background: '#FFFBEB' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.6rem 0.75rem', background: '#FEF3C7', flexWrap: 'wrap', gap: '0.5rem' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                            <span style={s.dragHandle}>⠿</span>
                            <span style={{ background: '#D97706', color: '#fff', fontSize: '0.65rem', padding: '1px 6px', borderRadius: '4px', fontWeight: 700 }}>SUB</span>
                            <span style={{ color: '#92400E', fontWeight: 700, fontSize: '0.9rem' }}>{sub.name}</span>
                          </div>
                          <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
                            {editingFreq === sub.id ? (
                              <>
                                <input type="number" min={0} value={freqValue} onChange={e => setFreqValue(+e.target.value)} style={{ ...s.input, width: '70px', padding: '0.2rem 0.4rem', fontSize: '0.8rem' }} />
                                <button style={{ ...s.btnPrimary, padding: '0.2rem 0.5rem', fontSize: '0.75rem' }} onClick={() => handleSaveFreq(sub.id, 'sub_playlists')}>OK</button>
                                <button style={{ ...s.btnOutline, padding: '0.2rem 0.5rem', fontSize: '0.75rem' }} onClick={() => setEditingFreq(null)}>✕</button>
                              </>
                            ) : (
                              <button onClick={() => { setEditingFreq(sub.id); setFreqValue(sub.daily_frequency ?? 0) }} style={s.freqBtn}>{freqLabel(sub)}</button>
                            )}
                            <button style={{ ...s.btnSm, color: '#D97706', borderColor: '#FDE68A' }} onClick={e => { e.stopPropagation(); setUploadTarget({ type: 'sub', id: sub.id }); setShowLibrary(true); setShowReplaceLibrary(false); loadLibrary() }}>+ Video</button>
                            <button style={s.btnSmDanger} onClick={e => { e.stopPropagation(); handleDeleteSub(sub.id) }}>✕</button>
                          </div>
                        </div>
                        <div style={{ padding: '0.5rem 0.75rem', display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                          {subItems.length === 0 ? <p style={{ color: '#94A3B8', fontSize: '0.8rem' }}>Sin videos.</p>
                            : subItems.map((si, siIdx) => (
                              <div key={si.id} draggable
                                onDragStart={e => { e.stopPropagation(); subDragIdx.current = { subId: sub.id, idx: siIdx } }}
                                onDragOver={e => { e.preventDefault(); e.stopPropagation(); setSubDragOver({ subId: sub.id, idx: siIdx }) }}
                                onDragLeave={() => setSubDragOver(null)}
                                onDrop={e => { e.stopPropagation(); if (subDragIdx.current) { dragDropSubItem(subItems, subDragIdx.current.idx, siIdx); subDragIdx.current = null } setSubDragOver(null) }}
                                onDragEnd={() => { subDragIdx.current = null; setSubDragOver(null) }}
                                style={{ ...s.playlistItem, outline: subDragOver?.subId === sub.id && subDragOver?.idx === siIdx ? '1px solid #D97706' : 'none', cursor: 'grab' }}>
                                <span style={s.dragHandle}>⠿</span>
                                <div style={{ ...s.thumb, width: '48px', height: '30px' }}>{renderThumb(si)}</div>
                                <div style={{ flex: 1, minWidth: 0 }}>
                                  <div style={{ color: '#0F172A', fontSize: '0.85rem', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{si.name}</div>
                                  <div style={{ color: '#94A3B8', fontSize: '0.75rem' }}>Video {siIdx + 1} de {subItems.length} · Round Robin</div>
                                </div>
                                <button style={s.btnSmDanger} onClick={() => handleDeleteItem(si)}>✕</button>
                              </div>
                            ))}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  topbar: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1.5rem', flexWrap: 'wrap', gap: '1rem' },
  title: { fontSize: '1.25rem', fontWeight: 700, color: '#0F172A' },
  sub: { color: '#64748B', fontSize: '0.8rem', marginTop: '0.2rem' },
  sectionLabel: { color: '#64748B', fontSize: '0.8rem', fontWeight: 600, marginBottom: '0.5rem', textTransform: 'uppercase' as const, letterSpacing: '0.05em' },
  btnPrimary: { display: 'flex', alignItems: 'center', gap: '0.35rem', padding: '0.55rem 1rem', borderRadius: '8px', border: 'none', background: '#3B82F6', color: '#fff', fontWeight: 600, fontSize: '0.875rem', cursor: 'pointer', whiteSpace: 'nowrap' as const },
  btnOutline: { padding: '0.55rem 1rem', borderRadius: '8px', border: '1px solid #E2E8F0', background: '#fff', color: '#64748B', fontWeight: 500, fontSize: '0.875rem', cursor: 'pointer' },
  btnBack: { padding: '0.45rem 0.875rem', borderRadius: '8px', border: '1px solid #E2E8F0', background: '#fff', color: '#64748B', fontSize: '0.85rem', cursor: 'pointer' },
  btnPublish: { padding: '0.55rem 1rem', borderRadius: '8px', border: 'none', background: '#2563EB', color: '#fff', fontWeight: 600, fontSize: '0.875rem', cursor: 'pointer' },
  btnSm: { padding: '0.3rem 0.7rem', borderRadius: '6px', border: '1px solid #E2E8F0', background: '#fff', color: '#64748B', fontSize: '0.78rem', fontWeight: 500, cursor: 'pointer' },
  btnSmDanger: { padding: '0.3rem 0.6rem', borderRadius: '6px', border: '1px solid #FECACA', background: '#FFF5F5', color: '#EF4444', fontSize: '0.78rem', cursor: 'pointer', flexShrink: 0 },
  card: { background: '#fff', border: '1px solid #E2E8F0', borderRadius: '12px', padding: '1.25rem', marginBottom: '1.25rem', boxShadow: '0 1px 4px rgba(0,0,0,0.04)' },
  cardTitle: { fontWeight: 700, color: '#0F172A', marginBottom: '1rem', fontSize: '1rem' },
  formRow: { display: 'flex', gap: '1.25rem', flexWrap: 'wrap' as const, marginBottom: '0.75rem' },
  formGroup: { display: 'flex', flexDirection: 'column' as const, gap: '0.3rem' },
  label: { color: '#64748B', fontSize: '0.8rem', fontWeight: 500 },
  input: { padding: '0.5rem 0.75rem', borderRadius: '8px', border: '1px solid #E2E8F0', background: '#fff', color: '#0F172A', fontSize: '0.875rem', outline: 'none' },
  radioLabel: { display: 'flex', alignItems: 'center', gap: '0.4rem', color: '#0F172A', fontSize: '0.85rem', cursor: 'pointer' },
  emptyBox: { background: '#F8FAFC', border: '1px dashed #E2E8F0', borderRadius: '10px', padding: '1.5rem', textAlign: 'center' as const },
  layout: { display: 'flex', gap: '2rem', flexWrap: 'wrap' as const, alignItems: 'flex-start' },
  zoneCard: { borderRadius: '8px', padding: '0.75rem', cursor: 'pointer' },
  playlistItem: { display: 'flex', alignItems: 'center', gap: '0.75rem', background: '#fff', borderRadius: '8px', padding: '0.6rem 0.75rem' },
  thumb: { width: '64px', height: '40px', borderRadius: '4px', overflow: 'hidden', background: '#F1F5F9', flexShrink: 0 },
  freqBtn: { marginTop: '0.2rem', background: '#F8FAFC', border: '1px solid #E2E8F0', borderRadius: '4px', color: '#3B82F6', fontSize: '0.72rem', padding: '0.15rem 0.5rem', cursor: 'pointer' },
  dragHandle: { color: '#CBD5E1', fontSize: '1.1rem', cursor: 'grab', flexShrink: 0, userSelect: 'none' as const },
}