import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../auth/AuthContext'
import CampaignReport from './CampaignReport'

type Campaign = {
  id: string; name: string; client_name: string | null
  media_content_id: string | null
  starts_at: string; ends_at: string
  daily_start_time: string | null; daily_end_time: string | null
  status: 'draft' | 'active' | 'paused' | 'ended'
  created_at: string; deleted_at: string | null
}
type CampaignStat = {
  campaign_id: string; campaign_name: string; client_name: string | null; status: string
  starts_at: string; ends_at: string; zone_count: number
  total_plays: number; today_plays: number
}
type MediaItem = { id: string; name: string; type: string; storage_path: string; duration_seconds: number | null }
type ScreenNode = {
  screen_id: string; screen_name: string
  program_id: string; program_name: string
  zones: { id: string; name: string }[]
}
type FlatZone = { zone_id: string; zone_name: string; screen_name: string; program_name: string }
type ZoneFreq = { zone_id: string; frequency: number }
// One selected media + the zones it's assigned to
type MediaAssign = { media_id: string; zones: ZoneFreq[] }

const STATUS_LABEL: Record<string, string> = {
  draft: 'Borrador', active: 'Activa', paused: 'Pausada', ended: 'Finalizada'
}
const STATUS_COLOR: Record<string, { bg: string; color: string; border: string }> = {
  draft:  { bg: '#F8FAFC', color: '#64748B', border: '#E2E8F0' },
  active: { bg: '#ECFDF5', color: '#059669', border: '#A7F3D0' },
  paused: { bg: '#FFF7ED', color: '#D97706', border: '#FDE68A' },
  ended:  { bg: '#FEF2F2', color: '#DC2626', border: '#FECACA' },
}
const DEFAULT_FREQ = 24

