import { useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { uploadToR2 } from '../lib/uploadToR2'
import { notifyStorageChanged } from '../lib/storage'

type Tab = 'general' | 'users'

export default function Settings() {
  const [tab, setTab] = useState<Tab>('general')

  return (
    <div>
      <div style={s.topbar}>
        <div>
          <h1 style={s.title}>Configuración</h1>
          <p style={s.sub}>Ajustes de tu organización</p>
        </div>
      </div>

      {/* Tabs */}
      <div style={s.tabBar}>
        <button
          onClick={() => setTab('general')}
          style={{ ...s.tab, ...(tab === 'general' ? s.tabActive : {}) }}>
          General
        </button>
        <button
          onClick={() => setTab('users')}
          style={{ ...s.tab, ...(tab === 'users' ? s.tabActive : {}) }}>
          Usuarios
        </button>
      </div>

      {tab === 'general' && <GeneralTab />}
      {tab === 'users' && (
        <div style={s.formCard}>
          <p style={{ color: '#94A3B8', fontSize: '0.875rem' }}>
            La gestión de usuarios estará disponible pronto.
          </p>
        </div>
      )}
    </div>
  )
}

// ── Tab General: logo de la organización ────────────────────────────────────
function GeneralTab() {
  const [orgId, setOrgId] = useState<string | null>(null)
  const [logoUrl, setLogoUrl] = useState<string | null>(null)   // guardado en BD
  const [file, setFile] = useState<File | null>(null)           // selección pendiente
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let alive = true
    async function load() {
      const uid = (await supabase.auth.getUser()).data.user?.id ?? ''
      const { data: prof } = await supabase.from('profiles').select('organization_id').eq('id', uid).single()
      const oid = prof?.organization_id ?? null
      if (!oid) { if (alive) setLoading(false); return }
      const { data: org } = await supabase.from('organizations').select('logo_url').eq('id', oid).single()
      if (!alive) return
      setOrgId(oid)
      setLogoUrl(org?.logo_url ?? null)
      setLoading(false)
    }
    load()
    return () => { alive = false }
  }, [])

  // Libera el object URL local al cambiar de archivo o desmontar.
  useEffect(() => {
    return () => { if (previewUrl) URL.revokeObjectURL(previewUrl) }
  }, [previewUrl])

  function onSelectFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    if (!f) return
    setError(null); setSaved(false)
    if (!f.type.startsWith('image/')) { setError('El logo debe ser una imagen.'); return }
    if (previewUrl) URL.revokeObjectURL(previewUrl)
    setFile(f)
    setPreviewUrl(URL.createObjectURL(f))
  }

  function cancelSelection() {
    if (previewUrl) URL.revokeObjectURL(previewUrl)
    setFile(null); setPreviewUrl(null); setError(null)
    if (fileRef.current) fileRef.current.value = ''
  }

  async function handleSave() {
    if (!file || !orgId) return
    setUploading(true); setProgress(0); setError(null); setSaved(false)
    const { url, error: upErr } = await uploadToR2(file, setProgress, 'branding')
    if (upErr || !url) { setError(upErr?.message ?? 'Error al subir el logo.'); setUploading(false); return }
    const { error: dbErr } = await supabase.from('organizations').update({ logo_url: url }).eq('id', orgId)
    if (dbErr) { setError('Error al guardar: ' + dbErr.message); setUploading(false); return }
    setLogoUrl(url)
    if (previewUrl) URL.revokeObjectURL(previewUrl)
    setFile(null); setPreviewUrl(null)
    if (fileRef.current) fileRef.current.value = ''
    setUploading(false); setSaved(true)
    notifyStorageChanged()
  }

  if (loading) return <div style={s.formCard}><p style={{ color: '#94A3B8', fontSize: '0.875rem' }}>Cargando...</p></div>

  const shown = previewUrl ?? logoUrl

  return (
    <div style={s.formCard}>
      <div style={s.formTitle}>Logo de la organización</div>
      <p style={{ color: '#64748B', fontSize: '0.82rem', marginTop: '-0.5rem', marginBottom: '1.25rem' }}>
        Se muestra en el panel. Recomendado: PNG con fondo transparente.
      </p>

      <div style={{ display: 'flex', gap: '1.5rem', alignItems: 'flex-start', flexWrap: 'wrap' }}>
        {/* Preview */}
        <div style={s.logoBox}>
          {shown
            ? <img src={shown} alt="Logo" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
            : <span style={{ color: '#CBD5E1', fontSize: '0.78rem' }}>Sin logo</span>
          }
        </div>

        {/* Controles */}
        <div style={{ flex: 1, minWidth: '220px' }}>
          <input ref={fileRef} type="file" accept="image/*" onChange={onSelectFile} style={{ display: 'none' }} />

          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <button onClick={() => fileRef.current?.click()} style={s.btnOutline} disabled={uploading}>
              {shown ? 'Cambiar logo' : 'Subir logo'}
            </button>
            {file && !uploading && (
              <>
                <button onClick={handleSave} style={s.btnPrimary}>Guardar</button>
                <button onClick={cancelSelection} style={s.btnOutline}>Cancelar</button>
              </>
            )}
          </div>

          {uploading && (
            <div style={{ marginTop: '0.9rem' }}>
              <div style={{ height: '6px', background: '#E2E8F0', borderRadius: '999px', overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${progress}%`, background: '#3B82F6', borderRadius: '999px', transition: 'width 0.2s' }} />
              </div>
              <div style={{ marginTop: '0.35rem', fontSize: '0.72rem', color: '#94A3B8' }}>Subiendo… {progress}%</div>
            </div>
          )}

          {file && !uploading && (
            <p style={{ marginTop: '0.75rem', fontSize: '0.78rem', color: '#64748B' }}>
              Seleccionado: {file.name} — pulsa <strong>Guardar</strong> para aplicarlo.
            </p>
          )}
          {error && <p style={{ marginTop: '0.75rem', fontSize: '0.8rem', color: '#EF4444' }}>{error}</p>}
          {saved && <p style={{ marginTop: '0.75rem', fontSize: '0.8rem', color: '#10B981' }}>✓ Logo actualizado.</p>}
        </div>
      </div>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  topbar: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1.5rem', flexWrap: 'wrap', gap: '1rem' },
  title: { fontSize: '1.6rem', fontWeight: 700, color: '#0F172A' },
  sub: { color: '#64748B', fontSize: '0.875rem', marginTop: '0.2rem' },
  tabBar: { display: 'flex', gap: '0.25rem', borderBottom: '1px solid #E2E8F0', marginBottom: '1.5rem' },
  tab: { padding: '0.6rem 1rem', border: 'none', background: 'transparent', color: '#64748B', fontSize: '0.875rem', fontWeight: 500, cursor: 'pointer', borderBottom: '2px solid transparent', marginBottom: '-1px' },
  tabActive: { color: '#2563EB', fontWeight: 600, borderBottom: '2px solid #2563EB' },
  formCard: { background: '#fff', border: '1px solid #E2E8F0', borderRadius: '12px', padding: '1.5rem', boxShadow: '0 1px 4px rgba(0,0,0,0.04)' },
  formTitle: { fontWeight: 700, color: '#0F172A', marginBottom: '1rem', fontSize: '1rem' },
  btnPrimary: { display: 'flex', alignItems: 'center', gap: '0.4rem', padding: '0.55rem 1.1rem', borderRadius: '8px', border: 'none', background: '#3B82F6', color: '#fff', fontWeight: 600, fontSize: '0.875rem', whiteSpace: 'nowrap', cursor: 'pointer' },
  btnOutline: { padding: '0.55rem 1rem', borderRadius: '8px', border: '1px solid #E2E8F0', background: '#fff', color: '#64748B', fontWeight: 500, fontSize: '0.875rem', cursor: 'pointer' },
  logoBox: { width: '180px', height: '120px', borderRadius: '10px', border: '1px dashed #CBD5E1', background: '#F8FAFC', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0.75rem', flexShrink: 0 },
}
