import { useEffect, useState, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { uploadToR2 } from '../lib/uploadToR2'
import { resolveMediaUrl } from '../lib/mediaUrl'
import { deleteMediaFileIfUnused } from '../lib/deleteMediaFile'
import { checkStorageFits, notifyStorageChanged } from '../lib/storage'
import { fileTooLargeMessage, MAX_FILE_MB } from '../lib/fileLimit'
import { dedupeMedia } from '../lib/dedupeMedia'
import { useAuth } from '../auth/AuthContext'
import { useDialog } from '../components/Dialog'

type MediaItem = {
  id: string; name: string; type: 'image' | 'video' | 'url'
  storage_path: string; duration_seconds: number | null
  zone_id: string | null; created_at: string
}
type Zone = { id: string; name: string; program_name: string }
type Tag  = { id: string; name: string; color: string }
type DeleteDlg = {
  tag: Tag; mode: 'soft' | 'hard'; confirmText: string
  working: boolean; done: number; total: number
  stats: { fileCount: number; zoneCount: number } | null
}

const TAG_COLORS = ['#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899', '#06B6D4', '#64748B']

export default function Content() {
  const { profile } = useAuth()
  const { confirm } = useDialog()

  // Media state
  const [orgId, setOrgId]     = useState('')
  const [items, setItems]     = useState<MediaItem[]>([])
  const [zones, setZones]     = useState<Zone[]>([])
  const [loading, setLoading] = useState(true)
  const [durations, setDurations] = useState<Record<string, number>>({})

  // Upload form state
  const [showForm, setShowForm]       = useState(false)
  const [selectedZone, setSelectedZone] = useState('')
  const [duration, setDuration]       = useState(10)
  const [file, setFile]               = useState<File | null>(null)
  const [uploading, setUploading]     = useState(false)
  const [progress, setProgress]       = useState(0)
  const [error, setError]             = useState<string | null>(null)
  const [search, setSearch]           = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  // Tag state
  const [tags, setTags]               = useState<Tag[]>([])
  const [itemTagMap, setItemTagMap]   = useState<Record<string, Tag[]>>({})
  const [activeTagId, setActiveTagId] = useState<string | null>(null)
  const [tagPanelOpen, setTagPanelOpen] = useState(false)
  const [tagForm, setTagForm] = useState({ open: false, name: '', color: TAG_COLORS[0] })
  const [editingTag, setEditingTag]   = useState<{ id: string; name: string } | null>(null)
  const [tagDropdownOpen, setTagDropdownOpen] = useState<string | null>(null)
  const [deleteDlg, setDeleteDlg]     = useState<DeleteDlg | null>(null)

  // ── LOAD ────────────────────────────────────────────────────────────────
  async function load() {
    setLoading(true)
    const { data: pd } = await supabase.from('profiles').select('organization_id').eq('id', profile?.id ?? '').single()
    const oid = pd?.organization_id ?? ''
    setOrgId(oid)

    const [{ data: mediaData }, { data: zoneData }, { data: tagData }] = await Promise.all([
      supabase.from('media_content').select('*').is('campaign_id', null).is('archived_at', null).order('created_at', { ascending: false }),
      supabase.from('zones').select('id, name, programs(name)'),
      supabase.from('media_tags').select('id, name, color').eq('organization_id', oid).order('name'),
    ])

    const dedupedItems = dedupeMedia((mediaData ?? []) as MediaItem[])
    const ids = dedupedItems.map(m => m.id)

    let newTagMap: Record<string, Tag[]> = {}
    if (ids.length > 0) {
      const { data: links } = await supabase
        .from('media_content_tags')
        .select('media_content_id, media_tags(id, name, color)')
        .in('media_content_id', ids)
      for (const link of (links ?? [])) {
        const t = (link as any).media_tags
        if (!t) continue
        const prev = newTagMap[link.media_content_id] ?? []
        newTagMap[link.media_content_id] = [...prev, t]
      }
    }

    setItems(dedupedItems)
    setZones((zoneData ?? []).map((z: any) => ({ id: z.id, name: z.name, program_name: z.programs?.name ?? '' })))
    setTags((tagData ?? []) as Tag[])
    setItemTagMap(newTagMap)
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  // ── UPLOAD ──────────────────────────────────────────────────────────────
  async function handleUpload() {
    if (!file) { setError('Selecciona un archivo.'); return }
    const tooBig = fileTooLargeMessage(file)
    if (tooBig) { setError(tooBig); return }
    setUploading(true); setError(null)
    const fits = await checkStorageFits(file.size)
    if (!fits.ok) { setError(fits.message ?? 'Sin espacio disponible.'); setUploading(false); return }
    const isVideo = file.type.startsWith('video/')
    const { url, size, error: storageError } = await uploadToR2(file, setProgress)
    if (storageError || !url) { setError('Error al subir: ' + (storageError?.message ?? 'desconocido')); setUploading(false); return }
    const { error: insertError } = await supabase.from('media_content').insert({
      zone_id: selectedZone || null, name: file.name,
      type: isVideo ? 'video' : 'image', storage_path: url,
      duration_seconds: isVideo ? null : duration,
      uploaded_by: profile?.id, file_size_bytes: size ?? file.size,
      organization_id: orgId || null,
    })
    if (insertError) { setError('Error al guardar: ' + insertError.message); setUploading(false); return }
    setFile(null); setProgress(0); setUploading(false); setDuration(10)
    setSelectedZone(''); setShowForm(false)
    if (fileRef.current) fileRef.current.value = ''
    notifyStorageChanged(); load()
  }

  // ── DELETE MEDIA ────────────────────────────────────────────────────────
  async function handleDelete(item: MediaItem) {
    if (!await confirm({
      title: `¿Eliminar "${item.name}" de la biblioteca?`,
      message: 'Se quitará de la biblioteca y de las zonas donde esté, y el archivo se eliminará del almacenamiento. Las reproducciones ya registradas se conservan en Estadísticas.',
      confirmLabel: 'Eliminar', danger: true,
    })) return
    const now = new Date().toISOString()
    if (item.type === 'url') {
      await supabase.from('media_content').update({ archived_at: now }).is('campaign_id', null).eq('id', item.id)
      load(); return
    }
    const { data: copies } = await supabase.from('media_content').select('id, storage_path').is('campaign_id', null).eq('name', item.name).eq('type', item.type)
    const rows = copies ?? []
    if (rows.length === 0) { load(); return }
    const ids = rows.map(r => r.id)
    const paths = [...new Set(rows.map(r => r.storage_path).filter(Boolean))] as string[]
    const { data: stats } = await supabase.from('content_stats').select('content_id, total_reproductions').in('content_id', ids)
    const withStats = new Set((stats ?? []).filter(s => Number(s.total_reproductions) > 0).map(s => s.content_id))
    const keepIds = ids.filter(id => withStats.has(id))
    const dropIds = ids.filter(id => !withStats.has(id))
    if (keepIds.length > 0) await supabase.from('media_content').update({ archived_at: now, storage_path: null }).in('id', keepIds)
    if (dropIds.length > 0) await supabase.from('media_content').delete().in('id', dropIds)
    for (const p of paths) await deleteMediaFileIfUnused(p)
    notifyStorageChanged(); load()
  }

  // ── TAG: ASSIGN / UNASSIGN ──────────────────────────────────────────────
  async function handleAssignTag(itemId: string, tagId: string, hasTag: boolean) {
    if (hasTag) {
      await supabase.from('media_content_tags').delete().eq('media_content_id', itemId).eq('tag_id', tagId)
    } else {
      await supabase.from('media_content_tags').insert({ media_content_id: itemId, tag_id: tagId })
    }
    const { data: links } = await supabase
      .from('media_content_tags')
      .select('media_content_id, media_tags(id, name, color)')
      .eq('media_content_id', itemId)
    const newTags = (links ?? []).map((l: any) => l.media_tags).filter(Boolean)
    setItemTagMap(prev => ({ ...prev, [itemId]: newTags }))
  }

  // ── TAG: CREATE ─────────────────────────────────────────────────────────
  async function handleCreateTag() {
    if (!tagForm.name.trim() || !orgId) return
    const { data, error: err } = await supabase.from('media_tags')
      .insert({ organization_id: orgId, name: tagForm.name.trim(), color: tagForm.color })
      .select().single()
    if (err || !data) return
    setTags(prev => [...prev, data as Tag].sort((a, b) => a.name.localeCompare(b.name)))
    setTagForm({ open: false, name: '', color: TAG_COLORS[0] })
  }

  // ── TAG: RENAME ─────────────────────────────────────────────────────────
  async function handleRenameTag() {
    if (!editingTag || !editingTag.name.trim()) return
    const { error: err } = await supabase.from('media_tags').update({ name: editingTag.name.trim() }).eq('id', editingTag.id)
    if (err) return
    const { id, name: newName } = editingTag
    setTags(prev => prev.map(t => t.id === id ? { ...t, name: newName.trim() } : t))
    setItemTagMap(prev => {
      const next = { ...prev }
      for (const k of Object.keys(next)) next[k] = next[k].map(t => t.id === id ? { ...t, name: newName.trim() } : t)
      return next
    })
    setEditingTag(null)
  }

  // ── TAG: OPEN DELETE DIALOG (computes stats async) ──────────────────────
  async function openDeleteDlg(tag: Tag) {
    setDeleteDlg({ tag, mode: 'soft', confirmText: '', working: false, done: 0, total: 0, stats: null })
    // stats for the confirmation text
    const { data: links } = await supabase.from('media_content_tags').select('media_content_id').eq('tag_id', tag.id)
    const repIds = (links ?? []).map((l: any) => l.media_content_id)
    if (repIds.length === 0) { setDeleteDlg(p => p ? { ...p, stats: { fileCount: 0, zoneCount: 0 } } : p); return }
    const { data: reps } = await supabase.from('media_content').select('name, type').in('id', repIds)
    const zoneSet = new Set<string>()
    for (const rep of (reps ?? [])) {
      const { data: copies } = await supabase.from('media_content').select('zone_id').is('campaign_id', null).eq('name', rep.name).eq('type', rep.type).is('archived_at', null).not('zone_id', 'is', null)
      for (const c of (copies ?? [])) if (c.zone_id) zoneSet.add(c.zone_id)
    }
    setDeleteDlg(p => p ? { ...p, stats: { fileCount: (reps ?? []).length, zoneCount: zoneSet.size } } : p)
  }

  // ── TAG: CONFIRM DELETE ─────────────────────────────────────────────────
  async function handleDeleteTag() {
    if (!deleteDlg) return
    const { tag, mode } = deleteDlg
    setDeleteDlg(p => p ? { ...p, working: true } : p)

    if (mode === 'hard') {
      const { data: links } = await supabase.from('media_content_tags').select('media_content_id').eq('tag_id', tag.id)
      const repIds = (links ?? []).map((l: any) => l.media_content_id)
      const { data: reps } = await supabase.from('media_content').select('id, name, type').in('id', repIds)
      const total = (reps ?? []).length
      setDeleteDlg(p => p ? { ...p, total } : p)
      const now = new Date().toISOString()

      for (let i = 0; i < (reps ?? []).length; i++) {
        const rep = reps![i]
        const { data: copies } = await supabase.from('media_content').select('id, storage_path').is('campaign_id', null).eq('name', rep.name).eq('type', rep.type).is('archived_at', null)
        const rows = copies ?? []
        const ids  = rows.map(r => r.id)
        const paths = [...new Set(rows.map(r => r.storage_path).filter(Boolean))] as string[]
        if (ids.length > 0) {
          const { data: st } = await supabase.from('content_stats').select('content_id, total_reproductions').in('content_id', ids)
          const withStats = new Set((st ?? []).filter(s => Number(s.total_reproductions) > 0).map(s => s.content_id))
          const keepIds = ids.filter(id => withStats.has(id))
          const dropIds = ids.filter(id => !withStats.has(id))
          if (keepIds.length > 0) await supabase.from('media_content').update({ archived_at: now, storage_path: null }).in('id', keepIds)
          if (dropIds.length > 0) await supabase.from('media_content').delete().in('id', dropIds)
          for (const p of paths) await deleteMediaFileIfUnused(p)
        }
        setDeleteDlg(p => p ? { ...p, done: i + 1 } : p)
      }
      notifyStorageChanged()
    }

    // Cascade from media_tags → media_content_tags (FK ON DELETE CASCADE)
    await supabase.from('media_tags').delete().eq('id', tag.id)
    setTags(prev => prev.filter(t => t.id !== tag.id))
    if (activeTagId === tag.id) setActiveTagId(null)
    setDeleteDlg(null)
    load()
  }

  // ── DERIVED STATE ────────────────────────────────────────────────────────
  const getPublicUrl = resolveMediaUrl

  const filtered = items.filter(item => {
    const matchSearch = item.name.toLowerCase().includes(search.toLowerCase())
    const matchTag    = !activeTagId || (itemTagMap[item.id] ?? []).some(t => t.id === activeTagId)
    return matchSearch && matchTag
  })

  const tagCounts = tags.reduce<Record<string, number>>((acc, tag) => {
    acc[tag.id] = items.filter(i => (itemTagMap[i.id] ?? []).some(t => t.id === tag.id)).length
    return acc
  }, {})

  // ── RENDER ───────────────────────────────────────────────────────────────
  return (
    <div>
      {/* Click-outside overlay for tag assignment dropdown */}
      {tagDropdownOpen && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 9 }} onClick={() => setTagDropdownOpen(null)} />
      )}

      {/* Delete tag modal */}
      {deleteDlg && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.45)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#fff', borderRadius: '14px', padding: '1.75rem', width: '420px', maxWidth: '92vw', boxShadow: '0 20px 60px rgba(0,0,0,0.2)' }}>
            {deleteDlg.working ? (
              <div style={{ textAlign: 'center', padding: '0.5rem 0 1rem' }}>
                <div style={{ fontWeight: 700, color: '#0F172A', marginBottom: '0.75rem', fontSize: '1rem' }}>
                  {deleteDlg.mode === 'hard' ? 'Eliminando archivos...' : 'Eliminando etiqueta...'}
                </div>
                {deleteDlg.mode === 'hard' && deleteDlg.total > 0 && (
                  <>
                    <div style={{ background: '#F1F5F9', borderRadius: '999px', height: '7px', overflow: 'hidden', marginBottom: '0.6rem' }}>
                      <div style={{ height: '100%', background: '#EF4444', borderRadius: '999px', transition: 'width 0.3s', width: `${Math.round((deleteDlg.done / deleteDlg.total) * 100)}%` }} />
                    </div>
                    <div style={{ color: '#64748B', fontSize: '0.85rem' }}>{deleteDlg.done} / {deleteDlg.total} archivos procesados</div>
                  </>
                )}
              </div>
            ) : (
              <>
                <h3 style={{ fontSize: '1.1rem', fontWeight: 700, color: '#0F172A', marginBottom: '0.35rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  Eliminar etiqueta
                  <span style={{ width: '12px', height: '12px', borderRadius: '50%', background: deleteDlg.tag.color, display: 'inline-block', flexShrink: 0 }} />
                  <span style={{ fontStyle: 'italic', color: '#64748B', fontWeight: 500 }}>"{deleteDlg.tag.name}"</span>
                </h3>
                <p style={{ color: '#64748B', fontSize: '0.85rem', marginBottom: '1.25rem' }}>
                  {deleteDlg.stats
                    ? <>Esta etiqueta tiene <strong>{deleteDlg.stats.fileCount}</strong> {deleteDlg.stats.fileCount === 1 ? 'archivo' : 'archivos'}{deleteDlg.stats.zoneCount > 0 ? ` colocado${deleteDlg.stats.fileCount === 1 ? '' : 's'} en ${deleteDlg.stats.zoneCount} ${deleteDlg.stats.zoneCount === 1 ? 'zona' : 'zonas'}` : ''}.</>
                    : 'Calculando archivos...'}
                </p>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.625rem', marginBottom: '1.25rem' }}>
                  {([
                    ['soft', 'Solo eliminar la etiqueta', 'Los archivos se conservan en la biblioteca y en sus zonas.'],
                    ['hard', 'Eliminar etiqueta y todos sus archivos', 'Los archivos se quitan de todas las zonas y se eliminan del almacenamiento. No se puede deshacer.'],
                  ] as [string, string, string][]).map(([val, label, desc]) => (
                    <label key={val} style={{ display: 'flex', gap: '0.625rem', cursor: 'pointer', padding: '0.625rem', borderRadius: '8px', border: `1.5px solid ${deleteDlg.mode === val ? (val === 'hard' ? '#EF4444' : '#3B82F6') : '#E2E8F0'}`, background: deleteDlg.mode === val ? (val === 'hard' ? '#FFF5F5' : '#EFF6FF') : '#fff' }}>
                      <input type="radio" name="delMode" value={val} checked={deleteDlg.mode === (val as any)} onChange={() => setDeleteDlg(p => p ? { ...p, mode: val as any, confirmText: '' } : p)} style={{ marginTop: '2px', flexShrink: 0 }} />
                      <div>
                        <div style={{ fontSize: '0.875rem', fontWeight: 600, color: val === 'hard' ? '#EF4444' : '#0F172A' }}>{label}</div>
                        <div style={{ fontSize: '0.78rem', color: '#64748B', marginTop: '2px' }}>{desc}</div>
                      </div>
                    </label>
                  ))}
                </div>

                {deleteDlg.mode === 'hard' && (
                  <div style={{ marginBottom: '1.25rem' }}>
                    <label style={{ display: 'block', fontSize: '0.8rem', color: '#64748B', marginBottom: '0.35rem' }}>
                      Escribe <strong>ELIMINAR</strong> para confirmar:
                    </label>
                    <input
                      autoFocus
                      style={{ width: '100%', padding: '0.55rem 0.75rem', borderRadius: '8px', border: '1.5px solid #EF4444', background: '#fff', color: '#0F172A', fontSize: '0.875rem', outline: 'none', boxSizing: 'border-box' }}
                      value={deleteDlg.confirmText}
                      onChange={e => setDeleteDlg(p => p ? { ...p, confirmText: e.target.value } : p)}
                      placeholder="ELIMINAR"
                    />
                  </div>
                )}

                <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end' }}>
                  <button style={s.btnOutline} onClick={() => setDeleteDlg(null)}>Cancelar</button>
                  <button
                    style={{ ...s.btnPrimary, background: deleteDlg.mode === 'hard' ? '#EF4444' : '#3B82F6', opacity: deleteDlg.mode === 'hard' && deleteDlg.confirmText !== 'ELIMINAR' ? 0.45 : 1 }}
                    disabled={deleteDlg.mode === 'hard' && deleteDlg.confirmText !== 'ELIMINAR'}
                    onClick={handleDeleteTag}
                  >
                    {deleteDlg.mode === 'hard' ? 'Eliminar todo' : 'Eliminar etiqueta'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Topbar */}
      <div style={s.topbar} className="page-topbar">
        <div>
          <h1 style={s.title}>Contenido</h1>
          <p style={s.sub}>Sube imágenes y videos a tus zonas · {items.length} archivos</p>
        </div>
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={s.searchWrap}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#94A3B8" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            <input style={s.searchInput} placeholder="Buscar archivo..." value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          <button
            style={{ ...s.btnOutline, background: tagPanelOpen ? '#EFF6FF' : '#fff', borderColor: tagPanelOpen ? '#BFDBFE' : '#E2E8F0', color: tagPanelOpen ? '#2563EB' : '#64748B' }}
            onClick={() => { setTagPanelOpen(p => !p); if (tagPanelOpen) setActiveTagId(null) }}>
            🏷 Etiquetas{tags.length > 0 ? ` (${tags.length})` : ''}
          </button>
          <button style={s.btnPrimary} onClick={() => setShowForm(!showForm)}>+ Subir archivo</button>
        </div>
      </div>

      {/* Upload form */}
      {showForm && (
        <div style={s.formCard}>
          <h3 style={s.formTitle}>Subir archivo</h3>
          <div style={s.formRow}>
            <div style={s.formGroup}>
              <label style={s.label}>Zona destino <span style={{ color: '#94A3B8', fontWeight: 400 }}>(opcional)</span></label>
              <select style={s.input} value={selectedZone} onChange={e => setSelectedZone(e.target.value)}>
                <option value="">— Solo biblioteca, sin zona —</option>
                {zones.map(z => <option key={z.id} value={z.id}>{z.program_name} → {z.name}</option>)}
              </select>
            </div>
            <div style={s.formGroup}>
              <label style={s.label}>Archivo (imagen o video) <span style={{ color: '#94A3B8', fontWeight: 400 }}>(máx. {MAX_FILE_MB} MB)</span></label>
              <input ref={fileRef} type="file" accept="image/*,video/*" style={s.input} onChange={e => {
                const f = e.target.files?.[0] ?? null
                const tooBig = f && fileTooLargeMessage(f)
                if (tooBig) { setError(tooBig); setFile(null); if (fileRef.current) fileRef.current.value = ''; return }
                setError(null); setFile(f)
              }} />
            </div>
            {file && !file.type.startsWith('video/') && (
              <div style={s.formGroup}>
                <label style={s.label}>Duración (seg)</label>
                <input style={{ ...s.input, width: '100px' }} type="number" min={1} max={60} value={duration} onChange={e => setDuration(+e.target.value)} />
              </div>
            )}
          </div>
          {uploading && (
            <div style={{ marginBottom: '0.75rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.35rem' }}>
                <span style={{ color: '#64748B', fontSize: '0.8rem' }}>Subiendo...</span>
                <span style={{ color: '#3B82F6', fontSize: '0.8rem', fontWeight: 600 }}>{progress}%</span>
              </div>
              <div style={{ height: '5px', background: '#E2E8F0', borderRadius: '999px', overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${progress}%`, background: '#3B82F6', borderRadius: '999px', transition: 'width 0.2s' }} />
              </div>
            </div>
          )}
          {error && <p style={{ color: '#EF4444', fontSize: '0.8rem', marginBottom: '0.75rem' }}>{error}</p>}
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button style={{ ...s.btnPrimary, opacity: uploading || !file ? 0.6 : 1 }} onClick={handleUpload} disabled={uploading || !file}>
              {uploading ? `Subiendo ${progress}%...` : 'Subir archivo'}
            </button>
            <button style={s.btnOutline} onClick={() => setShowForm(false)}>Cancelar</button>
          </div>
        </div>
      )}

      {/* Main content: tag panel + table */}
      <div style={{ display: 'flex', gap: '1.25rem', alignItems: 'flex-start' }}>

        {/* ── Tag panel ── */}
        {tagPanelOpen && (
          <div style={{ width: '220px', flexShrink: 0, background: '#fff', border: '1px solid #E2E8F0', borderRadius: '12px', padding: '1rem', boxShadow: '0 1px 4px rgba(0,0,0,0.04)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
              <span style={{ fontWeight: 700, color: '#0F172A', fontSize: '0.9rem' }}>Etiquetas</span>
              <button onClick={() => setTagForm(f => ({ ...f, open: !f.open, name: '', color: TAG_COLORS[0] }))}
                style={{ background: '#EFF6FF', border: 'none', borderRadius: '6px', color: '#2563EB', fontSize: '0.75rem', fontWeight: 600, padding: '3px 8px', cursor: 'pointer' }}>
                + Nueva
              </button>
            </div>

            {tagForm.open && (
              <div style={{ marginBottom: '0.75rem', padding: '0.75rem', background: '#F8FAFC', borderRadius: '8px', border: '1px solid #E2E8F0' }}>
                <input
                  autoFocus
                  style={{ width: '100%', padding: '0.4rem 0.6rem', borderRadius: '7px', border: '1px solid #E2E8F0', background: '#fff', color: '#0F172A', fontSize: '0.82rem', outline: 'none', marginBottom: '0.5rem', boxSizing: 'border-box' }}
                  placeholder="Nombre de etiqueta..."
                  value={tagForm.name}
                  onChange={e => setTagForm(f => ({ ...f, name: e.target.value }))}
                  onKeyDown={e => { if (e.key === 'Enter') handleCreateTag(); if (e.key === 'Escape') setTagForm({ open: false, name: '', color: TAG_COLORS[0] }) }}
                />
                <div style={{ display: 'flex', gap: '5px', marginBottom: '0.5rem', flexWrap: 'wrap' }}>
                  {TAG_COLORS.map(c => (
                    <button key={c} onClick={() => setTagForm(f => ({ ...f, color: c }))}
                      style={{ width: '20px', height: '20px', borderRadius: '50%', background: c, border: `2px solid ${tagForm.color === c ? '#0F172A' : 'transparent'}`, cursor: 'pointer', padding: 0, flexShrink: 0 }} />
                  ))}
                </div>
                <div style={{ display: 'flex', gap: '0.4rem' }}>
                  <button onClick={handleCreateTag}
                    style={{ flex: 1, padding: '0.35rem', borderRadius: '6px', border: 'none', background: tagForm.color, color: '#fff', fontWeight: 600, fontSize: '0.75rem', cursor: 'pointer' }}>
                    Crear
                  </button>
                  <button onClick={() => setTagForm({ open: false, name: '', color: TAG_COLORS[0] })}
                    style={{ padding: '0.35rem 0.6rem', borderRadius: '6px', border: '1px solid #E2E8F0', background: '#fff', color: '#64748B', fontSize: '0.75rem', cursor: 'pointer' }}>
                    ✕
                  </button>
                </div>
              </div>
            )}

            {/* "Todos" filter */}
            <button onClick={() => setActiveTagId(null)}
              style={{ width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.4rem 0.5rem', borderRadius: '6px', border: 'none', background: !activeTagId ? '#F1F5F9' : 'transparent', cursor: 'pointer', marginBottom: '0.25rem' }}>
              <span style={{ fontSize: '0.82rem', fontWeight: !activeTagId ? 700 : 400, color: '#0F172A' }}>Todos</span>
              <span style={{ fontSize: '0.7rem', color: '#94A3B8', background: '#F1F5F9', borderRadius: '999px', padding: '1px 6px' }}>{items.length}</span>
            </button>

            {tags.length > 0 && <div style={{ height: '1px', background: '#F1F5F9', margin: '0.35rem 0' }} />}

            {tags.length === 0 ? (
              <p style={{ color: '#94A3B8', fontSize: '0.78rem', textAlign: 'center', padding: '0.5rem 0' }}>Sin etiquetas aún.</p>
            ) : tags.map(tag => (
              <div key={tag.id} style={{ marginBottom: '1px' }}>
                {editingTag?.id === tag.id ? (
                  <div style={{ display: 'flex', gap: '0.3rem', alignItems: 'center', padding: '0.2rem 0.25rem' }}>
                    <span style={{ width: '9px', height: '9px', borderRadius: '50%', background: tag.color, flexShrink: 0 }} />
                    <input
                      autoFocus
                      style={{ flex: 1, padding: '0.2rem 0.4rem', borderRadius: '5px', border: '1px solid #E2E8F0', fontSize: '0.78rem', outline: 'none', minWidth: 0 }}
                      value={editingTag.name}
                      onChange={e => setEditingTag(p => p ? { ...p, name: e.target.value } : null)}
                      onKeyDown={e => { if (e.key === 'Enter') handleRenameTag(); if (e.key === 'Escape') setEditingTag(null) }}
                    />
                    <button onClick={handleRenameTag} style={{ padding: '0.15rem 0.35rem', borderRadius: '4px', border: 'none', background: '#3B82F6', color: '#fff', fontSize: '0.7rem', cursor: 'pointer' }}>✓</button>
                    <button onClick={() => setEditingTag(null)} style={{ padding: '0.15rem 0.35rem', borderRadius: '4px', border: '1px solid #E2E8F0', background: '#fff', color: '#64748B', fontSize: '0.7rem', cursor: 'pointer' }}>✕</button>
                  </div>
                ) : (
                  <div onClick={() => setActiveTagId(activeTagId === tag.id ? null : tag.id)}
                    style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', padding: '0.35rem 0.5rem', borderRadius: '6px', background: activeTagId === tag.id ? '#F1F5F9' : 'transparent', cursor: 'pointer' }}>
                    <span style={{ width: '9px', height: '9px', borderRadius: '50%', background: tag.color, flexShrink: 0 }} />
                    <span style={{ flex: 1, fontSize: '0.82rem', fontWeight: activeTagId === tag.id ? 700 : 400, color: '#0F172A', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tag.name}</span>
                    <span style={{ fontSize: '0.68rem', color: '#94A3B8', background: '#F1F5F9', borderRadius: '999px', padding: '1px 5px', flexShrink: 0 }}>{tagCounts[tag.id] ?? 0}</span>
                    <button onClick={e => { e.stopPropagation(); setEditingTag({ id: tag.id, name: tag.name }) }}
                      style={{ background: 'none', border: 'none', color: '#94A3B8', cursor: 'pointer', padding: '0 2px', fontSize: '0.7rem', flexShrink: 0, lineHeight: 1 }} title="Renombrar">
                      ✏
                    </button>
                    <button onClick={e => { e.stopPropagation(); openDeleteDlg(tag) }}
                      style={{ background: 'none', border: 'none', color: '#EF4444', cursor: 'pointer', padding: '0 2px', fontSize: '0.7rem', flexShrink: 0, lineHeight: 1 }} title="Eliminar">
                      🗑
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* ── Table ── */}
        <div style={{ flex: 1, minWidth: 0 }}>
          {loading ? (
            <p style={{ color: '#94A3B8', marginTop: '2rem' }}>Cargando...</p>
          ) : filtered.length === 0 ? (
            <div style={s.emptyBox}>
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#CBD5E1" strokeWidth="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
              <p style={{ color: '#64748B', marginTop: '0.75rem', fontWeight: 500 }}>
                {activeTagId ? 'No hay archivos con esta etiqueta.' : 'No hay contenido todavía.'}
              </p>
              {!activeTagId && <p style={{ color: '#94A3B8', fontSize: '0.85rem', marginTop: '0.25rem' }}>Crea un programa con zonas y luego sube archivos aquí.</p>}
            </div>
          ) : (
            <div style={s.tableWrap}>
              <table style={s.table}>
                <thead>
                  <tr>
                    <th style={s.th}>Nombre del medio</th>
                    <th style={s.th}>Tipo de medio</th>
                    <th style={s.th}>Programa → Zona</th>
                    <th style={s.th}>Duración</th>
                    <th style={s.th}>Operar</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(item => {
                    const url      = getPublicUrl(item.storage_path)
                    const zone     = zones.find(z => z.id === item.zone_id)
                    const itemTags = itemTagMap[item.id] ?? []
                    return (
                      <tr key={item.id} style={s.tr}>
                        <td style={s.td}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                            <div style={{ width: '48px', height: '32px', borderRadius: '6px', overflow: 'hidden', background: '#F1F5F9', flexShrink: 0 }}>
                              {item.type === 'image'
                                ? <img src={url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                                : item.type === 'video'
                                  ? <video src={url} style={{ width: '100%', height: '100%', objectFit: 'cover' }} preload="metadata" muted onLoadedMetadata={e => { const d = e.currentTarget.duration; if (isFinite(d)) setDurations(prev => prev[item.id] === Math.round(d) ? prev : { ...prev, [item.id]: Math.round(d) }); e.currentTarget.currentTime = 1 }} />
                                  : <div style={{ width: '100%', height: '100%', background: '#DBEAFE', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1rem' }}>🌐</div>
                              }
                            </div>
                            <div style={{ minWidth: 0 }}>
                              <div style={{ color: '#0F172A', fontWeight: 500, fontSize: '0.875rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '200px' }}>{item.name}</div>
                              {itemTags.length > 0 && (
                                <div style={{ display: 'flex', gap: '4px', marginTop: '4px', flexWrap: 'wrap' }}>
                                  {itemTags.map(t => (
                                    <span key={t.id} title={t.name}
                                      style={{ display: 'inline-flex', alignItems: 'center', gap: '3px', fontSize: '0.65rem', fontWeight: 600, color: t.color, background: t.color + '18', padding: '1px 6px', borderRadius: '4px', border: `1px solid ${t.color}30` }}>
                                      <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: t.color, display: 'inline-block', flexShrink: 0 }} />
                                      {t.name}
                                    </span>
                                  ))}
                                </div>
                              )}
                            </div>
                          </div>
                        </td>
                        <td style={s.td}>
                          <div>
                            <span style={{
                              background: item.type === 'video' ? '#F3F0FF' : item.type === 'image' ? '#F0FDF4' : '#EFF6FF',
                              color: item.type === 'video' ? '#7C3AED' : item.type === 'image' ? '#059669' : '#2563EB',
                              fontSize: '0.72rem', fontWeight: 600, padding: '2px 8px', borderRadius: '20px',
                            }}>
                              {item.type === 'video' ? 'Video' : item.type === 'image' ? 'Imagen' : 'URL'}
                            </span>
                            {item.type !== 'url' && <div style={{ color: '#94A3B8', fontSize: '0.72rem', marginTop: '2px' }}>{item.storage_path.split('.').pop()?.toUpperCase()}</div>}
                          </div>
                        </td>
                        <td style={{ ...s.td, color: '#64748B' }}>{zone ? `${zone.program_name} → ${zone.name}` : '—'}</td>
                        <td style={{ ...s.td, color: '#64748B' }}>
                          {item.type === 'video'
                            ? (durations[item.id] != null ? `${durations[item.id]} seg` : '…')
                            : item.type === 'image'
                              ? (item.duration_seconds ? `${item.duration_seconds} seg` : '—')
                              : '—'}
                        </td>
                        <td style={s.td}>
                          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                            <a href={url} target="_blank" rel="noreferrer"
                              style={{ color: '#2563EB', fontSize: '0.8rem', fontWeight: 500, textDecoration: 'none' }}>
                              Vista previa
                            </a>
                            <span style={{ color: '#E2E8F0' }}>|</span>

                            {/* Tag assignment button + dropdown */}
                            <div style={{ position: 'relative', zIndex: tagDropdownOpen === item.id ? 10 : 1 }}>
                              <button
                                onClick={e => { e.stopPropagation(); setTagDropdownOpen(tagDropdownOpen === item.id ? null : item.id) }}
                                title="Asignar etiquetas"
                                style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontSize: '0.8rem', color: itemTags.length > 0 ? '#8B5CF6' : '#94A3B8', fontWeight: 600 }}>
                                🏷{itemTags.length > 0 ? ` ${itemTags.length}` : ''}
                              </button>
                              {tagDropdownOpen === item.id && (
                                <div style={{ position: 'absolute', top: '100%', right: 0, marginTop: '5px', background: '#fff', border: '1px solid #E2E8F0', borderRadius: '10px', boxShadow: '0 8px 24px rgba(0,0,0,0.12)', zIndex: 10, minWidth: '190px', padding: '0.4rem' }}>
                                  {tags.length === 0 ? (
                                    <p style={{ color: '#94A3B8', fontSize: '0.78rem', padding: '0.25rem 0.5rem', margin: 0 }}>Abre el panel de etiquetas para crear una.</p>
                                  ) : tags.map(tag => {
                                    const has = itemTags.some(t => t.id === tag.id)
                                    return (
                                      <button key={tag.id} onClick={() => handleAssignTag(item.id, tag.id, has)}
                                        style={{ width: '100%', display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.4rem 0.5rem', borderRadius: '7px', border: 'none', background: has ? '#F5F3FF' : 'transparent', cursor: 'pointer', textAlign: 'left' }}>
                                        <span style={{ width: '10px', height: '10px', borderRadius: '50%', background: tag.color, flexShrink: 0 }} />
                                        <span style={{ flex: 1, fontSize: '0.82rem', color: '#0F172A' }}>{tag.name}</span>
                                        {has && <span style={{ color: '#7C3AED', fontSize: '0.7rem', fontWeight: 700 }}>✓</span>}
                                      </button>
                                    )
                                  })}
                                </div>
                              )}
                            </div>

                            <span style={{ color: '#E2E8F0' }}>|</span>
                            <button onClick={() => handleDelete(item)}
                              style={{ color: '#EF4444', fontSize: '0.8rem', fontWeight: 500, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                              Eliminar
                            </button>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  topbar:      { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1.75rem', flexWrap: 'wrap', gap: '1rem' },
  title:       { fontSize: '1.6rem', fontWeight: 700, color: '#0F172A' },
  sub:         { color: '#64748B', fontSize: '0.875rem', marginTop: '0.2rem' },
  searchWrap:  { display: 'flex', alignItems: 'center', gap: '0.5rem', background: '#fff', border: '1px solid #E2E8F0', borderRadius: '8px', padding: '0.5rem 0.875rem', width: '220px' },
  searchInput: { border: 'none', outline: 'none', fontSize: '0.875rem', color: '#0F172A', width: '100%', background: 'transparent' },
  btnPrimary:  { display: 'flex', alignItems: 'center', gap: '0.4rem', padding: '0.6rem 1.1rem', borderRadius: '8px', border: 'none', background: '#3B82F6', color: '#fff', fontWeight: 600, fontSize: '0.875rem', cursor: 'pointer', whiteSpace: 'nowrap' },
  btnOutline:  { padding: '0.6rem 1rem', borderRadius: '8px', border: '1px solid #E2E8F0', background: '#fff', color: '#64748B', fontWeight: 500, fontSize: '0.875rem', cursor: 'pointer' },
  formCard:    { background: '#fff', border: '1px solid #E2E8F0', borderRadius: '12px', padding: '1.5rem', marginBottom: '1.75rem', boxShadow: '0 1px 4px rgba(0,0,0,0.04)' },
  formTitle:   { fontWeight: 700, color: '#0F172A', marginBottom: '1rem', fontSize: '1rem' },
  formRow:     { display: 'flex', gap: '1.25rem', flexWrap: 'wrap', marginBottom: '1rem' },
  formGroup:   { display: 'flex', flexDirection: 'column', gap: '0.35rem' },
  label:       { color: '#64748B', fontSize: '0.8rem', fontWeight: 500 },
  input:       { padding: '0.55rem 0.75rem', borderRadius: '8px', border: '1px solid #E2E8F0', background: '#fff', color: '#0F172A', fontSize: '0.875rem', outline: 'none' },
  emptyBox:    { background: '#fff', border: '1px dashed #E2E8F0', borderRadius: '12px', padding: '4rem', textAlign: 'center' },
  tableWrap:   { background: '#fff', border: '1px solid #E2E8F0', borderRadius: '12px', overflowX: 'auto', WebkitOverflowScrolling: 'touch', boxShadow: '0 1px 6px rgba(0,0,0,0.04)' },
  table:       { width: '100%', borderCollapse: 'collapse' },
  th:          { padding: '0.875rem 1.25rem', textAlign: 'left', color: '#94A3B8', fontSize: '0.75rem', fontWeight: 600, borderBottom: '1px solid #F1F5F9', background: '#FAFBFC', whiteSpace: 'nowrap', letterSpacing: '0.03em' },
  tr:          { borderBottom: '1px solid #F8FAFC' },
  td:          { padding: '0.875rem 1.25rem', color: '#0F172A', fontSize: '0.875rem' },
}
