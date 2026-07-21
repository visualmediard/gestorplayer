import { useEffect, useState, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { uploadToR2 } from '../lib/uploadToR2'
import { resolveMediaUrl } from '../lib/mediaUrl'
import { deleteMediaFileIfUnused } from '../lib/deleteMediaFile'
import { fileTooLargeMessage, MAX_FILE_MB } from '../lib/fileLimit'
import { dedupeMedia } from '../lib/dedupeMedia'
import { useAuth } from '../auth/AuthContext'

type MediaItem = {
  id: string; name: string; type: 'image' | 'video' | 'url'
  storage_path: string; duration_seconds: number | null
  zone_id: string; created_at: string
}

type Zone = { id: string; name: string; program_name: string }

export default function Content() {
  const { profile } = useAuth()
  const [items, setItems] = useState<MediaItem[]>([])
  const [zones, setZones] = useState<Zone[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [selectedZone, setSelectedZone] = useState('')
  const [duration, setDuration] = useState(10)
  const [file, setFile] = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  // Real video durations read from each file's metadata (not stored in DB).
  const [durations, setDurations] = useState<Record<string, number>>({})
  const fileRef = useRef<HTMLInputElement>(null)


  async function load() {
    setLoading(true)
    const { data: mediaData } = await supabase.from('media_content').select('*').is('campaign_id', null).is('archived_at', null).order('created_at', { ascending: false })
    const { data: zoneData } = await supabase.from('zones').select('id, name, programs(name)')
    if (mediaData) setItems(dedupeMedia(mediaData as MediaItem[]))
    if (zoneData) setZones(zoneData.map((z: any) => ({ id: z.id, name: z.name, program_name: z.programs?.name ?? '' })))
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  async function handleUpload() {
    if (!file) { setError('Selecciona un archivo.'); return }
    const tooBig = fileTooLargeMessage(file)
    if (tooBig) { setError(tooBig); return }
    setUploading(true); setError(null)
    const isVideo = file.type.startsWith('video/')
    const { url, error: storageError } = await uploadToR2(file, setProgress)
    if (storageError || !url) { setError('Error al subir: ' + (storageError?.message ?? 'desconocido')); setUploading(false); return }
    const { error: insertError } = await supabase.from('media_content').insert({
      zone_id: selectedZone || null,
      name: file.name,
      type: isVideo ? 'video' : 'image',
      storage_path: url,
      duration_seconds: isVideo ? null : duration,
      uploaded_by: profile?.id,
    })
    if (insertError) { setError('Error al guardar: ' + insertError.message); setUploading(false); return }
    setFile(null); setProgress(0); setUploading(false); setDuration(10)
    setSelectedZone(''); setShowForm(false)
    if (fileRef.current) fileRef.current.value = ''
    load()
  }

  async function handleDelete(item: MediaItem) {
    if (!confirm(`¿Eliminar "${item.name}" de la biblioteca?\n\nSe quitará de la biblioteca y de las zonas donde esté, y el archivo se eliminará del almacenamiento. Las reproducciones ya registradas se conservan en Estadísticas.`)) return
    const now = new Date().toISOString()

    // Los ítems tipo URL no tienen archivo físico: solo se archivan.
    if (item.type === 'url') {
      await supabase.from('media_content').update({ archived_at: now }).is('campaign_id', null).eq('id', item.id)
      load()
      return
    }

    // 1) Todas las copias no-campaña de este archivo (la biblioteca deduplica
    //    por nombre+tipo, así que el borrado también agrupa por nombre+tipo).
    const { data: copies } = await supabase
      .from('media_content')
      .select('id, storage_path')
      .is('campaign_id', null)
      .eq('name', item.name)
      .eq('type', item.type)
    const rows = copies ?? []
    if (rows.length === 0) { load(); return }
    const ids = rows.map(r => r.id)
    const paths = [...new Set(rows.map(r => r.storage_path).filter(Boolean))] as string[]

    // 2) ¿Qué copias tienen reproducciones registradas? (una sola consulta a
    //    la vista agregada; las copias solo-biblioteca no aparecen = sin stats)
    const { data: stats } = await supabase
      .from('content_stats')
      .select('content_id, total_reproductions')
      .in('content_id', ids)
    const withStats = new Set((stats ?? []).filter(s => Number(s.total_reproductions) > 0).map(s => s.content_id))
    const keepIds = ids.filter(id => withStats.has(id))
    const dropIds = ids.filter(id => !withStats.has(id))

    // 3) Soft-delete respetado: las copias CON estadísticas se conservan
    //    (archivadas, sin archivo) para que reportes sigan mostrando el
    //    nombre; las copias SIN estadísticas se borran del todo.
    if (keepIds.length > 0) {
      await supabase.from('media_content')
        .update({ archived_at: now, storage_path: null }).in('id', keepIds)
    }
    if (dropIds.length > 0) {
      await supabase.from('media_content').delete().in('id', dropIds)
    }

    // 4) Borrar el archivo físico (R2 o Supabase legacy) si ya nadie más lo
    //    usa — copias de campaña activas lo bloquean automáticamente.
    for (const p of paths) await deleteMediaFileIfUnused(p)

    load()
  }

  const getPublicUrl = resolveMediaUrl

  const filtered = items.filter(i => i.name.toLowerCase().includes(search.toLowerCase()))

  return (
    <div>
      <div style={s.topbar} className="page-topbar">
        <div>
          <h1 style={s.title}>Contenido</h1>
          <p style={s.sub}>Sube imágenes y videos a tus zonas · {items.length} archivos</p>
        </div>
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
          <div style={s.searchWrap}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#94A3B8" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            <input style={s.searchInput} placeholder="Buscar archivo..." value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          <button style={s.btnPrimary} onClick={() => setShowForm(!showForm)}>+ Subir archivo</button>
        </div>
      </div>

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

      {loading ? (
        <p style={{ color: '#94A3B8', marginTop: '2rem' }}>Cargando...</p>
      ) : filtered.length === 0 ? (
        <div style={s.emptyBox}>
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#CBD5E1" strokeWidth="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
          <p style={{ color: '#64748B', marginTop: '0.75rem', fontWeight: 500 }}>No hay contenido todavía.</p>
          <p style={{ color: '#94A3B8', fontSize: '0.85rem', marginTop: '0.25rem' }}>Crea un programa con zonas y luego sube archivos aquí.</p>
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
                const url = getPublicUrl(item.storage_path)
                const zone = zones.find(z => z.id === item.zone_id)
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
                        <span style={{ color: '#0F172A', fontWeight: 500, fontSize: '0.875rem' }}>{item.name}</span>
                      </div>
                    </td>
                    <td style={s.td}>
                      <div>
                        <span style={{
                          background: item.type === 'video' ? '#F3F0FF' : item.type === 'image' ? '#F0FDF4' : '#EFF6FF',
                          color: item.type === 'video' ? '#7C3AED' : item.type === 'image' ? '#059669' : '#2563EB',
                          fontSize: '0.72rem', fontWeight: 600, padding: '2px 8px', borderRadius: '20px'
                        }}>
                          {item.type === 'video' ? 'Video' : item.type === 'image' ? 'Imagen' : 'URL'}
                        </span>
                        {item.type !== 'url' && <div style={{ color: '#94A3B8', fontSize: '0.72rem', marginTop: '2px' }}>
                          {item.storage_path.split('.').pop()?.toUpperCase()}
                        </div>}
                      </div>
                    </td>
                    <td style={{ ...s.td, color: '#64748B' }}>
                      {zone ? `${zone.program_name} → ${zone.name}` : '—'}
                    </td>
                    <td style={{ ...s.td, color: '#64748B' }}>
                      {item.type === 'video'
                        ? (durations[item.id] != null ? `${durations[item.id]} seg` : '…')
                        : item.type === 'image'
                          ? (item.duration_seconds ? `${item.duration_seconds} seg` : '—')
                          : '—'}
                    </td>
                    <td style={s.td}>
                      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                        <a href={url} target="_blank" rel="noreferrer"
                          style={{ color: '#2563EB', fontSize: '0.8rem', fontWeight: 500, textDecoration: 'none' }}>
                          Vista previa
                        </a>
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
  )
}

const s: Record<string, React.CSSProperties> = {
  topbar: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1.75rem', flexWrap: 'wrap', gap: '1rem' },
  title: { fontSize: '1.6rem', fontWeight: 700, color: '#0F172A' },
  sub: { color: '#64748B', fontSize: '0.875rem', marginTop: '0.2rem' },
  searchWrap: { display: 'flex', alignItems: 'center', gap: '0.5rem', background: '#fff', border: '1px solid #E2E8F0', borderRadius: '8px', padding: '0.5rem 0.875rem', width: '220px' },
  searchInput: { border: 'none', outline: 'none', fontSize: '0.875rem', color: '#0F172A', width: '100%', background: 'transparent' },
  btnPrimary: { display: 'flex', alignItems: 'center', gap: '0.4rem', padding: '0.6rem 1.1rem', borderRadius: '8px', border: 'none', background: '#3B82F6', color: '#fff', fontWeight: 600, fontSize: '0.875rem', cursor: 'pointer', whiteSpace: 'nowrap' },
  btnOutline: { padding: '0.6rem 1rem', borderRadius: '8px', border: '1px solid #E2E8F0', background: '#fff', color: '#64748B', fontWeight: 500, fontSize: '0.875rem', cursor: 'pointer' },
  formCard: { background: '#fff', border: '1px solid #E2E8F0', borderRadius: '12px', padding: '1.5rem', marginBottom: '1.75rem', boxShadow: '0 1px 4px rgba(0,0,0,0.04)' },
  formTitle: { fontWeight: 700, color: '#0F172A', marginBottom: '1rem', fontSize: '1rem' },
  formRow: { display: 'flex', gap: '1.25rem', flexWrap: 'wrap', marginBottom: '1rem' },
  formGroup: { display: 'flex', flexDirection: 'column', gap: '0.35rem' },
  label: { color: '#64748B', fontSize: '0.8rem', fontWeight: 500 },
  input: { padding: '0.55rem 0.75rem', borderRadius: '8px', border: '1px solid #E2E8F0', background: '#fff', color: '#0F172A', fontSize: '0.875rem', outline: 'none' },
  emptyBox: { background: '#fff', border: '1px dashed #E2E8F0', borderRadius: '12px', padding: '4rem', textAlign: 'center' },
  tableWrap: { background: '#fff', border: '1px solid #E2E8F0', borderRadius: '12px', overflowX: 'auto', WebkitOverflowScrolling: 'touch', boxShadow: '0 1px 6px rgba(0,0,0,0.04)' },
  table: { width: '100%', borderCollapse: 'collapse' },
  th: { padding: '0.875rem 1.25rem', textAlign: 'left', color: '#94A3B8', fontSize: '0.75rem', fontWeight: 600, borderBottom: '1px solid #F1F5F9', background: '#FAFBFC', whiteSpace: 'nowrap', letterSpacing: '0.03em' },
  tr: { borderBottom: '1px solid #F8FAFC' },
  td: { padding: '0.875rem 1.25rem', color: '#0F172A', fontSize: '0.875rem' },
}