export default function Campaigns() {
  const { profile } = useAuth()
  const [stats, setStats]         = useState<CampaignStat[]>([])
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [media, setMedia]         = useState<MediaItem[]>([])
  const [tree, setTree]           = useState<ScreenNode[]>([])
  const [loading, setLoading]     = useState(true)
  const [search, setSearch]       = useState('')
  const [reportId, setReportId]   = useState<string | null>(null)

  // Wizard
  const [wizardOpen, setWizardOpen] = useState(false)
  const [editingId, setEditingId]   = useState<string | null>(null)
  const [step, setStep] = useState<1 | 2 | 3>(1)
  const [w1, setW1] = useState({ name: '', client: '', starts: '', ends: '', tStart: '08:00', tEnd: '22:00' })
  const [mediaSearch, setMediaSearch] = useState('')
  const [assigns, setAssigns] = useState<MediaAssign[]>([])
  // per-media zone search box
  const [zoneSearch, setZoneSearch] = useState<Record<string, string>>({})
  const [publishing, setPublishing] = useState(false)
  const [wizardError, setWizardError] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    const { data: pd } = await supabase.from('profiles').select('organization_id').eq('id', profile?.id ?? '').single()
    const orgId = pd?.organization_id
    if (!orgId) { setLoading(false); return }

    const [{ data: campData }, { data: statData }, { data: mediaData }, { data: screenData }, { data: progData }, { data: zoneData }] = await Promise.all([
      supabase.from('campaigns').select('*').eq('organization_id', orgId).is('deleted_at', null).order('created_at', { ascending: false }),
      supabase.from('campaign_stats').select('*').eq('organization_id', orgId),
      supabase.from('media_content').select('id, name, type, storage_path, duration_seconds').is('campaign_id', null).is('zone_id', null).order('created_at', { ascending: false }),
      supabase.from('screens').select('id, name, current_program_id').eq('organization_id', orgId),
      supabase.from('programs').select('id, name').eq('organization_id', orgId),
      supabase.from('zones').select('id, name, program_id'),
    ])

    if (campData) setCampaigns(campData as Campaign[])
    if (statData) setStats(statData as CampaignStat[])

    // Library items (zone_id null) + org zone media, excluding campaign-injected
    const { data: allOrgMedia } = await supabase
      .from('media_content')
      .select('id, name, type, storage_path, duration_seconds, zone_id, campaign_id, zones!inner(program_id, programs!inner(organization_id))')
      .is('campaign_id', null)
    const orgMedia = (allOrgMedia ?? []).filter((m: any) => m.zones?.programs?.organization_id === orgId)
    const merged = [...(mediaData ?? []), ...orgMedia.map((m: any) => ({ id: m.id, name: m.name, type: m.type, storage_path: m.storage_path, duration_seconds: m.duration_seconds }))]
    const seen = new Set<string>()
    setMedia(merged.filter(m => { if (seen.has(m.id)) return false; seen.add(m.id); return true }) as MediaItem[])

    // Build screen → program → zones tree
    const nodes: ScreenNode[] = []
    for (const sc of (screenData ?? [])) {
      const prog = (progData ?? []).find((p: any) => p.id === sc.current_program_id)
      if (!prog) continue
      const zonesOfProg = (zoneData ?? []).filter((z: any) => z.program_id === prog.id).map((z: any) => ({ id: z.id, name: z.name }))
      nodes.push({ screen_id: sc.id, screen_name: sc.name, program_id: prog.id, program_name: prog.name, zones: zonesOfProg })
    }
    setTree(nodes)
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  // Flatten tree into a searchable zone list
  const flatZones: FlatZone[] = tree.flatMap(node =>
    node.zones.map(z => ({ zone_id: z.id, zone_name: z.name, screen_name: node.screen_name, program_name: node.program_name }))
  )
  function zoneLabel(zoneId: string): { screen: string; zone: string } {
    const fz = flatZones.find(z => z.zone_id === zoneId)
    return { screen: fz?.screen_name ?? '—', zone: fz?.zone_name ?? '—' }
  }

  function getPublicUrl(path: string) {
    if (!path) return ''
    return supabase.storage.from('media').getPublicUrl(path).data.publicUrl
  }
  function getStat(id: string) { return stats.find(s => s.campaign_id === id) }
  function getMedia(id: string | null) { return id ? media.find(m => m.id === id) : null }

  function resetWizard() {
    setEditingId(null)
    setStep(1)
    setW1({ name: '', client: '', starts: '', ends: '', tStart: '08:00', tEnd: '22:00' })
    setMediaSearch(''); setAssigns([]); setZoneSearch({})
    setWizardError(null)
  }

  function openCreate() { resetWizard(); setWizardOpen(true) }

  async function openEdit(camp: Campaign) {
    resetWizard()
    setEditingId(camp.id)
    setW1({
      name: camp.name,
      client: camp.client_name ?? '',
      starts: camp.starts_at ? camp.starts_at.slice(0, 10) : '',
      ends: camp.ends_at ? camp.ends_at.slice(0, 10) : '',
      tStart: camp.daily_start_time ? camp.daily_start_time.slice(0, 5) : '08:00',
      tEnd: camp.daily_end_time ? camp.daily_end_time.slice(0, 5) : '22:00',
    })
    // Reconstruct assignments from injected media_content (match by storage_path)
    const { data: rows } = await supabase.from('media_content')
      .select('storage_path, zone_id, daily_frequency').eq('campaign_id', camp.id)
    const map = new Map<string, ZoneFreq[]>()
    for (const row of (rows ?? [])) {
      const m = media.find(mm => mm.storage_path === row.storage_path)
      if (!m || !row.zone_id) continue
      const arr = map.get(m.id) ?? []
      arr.push({ zone_id: row.zone_id, frequency: row.daily_frequency ?? DEFAULT_FREQ })
      map.set(m.id, arr)
    }
    setAssigns(Array.from(map.entries()).map(([media_id, zones]) => ({ media_id, zones })))
    setWizardOpen(true)
  }

  function validateStep(n: number): boolean {
    setWizardError(null)
    if (n === 1) {
      if (!w1.name.trim())        { setWizardError('El nombre es requerido.'); return false }
      if (!w1.client.trim())      { setWizardError('El cliente es requerido.'); return false }
      if (!w1.starts || !w1.ends) { setWizardError('Las fechas son requeridas.'); return false }
      if (new Date(w1.ends) < new Date(w1.starts)) { setWizardError('La fecha fin debe ser posterior al inicio.'); return false }
      if (!w1.tStart || !w1.tEnd) { setWizardError('Los horarios son requeridos.'); return false }
    }
    if (n === 2) {
      if (assigns.length === 0) { setWizardError('Selecciona al menos un contenido.'); return false }
      const empty = assigns.find(a => a.zones.length === 0)
      if (empty) {
        const m = getMedia(empty.media_id)
        setWizardError(`"${m?.name ?? 'Un contenido'}" no tiene zonas asignadas.`); return false
      }
    }
    return true
  }
  function next() { if (validateStep(step) && step < 3) setStep((step + 1) as 1|2|3) }
  function back() { if (step > 1) setStep((step - 1) as 1|2|3) }

  // ── Assignment helpers ──
  function toggleMedia(mediaId: string) {
    setAssigns(prev => prev.find(a => a.media_id === mediaId)
      ? prev.filter(a => a.media_id !== mediaId)
      : [...prev, { media_id: mediaId, zones: [] }])
  }
  function toggleZone(mediaId: string, zoneId: string) {
    setAssigns(prev => prev.map(a => {
      if (a.media_id !== mediaId) return a
      const has = a.zones.find(z => z.zone_id === zoneId)
      return { ...a, zones: has ? a.zones.filter(z => z.zone_id !== zoneId) : [...a.zones, { zone_id: zoneId, frequency: DEFAULT_FREQ }] }
    }))
  }
  function setFreq(mediaId: string, zoneId: string, freq: number) {
    setAssigns(prev => prev.map(a => a.media_id !== mediaId ? a
      : { ...a, zones: a.zones.map(z => z.zone_id === zoneId ? { ...z, frequency: Math.max(1, freq) } : z) }))
  }
  const totalPairs = assigns.reduce((sum, a) => sum + a.zones.length, 0)

  async function publish() {
    setPublishing(true); setWizardError(null)
    const { data: pd } = await supabase.from('profiles').select('organization_id').eq('id', profile?.id ?? '').single()

    const startsAt = `${w1.starts}T00:00:00`
    const endsAt   = `${w1.ends}T23:59:59`
    const cover    = assigns[0]?.media_id ?? null

    let campId = editingId
    if (editingId) {
      const { error } = await supabase.from('campaigns').update({
        name: w1.name.trim(), client_name: w1.client.trim(),
        media_content_id: cover, starts_at: startsAt, ends_at: endsAt,
        daily_start_time: w1.tStart, daily_end_time: w1.tEnd,
      }).eq('id', editingId)
      if (error) { setWizardError(error.message); setPublishing(false); return }
      // Remove previous injected media, we re-insert fresh
      await supabase.from('media_content').delete().eq('campaign_id', editingId)
    } else {
      const { data: camp, error } = await supabase.from('campaigns').insert({
        name: w1.name.trim(), client_name: w1.client.trim(),
        organization_id: pd?.organization_id, media_content_id: cover,
        starts_at: startsAt, ends_at: endsAt,
        daily_start_time: w1.tStart, daily_end_time: w1.tEnd,
        status: 'active', created_by: profile?.id,
      }).select().single()
      if (error || !camp) { setWizardError(error?.message ?? 'Error al crear.'); setPublishing(false); return }
      campId = camp.id
    }

    // Insert one media_content row per (media, zone) pair
    for (const a of assigns) {
      const m = media.find(mm => mm.id === a.media_id)
      if (!m) continue
      for (const z of a.zones) {
        const { error: insErr } = await supabase.from('media_content').insert({
          zone_id: z.zone_id, name: `Campaña ${w1.name.trim()}`, type: m.type,
          storage_path: m.storage_path, duration_seconds: m.duration_seconds,
          uploaded_by: profile?.id, campaign_id: campId,
          daily_frequency: z.frequency, is_unlimited: false, expires_at: endsAt,
        })
        if (insErr) console.warn('Insert pair', a.media_id, z.zone_id, insErr)
      }
    }

    setPublishing(false); setWizardOpen(false); load()
  }

  async function deleteCampaign(id: string, name: string) {
    if (!confirm(`¿Eliminar la campaña "${name}"? Se quitará su contenido de las zonas.`)) return
    await supabase.from('campaigns').update({ deleted_at: new Date().toISOString(), status: 'ended' }).eq('id', id)
    await supabase.from('media_content').delete().eq('campaign_id', id)
    load()
  }

  const filtered = campaigns.filter(c =>
    c.name.toLowerCase().includes(search.toLowerCase()) ||
    (c.client_name ?? '').toLowerCase().includes(search.toLowerCase())
  )

  if (reportId) return <CampaignReport campaignId={reportId} onBack={() => { setReportId(null); load() }} />

  return (
    <div>
      {/* Topbar */}
      <div style={s.topbar} className="page-topbar">
        <div>
          <h1 style={s.title}>Campañas</h1>
          <p style={s.sub}>Publicidad programada · {campaigns.length} creadas</p>
        </div>
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
          <div style={s.searchWrap}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#94A3B8" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            <input style={s.searchInput} placeholder="Buscar por campaña o cliente..." value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          <button style={s.btnPrimary} onClick={openCreate}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            Nueva campaña
          </button>
        </div>
      </div>

      {/* Wizard modal */}
      {wizardOpen && createPortal(
        <div className="backdrop" style={s.modalBackdrop} onClick={e => { if (e.target === e.currentTarget) setWizardOpen(false) }}>
          <div style={s.modalCard}>
            <div style={s.modalHeader}>
              <div>
                <h3 style={{ fontWeight: 700, color: '#0F172A', fontSize: '1.1rem' }}>{editingId ? 'Editar campaña' : 'Nueva campaña'}</h3>
                <p style={{ color: '#94A3B8', fontSize: '0.8rem', marginTop: '2px' }}>Paso {step} de 3</p>
              </div>
              <button onClick={() => setWizardOpen(false)} style={s.closeBtn}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>

            {/* Stepper */}
            <div style={s.stepper}>
              {[1,2,3].map(n => (
                <div key={n} style={{ display: 'flex', alignItems: 'center', flex: n === 3 ? 0 : 1 }}>
                  <div style={{ ...s.stepDot, background: n <= step ? '#2563EB' : '#E2E8F0', color: n <= step ? '#fff' : '#94A3B8' }}>
                    {n < step
                      ? <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3"><polyline points="20 6 9 17 4 12"/></svg>
                      : n}
                  </div>
                  {n < 3 && <div style={{ ...s.stepLine, background: n < step ? '#2563EB' : '#E2E8F0' }} />}
                </div>
              ))}
            </div>

            <div style={s.modalBody}>
              {/* ─── PASO 1 ─── */}
              {step === 1 && (
                <div>
                  <h4 style={s.stepTitle}>Información básica</h4>
                  <div style={s.formGrid}>
                    <div style={{ ...s.formGroup, gridColumn: '1 / -1' }}>
                      <label style={s.label}>Nombre de la campaña</label>
                      <input style={s.input} value={w1.name} onChange={e => setW1({ ...w1, name: e.target.value })} placeholder="Ej: Coca-Cola Diciembre" />
                    </div>
                    <div style={{ ...s.formGroup, gridColumn: '1 / -1' }}>
                      <label style={s.label}>Nombre del cliente</label>
                      <input style={s.input} value={w1.client} onChange={e => setW1({ ...w1, client: e.target.value })} placeholder="Ej: Coca-Cola RD" />
                    </div>
                    <div style={s.formGroup}>
                      <label style={s.label}>Fecha de inicio</label>
                      <input style={s.input} type="date" value={w1.starts} onChange={e => setW1({ ...w1, starts: e.target.value })} />
                    </div>
                    <div style={s.formGroup}>
                      <label style={s.label}>Fecha de fin</label>
                      <input style={s.input} type="date" value={w1.ends} onChange={e => setW1({ ...w1, ends: e.target.value })} />
                    </div>
                    <div style={s.formGroup}>
                      <label style={s.label}>Horario inicio</label>
                      <input style={s.input} type="time" value={w1.tStart} onChange={e => setW1({ ...w1, tStart: e.target.value })} />
                    </div>
                    <div style={s.formGroup}>
                      <label style={s.label}>Horario fin</label>
                      <input style={s.input} type="time" value={w1.tEnd} onChange={e => setW1({ ...w1, tEnd: e.target.value })} />
                    </div>
                  </div>
                </div>
              )}

              {/* ─── PASO 2: Contenido + zonas ─── */}
              {step === 2 && (
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem', flexWrap: 'wrap', gap: '0.5rem' }}>
                    <h4 style={s.stepTitle}>Contenido y zonas</h4>
                    <div style={s.searchWrap}>
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#94A3B8" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                      <input style={{ ...s.searchInput, width: '170px' }} placeholder="Buscar archivo..." value={mediaSearch} onChange={e => setMediaSearch(e.target.value)} />
                    </div>
                  </div>
                  <p style={{ fontSize: '0.8rem', color: '#94A3B8', marginBottom: '0.75rem' }}>
                    Selecciona uno o varios contenidos, y a cada uno asígnale las zonas donde se mostrará.
                  </p>

                  {/* Media gallery (multi-select) */}
                  <div style={s.mediaGrid}>
                    {media.length === 0 ? (
                      <p style={s.emptyMsg}>No hay contenido en la biblioteca. Sube archivos primero en la sección Contenido.</p>
                    ) : (
                      media.filter(m => m.name.toLowerCase().includes(mediaSearch.toLowerCase())).map(item => {
                        const url = getPublicUrl(item.storage_path)
                        const a = assigns.find(x => x.media_id === item.id)
                        const selected = !!a
                        return (
                          <div key={item.id} onClick={() => toggleMedia(item.id)}
                            style={{ ...s.mediaCard, border: selected ? '2px solid #2563EB' : '2px solid transparent', boxShadow: selected ? '0 0 0 3px rgba(37,99,235,0.15)' : 'none' }}>
                            <div style={s.mediaThumb}>
                              {item.type === 'image' && <img src={url} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />}
                              {item.type === 'video' && (
                                <>
                                  <video src={url + '#t=1'} style={{ width: '100%', height: '100%', objectFit: 'cover' }} preload="metadata" muted playsInline />
                                  <div style={s.playOverlay}><svg width="14" height="14" viewBox="0 0 24 24" fill="white"><polygon points="5,3 19,12 5,21"/></svg></div>
                                </>
                              )}
                              {item.type === 'url' && <div style={{ width: '100%', height: '100%', background: '#DBEAFE', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.5rem' }}>🌐</div>}
                            </div>
                            <div style={{ padding: '0.45rem 0.5rem' }}>
                              <p style={{ fontSize: '0.72rem', color: '#0F172A', fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.name}</p>
                              {selected && (
                                <p style={{ fontSize: '0.64rem', color: '#2563EB', fontWeight: 600, marginTop: '2px' }}>
                                  {a!.zones.length} {a!.zones.length === 1 ? 'zona' : 'zonas'}
                                </p>
                              )}
                            </div>
                            {selected && (
                              <div style={s.selectedTick}>
                                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3.5"><polyline points="20 6 9 17 4 12"/></svg>
                              </div>
                            )}
                          </div>
                        )
                      })
                    )}
                  </div>

                  {/* Zone assignment per selected media */}
                  {assigns.length > 0 && (
                    <div style={{ marginTop: '1.25rem' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.625rem' }}>
                        <div style={{ height: '1px', background: '#E2E8F0', flex: 1 }} />
                        <span style={{ fontSize: '0.75rem', fontWeight: 700, color: '#64748B', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                          Asignar zonas · {totalPairs} {totalPairs === 1 ? 'destino' : 'destinos'}
                        </span>
                        <div style={{ height: '1px', background: '#E2E8F0', flex: 1 }} />
                      </div>

                      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                        {assigns.map(a => {
                          const m = getMedia(a.media_id)
                          if (!m) return null
                          const q = (zoneSearch[a.media_id] ?? '').toLowerCase()
                          const visibleZones = flatZones.filter(z =>
                            z.zone_name.toLowerCase().includes(q) ||
                            z.screen_name.toLowerCase().includes(q) ||
                            z.program_name.toLowerCase().includes(q)
                          )
                          return (
                            <div key={a.media_id} style={s.assignCard}>
                              <div style={s.assignHeader}>
                                <div style={s.assignThumb}>
                                  {m.type === 'video'
                                    ? <video src={getPublicUrl(m.storage_path) + '#t=1'} style={{ width: '100%', height: '100%', objectFit: 'cover' }} preload="metadata" muted />
                                    : m.type === 'image'
                                      ? <img src={getPublicUrl(m.storage_path)} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                                      : <div style={{ width: '100%', height: '100%', background: '#DBEAFE', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>🌐</div>
                                  }
                                </div>
                                <div style={{ flex: 1, minWidth: 0 }}>
                                  <p style={{ fontSize: '0.85rem', fontWeight: 700, color: '#0F172A', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.name}</p>
                                  <p style={{ fontSize: '0.72rem', color: a.zones.length ? '#059669' : '#DC2626', fontWeight: 600 }}>
                                    {a.zones.length ? `${a.zones.length} ${a.zones.length === 1 ? 'zona asignada' : 'zonas asignadas'}` : 'Sin zonas — asigna al menos una'}
                                  </p>
                                </div>
                                <button onClick={() => toggleMedia(a.media_id)} style={s.assignRemove} title="Quitar contenido">
                                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                                </button>
                              </div>

                              {/* zone search */}
                              <div style={{ ...s.searchWrap, margin: '0.625rem 0', width: '100%' }}>
                                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#94A3B8" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                                <input style={{ ...s.searchInput, width: '100%' }} placeholder="Buscar zona por nombre, pantalla o programa..."
                                  value={zoneSearch[a.media_id] ?? ''}
                                  onChange={e => setZoneSearch({ ...zoneSearch, [a.media_id]: e.target.value })} />
                              </div>

                              {/* zone list */}
                              <div style={s.zonePickList}>
                                {visibleZones.length === 0
                                  ? <p style={{ fontSize: '0.78rem', color: '#94A3B8', padding: '0.5rem', textAlign: 'center' }}>Sin zonas que coincidan.</p>
                                  : visibleZones.map(z => {
                                    const zf = a.zones.find(x => x.zone_id === z.zone_id)
                                    return (
                                      <div key={z.zone_id} style={{ ...s.zonePickRow, background: zf ? '#EFF6FF' : 'transparent' }}>
                                        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', flex: 1, minWidth: 0 }}>
                                          <input type="checkbox" checked={!!zf} onChange={() => toggleZone(a.media_id, z.zone_id)} style={{ accentColor: '#2563EB', width: '15px', height: '15px', flexShrink: 0 }} />
                                          <span style={{ fontSize: '1rem', flexShrink: 0 }}>📺</span>
                                          <span style={{ fontSize: '0.82rem', color: '#0F172A', fontWeight: zf ? 600 : 400, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                            {z.screen_name} <span style={{ color: '#CBD5E1' }}>→</span> {z.zone_name}
                                          </span>
                                        </label>
                                        {zf && (
                                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', flexShrink: 0 }}>
                                            <input type="number" min={1} max={999} value={zf.frequency}
                                              onChange={e => setFreq(a.media_id, z.zone_id, +e.target.value)} style={s.freqInput} />
                                            <span style={{ fontSize: '0.7rem', color: '#64748B' }}>/día</span>
                                          </div>
                                        )}
                                      </div>
                                    )
                                  })
                                }
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* ─── PASO 3: Resumen ─── */}
              {step === 3 && (
                <div>
                  <h4 style={s.stepTitle}>Revisa y publica</h4>
                  <div style={s.summaryInfo}>
                    <div><p style={s.summaryLabel}>Campaña</p><p style={s.summaryValue}>{w1.name}</p></div>
                    <div><p style={s.summaryLabel}>Cliente</p><p style={s.summaryValue}>{w1.client}</p></div>
                    <div><p style={s.summaryLabel}>Período</p><p style={s.summarySub}>{new Date(w1.starts).toLocaleDateString('es-DO')} → {new Date(w1.ends).toLocaleDateString('es-DO')}</p></div>
                    <div><p style={s.summaryLabel}>Horario</p><p style={s.summarySub}>{w1.tStart} – {w1.tEnd}</p></div>
                  </div>

                  <p style={{ ...s.summaryLabel, marginTop: '1.25rem', marginBottom: '0.5rem' }}>
                    Contenidos y destinos ({assigns.length} {assigns.length === 1 ? 'contenido' : 'contenidos'} · {totalPairs} {totalPairs === 1 ? 'zona' : 'zonas'})
                  </p>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.625rem' }}>
                    {assigns.map(a => {
                      const m = getMedia(a.media_id)
                      if (!m) return null
                      return (
                        <div key={a.media_id} style={s.summaryMediaCard}>
                          <div style={s.assignThumb}>
                            {m.type === 'video'
                              ? <video src={getPublicUrl(m.storage_path) + '#t=1'} style={{ width: '100%', height: '100%', objectFit: 'cover' }} preload="metadata" muted />
                              : m.type === 'image'
                                ? <img src={getPublicUrl(m.storage_path)} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                                : <div style={{ width: '100%', height: '100%', background: '#DBEAFE', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>🌐</div>
                            }
                          </div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <p style={{ fontSize: '0.85rem', fontWeight: 700, color: '#0F172A', marginBottom: '0.35rem' }}>{m.name}</p>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem' }}>
                              {a.zones.map(z => {
                                const lbl = zoneLabel(z.zone_id)
                                return (
                                  <span key={z.zone_id} style={s.zoneChip}>
                                    {lbl.screen} → {lbl.zone}
                                    <span style={{ background: '#2563EB', color: '#fff', fontWeight: 700, fontSize: '0.65rem', padding: '1px 6px', borderRadius: '10px', marginLeft: '4px' }}>{z.frequency}×</span>
                                  </span>
                                )
                              })}
                            </div>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>

            {wizardError && (
              <div style={s.errorBox}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                {wizardError}
              </div>
            )}

            <div style={s.modalFooter}>
              <button onClick={() => setWizardOpen(false)} style={s.btnOutline}>Cancelar</button>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                {step > 1 && <button onClick={back} style={s.btnGhost}>← Atrás</button>}
                {step < 3
                  ? <button onClick={next} style={s.btnPrimary}>Siguiente →</button>
                  : <button onClick={publish} disabled={publishing} style={{ ...s.btnPublish, opacity: publishing ? 0.7 : 1 }}>
                      {publishing ? (
                        <><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" style={{ animation: 'spin 0.8s linear infinite' }}><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>{editingId ? 'Guardando...' : 'Publicando...'}</>
                      ) : (
                        <><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>&nbsp;{editingId ? 'Guardar cambios' : 'Publicar campaña'}</>
                      )}
                    </button>
                }
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Campaign list */}
      {loading ? (
        <div style={{ display: 'grid', gap: '1rem' }}>
          {[0,1,2].map(i => <div key={i} className="skeleton" style={{ height: '120px', borderRadius: '14px' }} />)}
        </div>
      ) : filtered.length === 0 ? (
        <div style={s.emptyBox}>
          <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="#CBD5E1" strokeWidth="1.5"><path d="M3 11l18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/></svg>
          <p style={{ color: '#64748B', fontWeight: 500, marginTop: '0.875rem' }}>No hay campañas todavía.</p>
          <p style={{ color: '#94A3B8', fontSize: '0.85rem', marginTop: '0.25rem' }}>Crea tu primera campaña con el wizard.</p>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '1rem' }}>
          {filtered.map(camp => {
            const stat = getStat(camp.id)
            const sc = STATUS_COLOR[camp.status]
            const mediaItem = getMedia(camp.media_content_id)
            const startTs = new Date(camp.starts_at).getTime()
            const endTs = new Date(camp.ends_at).getTime()
            const progress = Math.max(0, Math.min(100, ((Date.now() - startTs) / Math.max(1, endTs - startTs)) * 100))

            return (
              <div key={camp.id} style={s.campCard} className="card-hover">
                <div style={s.campThumb}>
                  {mediaItem?.type === 'video'
                    ? <video src={getPublicUrl(mediaItem.storage_path) + '#t=1'} style={{ width: '100%', height: '100%', objectFit: 'cover' }} preload="metadata" muted />
                    : mediaItem?.type === 'image'
                      ? <img src={getPublicUrl(mediaItem.storage_path)} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                      : <div style={{ width: '100%', height: '100%', background: 'linear-gradient(135deg, #1E3A5F, #2563EB)' }} />
                  }
                  {mediaItem?.type === 'video' && (
                    <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', width: '30px', height: '30px', background: 'rgba(0,0,0,0.55)', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="white"><polygon points="5,3 19,12 5,21"/></svg>
                    </div>
                  )}
                  <span style={{ position: 'absolute', top: '8px', right: '8px', ...s.badge, background: sc.bg, color: sc.color, border: `1px solid ${sc.border}` }}>
                    {STATUS_LABEL[camp.status]}
                  </span>
                </div>

                <div style={{ padding: '1rem 1.125rem' }}>
                  <p style={s.campName}>{camp.name}</p>
                  <p style={s.campClient}>{camp.client_name ?? '—'}</p>

                  <div style={{ marginTop: '0.75rem' }}>
                    <div style={{ height: '5px', background: '#F1F5F9', borderRadius: '999px', overflow: 'hidden' }}>
                      <div style={{ height: '100%', width: `${progress}%`, background: 'linear-gradient(90deg, #3B82F6, #2563EB)', transition: 'width 0.3s' }} />
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '4px' }}>
                      <span style={s.progressLabel}>{new Date(camp.starts_at).toLocaleDateString('es-DO', { day: '2-digit', month: 'short' })}</span>
                      <span style={s.progressLabel}>{new Date(camp.ends_at).toLocaleDateString('es-DO', { day: '2-digit', month: 'short' })}</span>
                    </div>
                  </div>

                  <div style={s.campStats}>
                    <div style={s.campStat}><span style={s.campStatVal}>{stat?.zone_count ?? 0}</span><span style={s.campStatLbl}>Zonas</span></div>
                    <div style={s.campStat}><span style={s.campStatVal}>{(stat?.total_plays ?? 0).toLocaleString()}</span><span style={s.campStatLbl}>Reproducciones</span></div>
                  </div>

                  <div style={s.campActions}>
                    <button onClick={() => setReportId(camp.id)} style={s.btnAct}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                      Reporte
                    </button>
                    <button onClick={() => openEdit(camp)} style={s.btnAct}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                      Editar
                    </button>
                    <button onClick={() => deleteCampaign(camp.id, camp.name)} style={s.btnDel}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
                    </button>
                  </div>
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
  searchWrap: { display: 'flex', alignItems: 'center', gap: '0.5rem', background: '#fff', border: '1px solid #E2E8F0', borderRadius: '8px', padding: '0.4rem 0.75rem' },
  searchInput:{ border: 'none', outline: 'none', fontSize: '0.85rem', color: '#0F172A', background: 'transparent', width: '260px' },
  btnPrimary: { display: 'flex', alignItems: 'center', gap: '0.4rem', padding: '0.6rem 1.1rem', borderRadius: '8px', border: 'none', background: '#2563EB', color: '#fff', fontWeight: 600, fontSize: '0.875rem', cursor: 'pointer', whiteSpace: 'nowrap' },
  btnOutline: { padding: '0.55rem 1rem', borderRadius: '7px', border: '1px solid #E2E8F0', background: '#fff', color: '#64748B', fontWeight: 500, fontSize: '0.85rem', cursor: 'pointer' },
  btnGhost:   { padding: '0.55rem 1rem', borderRadius: '7px', border: 'none', background: 'transparent', color: '#64748B', fontWeight: 500, fontSize: '0.85rem', cursor: 'pointer' },
  btnPublish: { display: 'flex', alignItems: 'center', gap: '0.3rem', padding: '0.6rem 1.25rem', borderRadius: '8px', border: 'none', background: '#059669', color: '#fff', fontWeight: 700, fontSize: '0.9rem', cursor: 'pointer', whiteSpace: 'nowrap' },

  modalBackdrop: { position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.5)', backdropFilter: 'blur(4px)', zIndex: 500, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '4vh 1rem', overflowY: 'auto' },
  modalCard:  { background: '#fff', borderRadius: '16px', width: '100%', maxWidth: '780px', maxHeight: '92vh', display: 'flex', flexDirection: 'column', boxShadow: '0 24px 64px rgba(0,0,0,0.25)', margin: 'auto' },
  modalHeader:{ padding: '1.25rem 1.5rem 1rem', borderBottom: '1px solid #F1F5F9', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' },
  modalBody:  { padding: '1.25rem 1.5rem', overflowY: 'auto', flex: 1, minHeight: 0 },
  modalFooter:{ padding: '1rem 1.5rem', borderTop: '1px solid #F1F5F9', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem' },
  closeBtn:   { display: 'flex', alignItems: 'center', justifyContent: 'center', width: '30px', height: '30px', background: '#F8FAFC', border: '1px solid #E2E8F0', borderRadius: '7px', cursor: 'pointer', color: '#94A3B8' },

  stepper:    { display: 'flex', alignItems: 'center', padding: '0 1.5rem 1rem', gap: '0.25rem' },
  stepDot:    { width: '28px', height: '28px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: '0.82rem', flexShrink: 0, transition: 'all 0.2s' },
  stepLine:   { flex: 1, height: '2px', transition: 'background 0.2s' },
  stepTitle:  { fontWeight: 700, color: '#0F172A', fontSize: '1rem' },

  formGrid:   { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0.875rem' },
  formGroup:  { display: 'flex', flexDirection: 'column', gap: '0.35rem' },
  label:      { color: '#374151', fontSize: '0.8rem', fontWeight: 600 },
  input:      { padding: '0.6rem 0.75rem', borderRadius: '8px', border: '1px solid #E2E8F0', background: '#F8FAFC', color: '#0F172A', fontSize: '0.875rem', outline: 'none' },

  mediaGrid:  { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: '0.625rem' },
  mediaCard:  { position: 'relative', background: '#fff', borderRadius: '10px', cursor: 'pointer', overflow: 'hidden', border: '2px solid transparent', transition: 'all 0.15s' },
  mediaThumb: { position: 'relative', width: '100%', aspectRatio: '16/9', background: '#0F172A', overflow: 'hidden' },
  playOverlay:{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' },
  selectedTick:{ position: 'absolute', top: '6px', right: '6px', width: '20px', height: '20px', background: '#2563EB', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 2px 6px rgba(37,99,235,0.5)' },

  assignCard: { background: '#FAFBFC', border: '1px solid #E2E8F0', borderRadius: '12px', padding: '0.875rem' },
  assignHeader:{ display: 'flex', alignItems: 'center', gap: '0.75rem' },
  assignThumb:{ width: '52px', height: '36px', borderRadius: '6px', overflow: 'hidden', background: '#0F172A', flexShrink: 0 },
  assignRemove:{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '26px', height: '26px', borderRadius: '6px', border: '1px solid #FECACA', background: '#FFF5F5', color: '#EF4444', cursor: 'pointer', flexShrink: 0 },
  zonePickList:{ display: 'flex', flexDirection: 'column', gap: '0.2rem', maxHeight: '200px', overflowY: 'auto', background: '#fff', border: '1px solid #E2E8F0', borderRadius: '8px', padding: '0.375rem' },
  zonePickRow:{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.4rem 0.5rem', borderRadius: '6px', transition: 'background 0.15s' },
  freqInput:  { padding: '0.2rem 0.35rem', borderRadius: '6px', border: '1px solid #E2E8F0', background: '#fff', color: '#0F172A', fontSize: '0.8rem', outline: 'none', width: '50px', textAlign: 'center' },

  summaryInfo:{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '1rem', background: '#F8FAFC', border: '1px solid #F1F5F9', borderRadius: '12px', padding: '1rem 1.25rem' },
  summaryLabel:{ fontSize: '0.7rem', color: '#94A3B8', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' },
  summaryValue:{ fontSize: '0.95rem', fontWeight: 700, color: '#0F172A', marginTop: '2px' },
  summarySub: { fontSize: '0.85rem', color: '#64748B', marginTop: '2px' },
  summaryMediaCard:{ display: 'flex', gap: '0.75rem', background: '#FAFBFC', border: '1px solid #E2E8F0', borderRadius: '10px', padding: '0.75rem' },
  zoneChip:   { display: 'inline-flex', alignItems: 'center', background: '#fff', border: '1px solid #E2E8F0', borderRadius: '20px', padding: '2px 4px 2px 9px', fontSize: '0.72rem', color: '#475569', fontWeight: 500 },

  emptyMsg:   { color: '#94A3B8', fontSize: '0.9rem', padding: '2rem', textAlign: 'center' as const, gridColumn: '1 / -1' },
  errorBox:   { display: 'flex', alignItems: 'center', gap: '0.5rem', margin: '0 1.5rem', padding: '0.7rem 0.875rem', background: '#FFF5F5', border: '1px solid #FECACA', borderRadius: '8px', color: '#EF4444', fontSize: '0.82rem' },

  campCard:   { background: '#fff', border: '1px solid #E2E8F0', borderRadius: '14px', overflow: 'hidden', display: 'flex', flexDirection: 'column' },
  campThumb:  { position: 'relative', width: '100%', aspectRatio: '16/9', background: '#0F172A', overflow: 'hidden' },
  campName:   { fontSize: '1rem', fontWeight: 700, color: '#0F172A', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  campClient: { fontSize: '0.78rem', color: '#64748B', marginTop: '2px' },
  progressLabel:{ fontSize: '0.68rem', color: '#94A3B8', fontWeight: 500 },
  badge:      { fontSize: '0.68rem', fontWeight: 700, padding: '3px 9px', borderRadius: '20px' },
  campStats:  { display: 'flex', gap: '1.5rem', marginTop: '0.875rem', paddingTop: '0.875rem', borderTop: '1px solid #F1F5F9' },
  campStat:   { display: 'flex', flexDirection: 'column' },
  campStatVal:{ fontSize: '1.15rem', fontWeight: 700, color: '#0F172A' },
  campStatLbl:{ fontSize: '0.68rem', color: '#94A3B8', fontWeight: 500 },
  campActions:{ display: 'flex', gap: '0.5rem', marginTop: '0.875rem' },
  btnAct:     { display: 'flex', alignItems: 'center', gap: '0.3rem', flex: 1, justifyContent: 'center', padding: '0.5rem 0.5rem', borderRadius: '7px', border: '1px solid #E2E8F0', background: '#fff', color: '#2563EB', fontWeight: 600, fontSize: '0.78rem', cursor: 'pointer' },
  btnDel:     { display: 'flex', alignItems: 'center', justifyContent: 'center', width: '34px', height: '34px', borderRadius: '7px', border: '1px solid #FECACA', background: '#FFF5F5', color: '#EF4444', cursor: 'pointer', flexShrink: 0 },

  emptyBox:   { background: '#fff', border: '1px dashed #E2E8F0', borderRadius: '14px', padding: '4rem', textAlign: 'center' },
}
