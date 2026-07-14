import { useEffect, useState, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../auth/AuthContext'
import ZoneEditor from './ZoneEditor'

type Program = {
  id: string; name: string; width: number; height: number
  client_name: string | null; short_code: string | null
  created_at: string; thumbnail_url: string | null
}

type Props = { initialEditId?: string | null }

export default function Programs({ initialEditId }: Props = {}) {
  const { profile } = useAuth()
  const [programs, setPrograms] = useState<Program[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [name, setName] = useState('')
  const [clientName, setClientName] = useState('')
  const [width, setWidth] = useState(1920)
  const [height, setHeight] = useState(1080)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editingProgram, setEditingProgram] = useState<string | null>(initialEditId ?? null)
  const [search, setSearch] = useState('')
  const [uploadingThumb, setUploadingThumb] = useState<string | null>(null)
  const thumbRef = useRef<HTMLInputElement>(null)
  const [activeThumbId, setActiveThumbId] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    const { data } = await supabase.from('programs').select('*').order('created_at', { ascending: false })
    if (data) setPrograms(data as Program[])
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  // Si llega un nuevo initialEditId (desde dashboard), abrirlo
  useEffect(() => {
    if (initialEditId) setEditingProgram(initialEditId)
  }, [initialEditId])

  async function handleCreate() {
    if (!name.trim()) return
    setSaving(true); setError(null)
    const shortCode = name.trim().substring(0, 3).toUpperCase() + Math.random().toString(36).substring(2, 5).toUpperCase()
    const { data: profileData } = await supabase.from('profiles').select('organization_id').eq('id', profile?.id ?? '').single()
    const { error } = await supabase.from('programs').insert({
      name: name.trim(), client_name: clientName.trim() || null,
      width, height, created_by: profile?.id,
      organization_id: profileData?.organization_id ?? null,
      short_code: shortCode,
    })
    setSaving(false)
    if (error) { setError(error.message); return }
    setName(''); setClientName(''); setWidth(1920); setHeight(1080); setShowForm(false); load()
  }

  async function handleDelete(id: string) {
    if (!confirm('¿Eliminar este programa?')) return
    await supabase.from('programs').delete().eq('id', id); load()
  }

  async function handleThumbnailUpload(programId: string, file: File) {
    setUploadingThumb(programId)
    const ext = file.name.split('.').pop()
    const path = `thumbnails/${programId}.${ext}`
    const { error: storageError } = await supabase.storage.from('media').upload(path, file, { upsert: true })
    if (storageError) { alert('Error: ' + storageError.message); setUploadingThumb(null); return }
    const { data } = supabase.storage.from('media').getPublicUrl(path)
    await supabase.from('programs').update({ thumbnail_url: data.publicUrl + '?t=' + Date.now() }).eq('id', programId)
    setUploadingThumb(null); setActiveThumbId(null); load()
  }

  // Si hay programa seleccionado, mostrar ZoneEditor
  if (editingProgram) {
    return <ZoneEditor programId={editingProgram} onBack={() => { setEditingProgram(null); load() }} />
  }

  const filtered = programs.filter(p =>
    p.name.toLowerCase().includes(search.toLowerCase()) ||
    (p.client_name ?? '').toLowerCase().includes(search.toLowerCase()) ||
    (p.short_code ?? '').toLowerCase().includes(search.toLowerCase())
  )

  return (
    <div>
      <div style={s.topbar}>
        <div>
          <h1 style={s.title}>Programas</h1>
          <p style={s.sub}>Define el layout de tus pantallas · {programs.length} programas</p>
        </div>
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
          <div style={s.searchWrap}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#94A3B8" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            <input style={s.searchInput} placeholder="Buscar..." value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          <button style={s.btnPrimary} onClick={() => setShowForm(!showForm)}>
            {showForm ? '✕ Cancelar' : '+ Nuevo programa'}
          </button>
        </div>
      </div>

      {showForm && (
        <div style={s.formCard}>
          <h3 style={s.formTitle}>Nuevo programa</h3>
          <div style={s.formRow}>
            <div style={s.formGroup}>
              <label style={s.label}>Nombre</label>
              <input style={s.input} value={name} onChange={e => setName(e.target.value)} placeholder="Ej: Kennedy SN Full HD" />
            </div>
            <div style={s.formGroup}>
              <label style={s.label}>Cliente (opcional)</label>
              <input style={s.input} value={clientName} onChange={e => setClientName(e.target.value)} placeholder="Ej: Coca-Cola" />
            </div>
            <div style={s.formGroup}>
              <label style={s.label}>Resolución</label>
              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                <input style={{ ...s.input, width: '90px' }} type="number" value={width} onChange={e => setWidth(+e.target.value)} />
                <span style={{ color: '#94A3B8' }}>×</span>
                <input style={{ ...s.input, width: '90px' }} type="number" value={height} onChange={e => setHeight(+e.target.value)} />
              </div>
            </div>
          </div>
          {error && <p style={s.errorText}>{error}</p>}
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button style={s.btnPrimary} onClick={handleCreate} disabled={saving}>{saving ? 'Guardando...' : 'Crear programa'}</button>
            <button style={s.btnOutline} onClick={() => setShowForm(false)}>Cancelar</button>
          </div>
        </div>
      )}

      <input ref={thumbRef} type="file" accept="image/*" style={{ display: 'none' }}
        onChange={e => { const file = e.target.files?.[0]; if (file && activeThumbId) handleThumbnailUpload(activeThumbId, file); e.target.value = '' }} />

      {loading ? (
        <div style={s.grid}>
          {[0,1,2,3].map(i => <div key={i} style={{ height: '320px', borderRadius: '14px' }} className="skeleton" />)}
        </div>
      ) : filtered.length === 0 ? (
        <div style={s.emptyBox}>
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#CBD5E1" strokeWidth="1.5"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
          <p style={{ color: '#64748B', marginTop: '0.75rem', fontWeight: 500 }}>{search ? 'No hay resultados.' : 'No hay programas todavía.'}</p>
        </div>
      ) : (
        <>
          <div style={s.grid}>
            {filtered.map(p => (
              <div key={p.id} style={s.card} className="card-hover">
                <div style={s.cardImg}>
                  {p.thumbnail_url
                    ? <img src={p.thumbnail_url} alt={p.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    : <div style={{ width: '100%', height: '100%', background: 'linear-gradient(135deg, #1E3A5F 0%, #2563EB 50%, #1E40AF 100%)' }} />
                  }
                  <div style={s.resBadge}>{p.width} × {p.height}</div>
                  <button style={s.thumbBtn} onClick={() => { setActiveThumbId(p.id); thumbRef.current?.click() }} disabled={uploadingThumb === p.id}>
                    {uploadingThumb === p.id ? (
                      <span style={{ fontSize: '0.7rem', color: '#fff' }}>Subiendo...</span>
                    ) : (
                      <>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                        <span style={{ fontSize: '0.7rem', color: '#fff' }}>{p.thumbnail_url ? 'Cambiar foto' : 'Subir foto'}</span>
                      </>
                    )}
                  </button>
                </div>

                <div style={s.cardBody}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div>
                      <h3 style={s.cardName}>{p.name}</h3>
                      <p style={s.cardSub}>{p.client_name ?? 'Programa horizontal'}</p>
                    </div>
                    {p.short_code && <span style={s.shortCode}>{p.short_code}</span>}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginTop: '0.75rem' }}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#94A3B8" strokeWidth="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
                    <span style={{ color: '#94A3B8', fontSize: '0.8rem' }}>{new Date(p.created_at).toLocaleDateString('es-DO')}</span>
                  </div>
                </div>

                <div style={s.cardActions}>
                  <button style={s.btnEdit} onClick={() => setEditingProgram(p.id)}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                    Editar zonas
                  </button>
                  <button style={s.btnDel} onClick={() => handleDelete(p.id)}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
                    Eliminar
                  </button>
                </div>
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: '0.5rem' }}>
            <span style={{ color: '#64748B', fontSize: '0.85rem' }}>Mostrando {filtered.length} de {programs.length} programas</span>
            <div style={{ display: 'flex', gap: '0.4rem' }}>
              <button style={{ width: '32px', height: '32px', borderRadius: '6px', border: '1px solid #E2E8F0', background: '#fff', color: '#64748B', cursor: 'pointer' }}>‹</button>
              <button style={{ width: '32px', height: '32px', borderRadius: '6px', border: '1px solid #3B82F6', background: '#3B82F6', color: '#fff', cursor: 'pointer' }}>1</button>
              <button style={{ width: '32px', height: '32px', borderRadius: '6px', border: '1px solid #E2E8F0', background: '#fff', color: '#64748B', cursor: 'pointer' }}>›</button>
            </div>
          </div>
        </>
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
  btnPrimary: { display: 'flex', alignItems: 'center', gap: '0.4rem', padding: '0.6rem 1.1rem', borderRadius: '8px', border: 'none', background: '#2563EB', color: '#fff', fontWeight: 600, fontSize: '0.875rem', whiteSpace: 'nowrap', cursor: 'pointer' },
  btnOutline: { padding: '0.6rem 1rem', borderRadius: '8px', border: '1px solid #E2E8F0', background: '#fff', color: '#64748B', fontWeight: 500, fontSize: '0.875rem', cursor: 'pointer' },
  formCard: { background: '#fff', border: '1px solid #E2E8F0', borderRadius: '12px', padding: '1.5rem', marginBottom: '1.75rem', boxShadow: '0 1px 4px rgba(0,0,0,0.04)' },
  formTitle: { fontWeight: 700, color: '#0F172A', marginBottom: '1rem', fontSize: '1rem' },
  formRow: { display: 'flex', gap: '1.25rem', flexWrap: 'wrap', marginBottom: '1rem' },
  formGroup: { display: 'flex', flexDirection: 'column', gap: '0.35rem' },
  label: { color: '#64748B', fontSize: '0.8rem', fontWeight: 500 },
  input: { padding: '0.55rem 0.75rem', borderRadius: '8px', border: '1px solid #E2E8F0', background: '#fff', color: '#0F172A', fontSize: '0.875rem', outline: 'none' },
  errorText: { color: '#EF4444', fontSize: '0.8rem', marginBottom: '0.75rem' },
  emptyBox: { background: '#fff', border: '1px dashed #E2E8F0', borderRadius: '12px', padding: '4rem', textAlign: 'center', marginTop: '1rem' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '1.25rem', marginBottom: '1.5rem' },
  card: { background: '#fff', borderRadius: '14px', overflow: 'hidden', border: '1px solid #E2E8F0', boxShadow: '0 1px 6px rgba(0,0,0,0.04)' },
  cardImg: { height: '180px', position: 'relative', overflow: 'hidden', background: '#E2E8F0' },
  resBadge: { position: 'absolute', top: '0.875rem', left: '0.875rem', background: 'rgba(0,0,0,0.5)', color: '#fff', fontSize: '0.75rem', fontWeight: 600, padding: '4px 10px', borderRadius: '6px', backdropFilter: 'blur(4px)' },
  thumbBtn: { position: 'absolute', bottom: '0.875rem', left: '50%', transform: 'translateX(-50%)', display: 'flex', alignItems: 'center', gap: '0.35rem', background: 'rgba(0,0,0,0.5)', border: '1px solid rgba(255,255,255,0.3)', borderRadius: '20px', padding: '5px 12px', cursor: 'pointer', backdropFilter: 'blur(4px)', whiteSpace: 'nowrap' },
  cardBody: { padding: '1rem 1.25rem 0.75rem' },
  cardName: { fontWeight: 700, color: '#0F172A', fontSize: '1rem' },
  cardSub: { color: '#94A3B8', fontSize: '0.8rem', marginTop: '0.15rem' },
  shortCode: { fontSize: '0.72rem', fontWeight: 700, color: '#2563EB', background: '#EFF6FF', padding: '2px 8px', borderRadius: '4px', flexShrink: 0 },
  cardActions: { display: 'flex', gap: '0.5rem', padding: '0.75rem 1.25rem 1rem', borderTop: '1px solid #F1F5F9' },
  btnEdit: { display: 'flex', alignItems: 'center', gap: '0.35rem', padding: '0.45rem 0.875rem', borderRadius: '7px', border: '1px solid #BFDBFE', background: '#EFF6FF', color: '#2563EB', fontSize: '0.8rem', fontWeight: 600, cursor: 'pointer' },
  btnDel: { display: 'flex', alignItems: 'center', gap: '0.35rem', padding: '0.45rem 0.875rem', borderRadius: '7px', border: '1px solid #FECACA', background: '#FFF5F5', color: '#EF4444', fontSize: '0.8rem', fontWeight: 500, cursor: 'pointer' },
}