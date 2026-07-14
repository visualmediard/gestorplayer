import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../auth/AuthContext'

type Campaign = {
  id: string; name: string; media_content_id: string | null
  starts_at: string; ends_at: string
  status: 'draft' | 'active' | 'paused' | 'ended'; created_at: string
}
type CampaignStat = {
  campaign_id: string; campaign_name: string; status: string
  starts_at: string; ends_at: string; zone_count: number; total_plays: number
}
type MediaItem = { id: string; name: string; type: string; storage_path: string }
type Zone = { id: string; name: string; program_name: string }
type ZoneSelection = { zone_id: string; frequency: number }

const STATUS_LABEL: Record<string, string> = {
  draft: 'Borrador', active: 'Activa', paused: 'Pausada', ended: 'Finalizada'
}
const STATUS_COLOR: Record<string, { bg: string; color: string; border: string }> = {
  draft:  { bg: '#F8FAFC', color: '#64748B', border: '#E2E8F0' },
  active: { bg: '#ECFDF5', color: '#059669', border: '#A7F3D0' },
  paused: { bg: '#FFF7ED', color: '#D97706', border: '#FDE68A' },
  ended:  { bg: '#F1F5F9', color: '#94A3B8', border: '#CBD5E1' },
}

export default function Campaigns() {
  const { profile } = useAuth()
  const [stats, setStats]           = useState<CampaignStat[]>([])
  const [campaigns, setCampaigns]   = useState<Campaign[]>([])
  const [media, setMedia]           = useState<MediaItem[]>([])
  const [zones, setZones]           = useState<Zone[]>([])
  const [loading, setLoading]       = useState(true)
  const [showForm, setShowForm]     = useState(false)
  const [publishing, setPublishing] = useState<string | null>(null)
  const [deleting, setDeleting]     = useState<string | null>(null)
  const [search, setSearch]         = useState('')

  // Form state
  const [fName, setFName]           = useState('')
  const [fMediaId, setFMediaId]     = useState('')
  const [fStartsAt, setFStartsAt]   = useState('')
  const [fEndsAt, setFEndsAt]       = useState('')
  const [fZones, setFZones]         = useState<ZoneSelection[]>([])
  const [fZoneSearch, setFZoneSearch] = useState('')
  const [fMediaSearch, setFMediaSearch] = useState('')
  const [saving, setSaving]         = useState(false)
  const [formError, setFormError]   = useState<string | null>(null)

  async function load() {
    setLoading(true)
    const { data: pd } = await supabase.from('profiles').select('organization_id').eq('id', profile?.id ?? '').single()
    const orgId = pd?.organization_id
    if (!orgId) { setLoading(false); return }

    const [{ data: campData }, { data: statData }, { data: mediaData }, { data: zoneData }] = await Promise.all([
      supabase.from('campaigns').select('*').eq('organization_id', orgId).order('created_at', { ascending: false }),
      supabase.from('campaign_stats').select('*').eq('organization_id', orgId),
      supabase.from('media_content').select('id, name, type, storage_path').order('created_at', { ascending: false }),
      supabase.from('zones').select('id, name, programs(name)'),
    ])

    if (campData) setCampaigns(campData as Campaign[])
    if (statData) setStats(statData as CampaignStat[])
    if (mediaData) setMedia(mediaData as MediaItem[])
    if (zoneData) setZones(zoneData.map((z: any) => ({ id: z.id, name: z.name, program_name: z.programs?.name ?? '—' })))
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  function getStat(id: string) {
    return stats.find(s => s.campaign_id === id)
  }

  function getPublicUrl(path: string) {
    return supabase.storage.from('media').getPublicUrl(path).data.publicUrl
  }

  function toggleZone(zoneId: string) {
    setFZones(prev =>
      prev.find(z => z.zone_id === zoneId)
        ? prev.filter(z => z.zone_id !== zoneId)
        : [...prev, { zone_id: zoneId, frequency: 1 }]
    )
  }

  function setFrequency(zoneId: string, freq: number) {
    setFZones(prev => prev.map(z => z.zone_id === zoneId ? { ...z, frequency: freq } : z))
  }

  function resetForm() {
    setFName(''); setFMediaId(''); setFStartsAt(''); setFEndsAt('')
    setFZones([]); setFZoneSearch(''); setFMediaSearch(''); setFormError(null)
  }

  async function handleCreate() {
    if (!fName.trim()) { setFormError('El nombre es requerido.'); return }
    if (!fMediaId)     { setFormError('Selecciona un contenido.'); return }
    if (!fStartsAt || !fEndsAt) { setFormError('Las fechas son requeridas.'); return }
    if (fZones.length === 0) { setFormError('Selecciona al menos una zona.'); return }
    if (new Date(fEndsAt) <= new Date(fStartsAt)) { setFormError('La fecha fin debe ser posterior al inicio.'); return }

    setSaving(true); setFormError(null)
    const { data: pd } = await supabase.from('profiles').select('organization_id').eq('id', profile?.id ?? '').single()

    const { data: camp, error } = await supabase.from('campaigns').insert({
      name: fName.trim(),
      organization_id: pd?.organization_id,
      media_content_id: fMediaId,
      starts_at: fStartsAt,
      ends_at: fEndsAt,
      status: 'draft',
      created_by: profile?.id,
    }).select().single()

    if (error || !camp) { setFormError(error?.message ?? 'Error al crear.'); setSaving(false); return }

    await supabase.from('campaign_zones').insert(
      fZones.map(z => ({ campaign_id: camp.id, zone_id: z.zone_id, frequency: z.frequency }))
    )

    setSaving(false)
    setShowForm(false)
    resetForm()
    load()
  }

  async function handlePublish(campaign: Campaign) {
    if (!confirm(`¿Publicar la campaña "${campaign.name}"? Se agregará el contenido a todas las zonas seleccionadas.`)) return
    setPublishing(campaign.id)

    const { data: czones } = await supabase.from('campaign_zones').select('zone_id, frequency').eq('campaign_id', campaign.id)
    if (!czones || czones.length === 0) { setPublishing(null); return }

    const { data: mediaItem } = await supabase.from('media_content').select('name, type, storage_path, duration_seconds').eq('id', campaign.media_content_id ?? '').single()
    if (!mediaItem) { setPublishing(null); return }

    for (const cz of czones) {
      for (let i = 0; i < cz.frequency; i++) {
        const { data: inserted } = await supabase.from('media_content').insert({
          zone_id: cz.zone_id,
          name: mediaItem.name,
          type: mediaItem.type,
          storage_path: mediaItem.storage_path,
          duration_seconds: mediaItem.duration_seconds,
          uploaded_by: profile?.id,
          campaign_id: campaign.id,
        }).select('id').single()

        if (inserted && i === 0) {
          await supabase.from('campaign_zones').update({ injected_media_id: inserted.id })
            .eq('campaign_id', campaign.id).eq('zone_id', cz.zone_id)
        }
      }
    }

    await supabase.from('campaigns').update({ status: 'active' }).eq('id', campaign.id)
    setPublishing(null)
    load()
  }

  async function handlePause(id: string, currentStatus: string) {
    const newStatus = currentStatus === 'paused' ? 'active' : 'paused'
    await supabase.from('campaigns').update({ status: newStatus }).eq('id', id)
    load()
  }

  async function handleDelete(id: string, name: string) {
    if (!confirm(`¿Eliminar la campaña "${name}"?`)) return
    setDeleting(id)
    await supabase.from('campaigns').delete().eq('id', id)
    setDeleting(null)
    load()
  }

  const filtered = campaigns.filter(c => c.name.toLowerCase().includes(search.toLowerCase()))

  return (
    <div>
      {/* Topbar */}
      <div style={s.topbar} className="page-topbar">
        <div>
          <h1 style={s.title}>Campañas</h1>
          <p style={s.sub}>Gestiona campañas publicitarias · {campaigns.length} creadas</p>
        </div>
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
          <div style={s.searchWrap}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#94A3B8" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            <input style={s.searchInput} placeholder="Buscar campaña..." value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          <button style={s.btnPrimary} onClick={() => { resetForm(); setShowForm(true) }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            Nueva campaña
          </button>
        </div>
      </div>

      {/* Create form */}
      {showForm && (
        <div style={s.formCard}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem' }}>
            <h3 style={s.formTitle}>Nueva campaña</h3>
            <button onClick={() => setShowForm(false)} style={s.closeBtn}>✕</button>
          </div>

          <div style={s.formGrid}>
            {/* Nombre */}
            <div style={{ ...s.formGroup, gridColumn: '1 / -1' }}>
              <label style={s.label}>Nombre de la campaña</label>
              <input style={s.input} value={fName} onChange={e => setFName(e.target.value)} placeholder="Ej: Coca-Cola Diciembre 2026" />
            </div>

            {/* Fechas */}
            <div style={s.formGroup}>
              <label style={s.label}>Fecha de inicio</label>
              <input style={s.input} type="datetime-local" value={fStartsAt} onChange={e => setFStartsAt(e.target.value)} />
            </div>
            <div style={s.formGroup}>
              <label style={s.label}>Fecha de fin</label>
              <input style={s.input} type="datetime-local" value={fEndsAt} onChange={e => setFEndsAt(e.target.value)} />
            </div>
          </div>

          {/* Media picker */}
          <div style={{ marginTop: '1.25rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem', flexWrap: 'wrap', gap: '0.5rem' }}>
              <label style={s.label}>Contenido (video o imagen)</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', background: '#F8FAFC', border: '1px solid #E2E8F0', borderRadius: '7px', padding: '0.3rem 0.625rem' }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#94A3B8" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                <input
                  style={{ border: 'none', outline: 'none', fontSize: '0.8rem', color: '#0F172A', background: 'transparent', width: '140px' }}
                  placeholder="Buscar archivo..."
                  value={fMediaSearch}
                  onChange={e => setFMediaSearch(e.target.value)}
                />
              </div>
            </div>
            <div style={s.mediaPicker}>
              {media.length === 0 ? (
                <p style={{ color: '#94A3B8', fontSize: '0.85rem' }}>No hay contenido en la biblioteca.</p>
              ) : media.filter(m => m.name.toLowerCase().includes(fMediaSearch.toLowerCase())).length === 0 ? (
                <p style={{ color: '#94A3B8', fontSize: '0.85rem' }}>Sin resultados.</p>
              ) : (
                media.filter(m => m.name.toLowerCase().includes(fMediaSearch.toLowerCase())).map(item => {
                  const url = getPublicUrl(item.storage_path)
                  const selected = fMediaId === item.id
                  return (
                    <div key={item.id} onClick={() => setFMediaId(item.id)}
                      style={{ ...s.mediaThumb, border: selected ? '2px solid #2563EB' : '2px solid #E2E8F0', background: selected ? '#EFF6FF' : '#fff' }}>
                      <div style={{ width: '100%', height: '56px', borderRadius: '5px', overflow: 'hidden', background: '#0F172A', marginBottom: '0.4rem', position: 'relative' }}>
                        {item.type === 'image' ? (
                          <img src={url} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                        ) : item.type === 'video' ? (
                          <>
                            <video
                              src={url + '#t=1'}
                              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                              preload="metadata"
                              muted
                              playsInline
                            />
                            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
                              <div style={{ width: '20px', height: '20px', background: 'rgba(0,0,0,0.55)', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                <svg width="8" height="8" viewBox="0 0 24 24" fill="white"><polygon points="5,3 19,12 5,21"/></svg>
                              </div>
                            </div>
                          </>
                        ) : (
                          <div style={{ width: '100%', height: '100%', background: '#DBEAFE', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.25rem' }}>🌐</div>
                        )}
                      </div>
                      <p style={{ fontSize: '0.68rem', color: selected ? '#2563EB' : '#0F172A', fontWeight: selected ? 600 : 400, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {item.name}
                      </p>
                      <p style={{ fontSize: '0.62rem', color: '#94A3B8', marginTop: '1px' }}>
                        {item.type === 'video' ? '🎬 Video' : item.type === 'image' ? '🖼 Imagen' : '🌐 URL'}
                      </p>
                      {selected && (
                        <div style={{ position: 'absolute', top: '4px', right: '4px', width: '16px', height: '16px', background: '#2563EB', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3"><polyline points="20 6 9 17 4 12"/></svg>
                        </div>
                      )}
                    </div>
                  )
                })
              )}
            </div>
          </div>

          {/* Zone selector */}
          <div style={{ marginTop: '1.25rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem', flexWrap: 'wrap', gap: '0.5rem' }}>
              <label style={s.label}>Zonas donde se publicará {fZones.length > 0 && <span style={{ color: '#2563EB', fontWeight: 700 }}>({fZones.length} seleccionadas)</span>}</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', background: '#F8FAFC', border: '1px solid #E2E8F0', borderRadius: '7px', padding: '0.3rem 0.625rem' }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#94A3B8" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                <input
                  style={{ border: 'none', outline: 'none', fontSize: '0.8rem', color: '#0F172A', background: 'transparent', width: '140px' }}
                  placeholder="Buscar zona..."
                  value={fZoneSearch}
                  onChange={e => setFZoneSearch(e.target.value)}
                />
              </div>
            </div>
            <div style={s.zoneGrid}>
              {zones
                .filter(z =>
                  z.name.toLowerCase().includes(fZoneSearch.toLowerCase()) ||
                  z.program_name.toLowerCase().includes(fZoneSearch.toLowerCase())
                )
                .map(zone => {
                  const sel = fZones.find(z => z.zone_id === zone.id)
                  return (
                    <div key={zone.id} style={{ ...s.zoneRow, background: sel ? '#EFF6FF' : '#FAFBFC', border: sel ? '1px solid #BFDBFE' : '1px solid #E2E8F0' }}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', flex: 1, minWidth: 0 }}>
                        <input type="checkbox" checked={!!sel} onChange={() => toggleZone(zone.id)}
                          style={{ accentColor: '#2563EB', width: '15px', height: '15px', flexShrink: 0 }} />
                        <span style={{ fontSize: '0.82rem', color: '#0F172A', fontWeight: 500, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {zone.name}
                        </span>
                        <span style={{ fontSize: '0.72rem', color: '#94A3B8', flexShrink: 0 }}>· {zone.program_name}</span>
                      </label>
                      {sel && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', flexShrink: 0 }}>
                          <span style={{ fontSize: '0.72rem', color: '#64748B' }}>×</span>
                          <input type="number" min={1} max={10} value={sel.frequency}
                            onChange={e => setFrequency(zone.id, Math.max(1, +e.target.value))}
                            style={{ ...s.input, width: '48px', padding: '0.2rem 0.4rem', fontSize: '0.8rem', textAlign: 'center' }} />
                          <span style={{ fontSize: '0.72rem', color: '#64748B' }}>veces</span>
                        </div>
                      )}
                    </div>
                  )
                })
              }
              {zones.filter(z =>
                z.name.toLowerCase().includes(fZoneSearch.toLowerCase()) ||
                z.program_name.toLowerCase().includes(fZoneSearch.toLowerCase())
              ).length === 0 && (
                <p style={{ color: '#94A3B8', fontSize: '0.82rem', padding: '0.75rem', textAlign: 'center' }}>Sin zonas que coincidan.</p>
              )}
            </div>
          </div>

          {formError && (
            <div style={s.errorBox}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
              {formError}
            </div>
          )}

          <div style={{ display: 'flex', gap: '0.625rem', marginTop: '1.25rem' }}>
            <button style={{ ...s.btnPrimary, opacity: saving ? 0.7 : 1 }} onClick={handleCreate} disabled={saving}>
              {saving ? 'Guardando...' : 'Guardar campaña'}
            </button>
            <button style={s.btnOutline} onClick={() => setShowForm(false)}>Cancelar</button>
          </div>
        </div>
      )}

      {/* Campaign list */}
      {loading ? (
        <div style={{ display: 'grid', gap: '1rem' }}>
          {[0,1,2].map(i => <div key={i} className="skeleton" style={{ height: '96px', borderRadius: '12px' }} />)}
        </div>
      ) : filtered.length === 0 ? (
        <div style={s.emptyBox}>
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#CBD5E1" strokeWidth="1.5"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/><line x1="12" y1="12" x2="12" y2="16"/><line x1="10" y1="14" x2="14" y2="14"/></svg>
          <p style={{ color: '#64748B', fontWeight: 500, marginTop: '0.75rem' }}>No hay campañas todavía.</p>
          <p style={{ color: '#94A3B8', fontSize: '0.85rem', marginTop: '0.25rem' }}>Crea tu primera campaña para comenzar a publicar.</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
          {filtered.map(camp => {
            const stat = getStat(camp.id)
            const sc = STATUS_COLOR[camp.status]
            const media_item = media.find(m => m.id === camp.media_content_id)
            const isPublishing = publishing === camp.id
            const isDeleting = deleting === camp.id

            return (
              <div key={camp.id} style={s.campCard} className="card-hover">
                {/* Media thumb */}
                <div style={s.campThumb}>
                  {media_item
                    ? (media_item.type === 'image'
                      ? <img src={getPublicUrl(media_item.storage_path)} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                      : media_item.type === 'video'
                        ? <video src={getPublicUrl(media_item.storage_path)} style={{ width: '100%', height: '100%', objectFit: 'cover' }} preload="metadata" muted onLoadedMetadata={e => { e.currentTarget.currentTime = 1 }} />
                        : <div style={{ width: '100%', height: '100%', background: '#DBEAFE', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>🌐</div>
                      )
                    : <div style={{ width: '100%', height: '100%', background: 'linear-gradient(135deg, #1E3A5F, #2563EB)' }} />
                  }
                </div>

                {/* Info */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem', flexWrap: 'wrap' }}>
                    <span style={s.campName}>{camp.name}</span>
                    <span style={{ ...s.badge, background: sc.bg, color: sc.color, border: `1px solid ${sc.border}` }}>
                      {STATUS_LABEL[camp.status]}
                    </span>
                  </div>
                  <div style={s.campMeta}>
                    <span>📅 {new Date(camp.starts_at).toLocaleDateString('es-DO')} → {new Date(camp.ends_at).toLocaleDateString('es-DO')}</span>
                    <span>·</span>
                    <span>🎬 {media_item?.name ?? '—'}</span>
                  </div>
                </div>

                {/* Stats */}
                <div style={s.statsRow}>
                  <div style={s.statBox}>
                    <span style={s.statVal}>{stat?.zone_count ?? 0}</span>
                    <span style={s.statLbl}>Zonas</span>
                  </div>
                  <div style={s.statBox}>
                    <span style={s.statVal}>{(stat?.total_plays ?? 0).toLocaleString()}</span>
                    <span style={s.statLbl}>Reproducciones</span>
                  </div>
                </div>

                {/* Actions */}
                <div style={s.campActions}>
                  {camp.status === 'draft' && (
                    <button style={{ ...s.btnPublish, opacity: isPublishing ? 0.7 : 1 }}
                      onClick={() => handlePublish(camp)} disabled={isPublishing}>
                      {isPublishing ? (
                        <>
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" style={{ animation: 'spin 0.8s linear infinite' }}>
                            <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
                          </svg>
                          Publicando...
                        </>
                      ) : (
                        <>
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <line x1="22" y1="2" x2="11" y2="13"/>
                            <polygon points="22 2 15 22 11 13 2 9 22 2"/>
                          </svg>
                          &nbsp;Publicar
                        </>
                      )}
                    </button>
                  )}
                  {(camp.status === 'active' || camp.status === 'paused') && (
                    <button style={s.btnOutline} onClick={() => handlePause(camp.id, camp.status)}>
                      {camp.status === 'paused' ? '▶ Reanudar' : '⏸ Pausar'}
                    </button>
                  )}
                  <button style={{ ...s.btnDel, opacity: isDeleting ? 0.6 : 1 }}
                    onClick={() => handleDelete(camp.id, camp.name)} disabled={isDeleting}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  topbar:     { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1.75rem', flexWrap: 'wrap', gap: '1rem' },
  title:      { fontSize: '1.6rem', fontWeight: 700, color: '#0F172A' },
  sub:        { color: '#64748B', fontSize: '0.875rem', marginTop: '0.2rem' },
  searchWrap: { display: 'flex', alignItems: 'center', gap: '0.5rem', background: '#fff', border: '1px solid #E2E8F0', borderRadius: '8px', padding: '0.5rem 0.875rem', width: '220px' },
  searchInput:{ border: 'none', outline: 'none', fontSize: '0.875rem', color: '#0F172A', width: '100%', background: 'transparent' },
  btnPrimary: { display: 'flex', alignItems: 'center', gap: '0.4rem', padding: '0.6rem 1.1rem', borderRadius: '8px', border: 'none', background: '#2563EB', color: '#fff', fontWeight: 600, fontSize: '0.875rem', cursor: 'pointer', whiteSpace: 'nowrap' },
  btnOutline: { padding: '0.45rem 0.875rem', borderRadius: '7px', border: '1px solid #E2E8F0', background: '#fff', color: '#64748B', fontWeight: 500, fontSize: '0.8rem', cursor: 'pointer', whiteSpace: 'nowrap' },
  btnPublish: { display: 'flex', alignItems: 'center', gap: '0.35rem', padding: '0.45rem 0.875rem', borderRadius: '7px', border: 'none', background: '#2563EB', color: '#fff', fontWeight: 600, fontSize: '0.8rem', cursor: 'pointer', whiteSpace: 'nowrap' },
  btnDel:     { display: 'flex', alignItems: 'center', justifyContent: 'center', width: '32px', height: '32px', borderRadius: '7px', border: '1px solid #FECACA', background: '#FFF5F5', color: '#EF4444', cursor: 'pointer', flexShrink: 0 },
  formCard:   { background: '#fff', border: '1px solid #E2E8F0', borderRadius: '14px', padding: '1.5rem', marginBottom: '1.75rem', boxShadow: '0 2px 12px rgba(0,0,0,0.06)' },
  formTitle:  { fontWeight: 700, color: '#0F172A', fontSize: '1.05rem' },
  closeBtn:   { background: 'none', border: 'none', color: '#94A3B8', fontSize: '1rem', cursor: 'pointer', padding: '0.25rem 0.5rem', borderRadius: '6px' },
  formGrid:   { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '1rem' },
  formGroup:  { display: 'flex', flexDirection: 'column', gap: '0.35rem' },
  label:      { color: '#374151', fontSize: '0.8rem', fontWeight: 600 },
  input:      { padding: '0.6rem 0.75rem', borderRadius: '8px', border: '1px solid #E2E8F0', background: '#F8FAFC', color: '#0F172A', fontSize: '0.875rem', outline: 'none' },
  mediaPicker:{ display: 'flex', gap: '0.625rem', flexWrap: 'wrap', marginTop: '0.5rem', maxHeight: '180px', overflowY: 'auto', padding: '0.25rem' },
  mediaThumb: { position: 'relative', width: '96px', flexShrink: 0, borderRadius: '8px', padding: '0.4rem', cursor: 'pointer', transition: 'border-color 0.15s' },
  zoneGrid:   { display: 'flex', flexDirection: 'column', gap: '0.375rem', marginTop: '0.5rem', maxHeight: '200px', overflowY: 'auto' },
  zoneRow:    { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.5rem 0.75rem', borderRadius: '8px', gap: '0.5rem' },
  errorBox:   { display: 'flex', alignItems: 'center', gap: '0.5rem', background: '#FFF5F5', border: '1px solid #FECACA', borderRadius: '8px', padding: '0.6rem 0.875rem', color: '#EF4444', fontSize: '0.8rem', marginTop: '1rem' },
  emptyBox:   { background: '#fff', border: '1px dashed #E2E8F0', borderRadius: '14px', padding: '4rem', textAlign: 'center' },
  campCard:   { background: '#fff', border: '1px solid #E2E8F0', borderRadius: '12px', padding: '1rem 1.25rem', display: 'flex', alignItems: 'center', gap: '1rem', boxShadow: '0 1px 4px rgba(0,0,0,0.04)', flexWrap: 'wrap' },
  campThumb:  { width: '64px', height: '44px', borderRadius: '7px', overflow: 'hidden', background: '#F1F5F9', flexShrink: 0 },
  campName:   { fontWeight: 700, color: '#0F172A', fontSize: '0.95rem' },
  campMeta:   { display: 'flex', alignItems: 'center', gap: '0.5rem', color: '#64748B', fontSize: '0.78rem', marginTop: '0.2rem', flexWrap: 'wrap' },
  badge:      { fontSize: '0.7rem', fontWeight: 600, padding: '2px 8px', borderRadius: '20px' },
  statsRow:   { display: 'flex', gap: '1.25rem', flexShrink: 0 },
  statBox:    { display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: '56px' },
  statVal:    { fontWeight: 700, fontSize: '1.1rem', color: '#0F172A' },
  statLbl:    { fontSize: '0.68rem', color: '#94A3B8', fontWeight: 500, marginTop: '1px' },
  campActions:{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexShrink: 0 },
}
