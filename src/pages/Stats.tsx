import { useEffect, useState, useRef } from 'react'
import { supabase } from '../lib/supabase'

type Stat = {
  content_id: string; name: string; type: string
  zone_name: string; program_name: string; organization_id: string
  total_reproductions: number; today_reproductions: number
  last_reproduction: string | null; storage_path?: string
}

type StatEnriched = Stat & { campaign_id: string | null }

type CampaignRow = {
  kind: 'campaign'
  campaign_id: string
  campaign_name: string
  storage_path: string | null
  content_type: string
  zone_count: number
  total_reproductions: number
  today_reproductions: number
  last_reproduction: string | null
}

type ContentRow = { kind: 'content' } & StatEnriched

type DisplayRow = CampaignRow | ContentRow

function getThumbUrl(storage_path: string | null | undefined) {
  if (!storage_path) return null
  try {
    return supabase.storage.from('media').getPublicUrl(storage_path).data.publicUrl
  } catch { return null }
}

export default function Stats({ onGoToCampaign }: { onGoToCampaign?: (id: string) => void }) {
  const [rows, setRows] = useState<DisplayRow[]>([])
  const [loading, setLoading] = useState(true)
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null)
  const [liveCount, setLiveCount] = useState(0)
  const [search, setSearch] = useState('')
  const [deleting, setDeleting] = useState<string | null>(null)
  const channelRef = useRef<any>(null)

  async function load(silent = false) {
    if (!silent) setLoading(true)
    const { data: profileData } = await supabase.from('profiles').select('organization_id').eq('id', (await supabase.auth.getUser()).data.user?.id ?? '').single()
    if (!profileData?.organization_id) { if (!silent) setLoading(false); return }

    const { data } = await supabase.from('content_stats').select('*').eq('organization_id', profileData.organization_id).order('total_reproductions', { ascending: false })
    if (!data) { if (!silent) setLoading(false); return }

    // Enrich with campaign_id from media_content
    const contentIds = (data as Stat[]).map(r => r.content_id)
    let campaignIdMap: Record<string, string | null> = {}
    if (contentIds.length > 0) {
      const { data: contentData } = await supabase.from('media_content').select('id, campaign_id').in('id', contentIds)
      for (const c of (contentData ?? [])) campaignIdMap[c.id] = c.campaign_id ?? null
    }

    const enriched: StatEnriched[] = (data as Stat[]).map(r => ({ ...r, campaign_id: campaignIdMap[r.content_id] ?? null }))

    // Fetch campaign names
    const campaignIds = [...new Set(enriched.filter(r => r.campaign_id).map(r => r.campaign_id as string))]
    const campaignNameMap: Record<string, string> = {}
    if (campaignIds.length > 0) {
      const { data: camps } = await supabase.from('campaigns').select('id, name').in('id', campaignIds)
      for (const c of (camps ?? [])) campaignNameMap[c.id] = c.name
    }

    // Group by campaign_id; non-campaign rows stay individual
    const campaignGroups: Record<string, StatEnriched[]> = {}
    const contentItems: ContentRow[] = []
    for (const r of enriched) {
      if (r.campaign_id) {
        if (!campaignGroups[r.campaign_id]) campaignGroups[r.campaign_id] = []
        campaignGroups[r.campaign_id].push(r)
      } else {
        contentItems.push({ kind: 'content', ...r })
      }
    }

    const campaignRows: CampaignRow[] = Object.entries(campaignGroups).map(([cid, items]) => ({
      kind: 'campaign',
      campaign_id: cid,
      campaign_name: campaignNameMap[cid] ?? 'Campaña',
      storage_path: items.find(i => i.storage_path)?.storage_path ?? null,
      content_type: items[0]?.type ?? 'video',
      zone_count: items.length,
      total_reproductions: items.reduce((s, i) => s + i.total_reproductions, 0),
      today_reproductions: items.reduce((s, i) => s + i.today_reproductions, 0),
      last_reproduction: items.map(i => i.last_reproduction).filter(Boolean).sort().pop() ?? null,
    }))

    const allRows: DisplayRow[] = ([...campaignRows, ...contentItems] as DisplayRow[])
      .sort((a, b) => b.total_reproductions - a.total_reproductions)

    setRows(allRows)
    setLastUpdate(new Date())
    if (!silent) setLoading(false)
  }

  useEffect(() => {
    load()
    const interval = setInterval(() => load(true), 30000)
    channelRef.current = supabase.channel('playback-live')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'playback_events' }, () => {
        setLiveCount(c => c + 1)
        setTimeout(() => load(true), 2000)
      }).subscribe()
    return () => { clearInterval(interval); if (channelRef.current) supabase.removeChannel(channelRef.current) }
  }, [])

  async function handleDeleteStat(row: ContentRow) {
    if (!confirm(`¿Eliminar definitivamente "${row.name}" de las estadísticas?\n\nSe borrará su registro de reproducciones. Esta acción no se puede deshacer.`)) return
    setDeleting(row.content_id)
    await supabase.from('media_content').delete().eq('id', row.content_id)
    if (row.storage_path) {
      const { data: others } = await supabase.from('media_content').select('id').eq('storage_path', row.storage_path).limit(1)
      if (!others || others.length === 0) await supabase.storage.from('media').remove([row.storage_path])
    }
    setDeleting(null)
    load()
  }

  const filtered = rows.filter(r => {
    const term = search.toLowerCase()
    if (!term) return true
    if (r.kind === 'campaign') return r.campaign_name.toLowerCase().includes(term)
    return r.name.toLowerCase().includes(term) ||
      r.program_name.toLowerCase().includes(term) ||
      r.zone_name.toLowerCase().includes(term)
  })

  return (
    <div>
      <div style={s.topbar}>
        <div>
          <h1 style={s.title}>Estadísticas</h1>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginTop: '0.2rem', flexWrap: 'wrap' }}>
            <p style={s.sub}>Reproducciones acumuladas por pantalla</p>
            {lastUpdate && <span style={{ color: '#94A3B8', fontSize: '0.75rem' }}>· Actualizado: {lastUpdate.toLocaleTimeString('es-DO')}</span>}
            {liveCount > 0 && (
              <span style={{ background: '#2563EB', color: '#fff', fontSize: '0.7rem', padding: '2px 8px', borderRadius: '20px', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                <span style={{ width: '6px', height: '6px', background: '#fff', borderRadius: '50%', display: 'inline-block' }} />
                En vivo · {liveCount} hoy
              </span>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
          <div style={s.searchWrap}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#94A3B8" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            <input style={s.searchInput} placeholder="Buscar anuncio..." value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          <button style={s.btnOutline} onClick={() => load()}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
            Actualizar
          </button>
        </div>
      </div>

      {loading ? (
        <p style={{ color: '#94A3B8', marginTop: '2rem' }}>Cargando...</p>
      ) : filtered.length === 0 ? (
        <div style={s.emptyBox}>
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#CBD5E1" strokeWidth="1.5"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>
          <p style={{ color: '#64748B', marginTop: '0.75rem', fontWeight: 500 }}>Sin datos todavía</p>
          <p style={{ color: '#94A3B8', fontSize: '0.85rem', marginTop: '0.25rem' }}>Las estadísticas aparecen cuando las pantallas empiecen a reproducir.</p>
        </div>
      ) : (
        <div style={s.tableWrap}>
          <table style={s.table}>
            <thead>
              <tr>
                {['Contenido', 'Tipo', 'Programa → Zona', 'Hoy', 'Total acumulado', 'Última reproducción', ''].map((h, i) => (
                  <th key={i} style={s.th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map(row => {
                if (row.kind === 'campaign') {
                  const thumbUrl = getThumbUrl(row.storage_path)
                  return (
                    <tr
                      key={`campaign-${row.campaign_id}`}
                      style={{ ...s.tr, cursor: onGoToCampaign ? 'pointer' : undefined }}
                      onClick={() => onGoToCampaign?.(row.campaign_id)}
                    >
                      <td style={s.td}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                          <div style={{ width: '56px', height: '36px', borderRadius: '6px', overflow: 'hidden', background: '#EFF6FF', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px solid #BFDBFE' }}>
                            {thumbUrl
                              ? row.content_type === 'video'
                                ? <video src={thumbUrl} style={{ width: '100%', height: '100%', objectFit: 'cover' }} preload="metadata" muted onLoadedMetadata={e => { e.currentTarget.currentTime = 1 }} />
                                : <img src={thumbUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} />
                              : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#93C5FD" strokeWidth="2"><path d="M3 11l18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/></svg>
                            }
                          </div>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', minWidth: 0 }}>
                            <span style={{ color: '#0F172A', fontWeight: 600, fontSize: '0.875rem' }}>{row.campaign_name}</span>
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem', background: '#EFF6FF', color: '#2563EB', fontSize: '0.68rem', fontWeight: 700, padding: '2px 8px', borderRadius: '20px', border: '1px solid #BFDBFE', width: 'fit-content' }}>
                              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M3 11l18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/></svg>
                              Campaña
                            </span>
                          </div>
                        </div>
                      </td>
                      <td style={s.td}>
                        <span style={{ background: '#EFF6FF', color: '#2563EB', fontSize: '0.72rem', fontWeight: 600, padding: '2px 8px', borderRadius: '20px' }}>
                          Campaña
                        </span>
                      </td>
                      <td style={{ ...s.td, color: '#64748B' }}>
                        {row.zone_count} zona{row.zone_count !== 1 ? 's' : ''}
                      </td>
                      <td style={{ ...s.td, color: '#3B82F6', fontWeight: 700, fontSize: '1rem' }}>{row.today_reproductions}</td>
                      <td style={{ ...s.td, color: '#10B981', fontWeight: 700, fontSize: '1rem' }}>{row.total_reproductions.toLocaleString()}</td>
                      <td style={{ ...s.td, color: '#94A3B8', fontSize: '0.8rem' }}>
                        {row.last_reproduction ? new Date(row.last_reproduction).toLocaleString('es-DO') : '—'}
                      </td>
                      <td style={{ ...s.td, textAlign: 'right' }}>
                        {onGoToCampaign && (
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem', color: '#2563EB', fontSize: '0.78rem', fontWeight: 600 }}>
                            Ver reporte
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
                          </span>
                        )}
                      </td>
                    </tr>
                  )
                }

                // Normal content row
                const thumbUrl = getThumbUrl(row.storage_path)
                return (
                  <tr key={row.content_id} style={s.tr}>
                    <td style={s.td}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                        <div style={{ width: '56px', height: '36px', borderRadius: '6px', overflow: 'hidden', background: '#F1F5F9', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          {thumbUrl
                            ? row.type === 'video'
                              ? <video src={thumbUrl} style={{ width: '100%', height: '100%', objectFit: 'cover' }} preload="metadata" muted onLoadedMetadata={e => { e.currentTarget.currentTime = 1 }} />
                              : <img src={thumbUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} />
                            : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#CBD5E1" strokeWidth="2"><rect x="2" y="3" width="20" height="14" rx="2"/></svg>
                          }
                        </div>
                        <span style={{ color: '#0F172A', fontWeight: 500, fontSize: '0.875rem' }}>{row.name}</span>
                      </div>
                    </td>
                    <td style={s.td}>
                      <span style={{ background: '#F3F0FF', color: '#7C3AED', fontSize: '0.72rem', fontWeight: 600, padding: '2px 8px', borderRadius: '20px' }}>
                        {row.type === 'video' ? 'Video' : row.type === 'image' ? 'Imagen' : 'URL'}
                      </span>
                    </td>
                    <td style={{ ...s.td, color: '#64748B' }}>{row.program_name} → {row.zone_name}</td>
                    <td style={{ ...s.td, color: '#3B82F6', fontWeight: 700, fontSize: '1rem' }}>{row.today_reproductions}</td>
                    <td style={{ ...s.td, color: '#10B981', fontWeight: 700, fontSize: '1rem' }}>{row.total_reproductions.toLocaleString()}</td>
                    <td style={{ ...s.td, color: '#94A3B8', fontSize: '0.8rem' }}>
                      {row.last_reproduction ? new Date(row.last_reproduction).toLocaleString('es-DO') : '—'}
                    </td>
                    <td style={{ ...s.td, textAlign: 'right' }}>
                      <button
                        onClick={() => handleDeleteStat(row)}
                        disabled={deleting === row.content_id}
                        title="Eliminar de estadísticas"
                        style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '30px', height: '30px', borderRadius: '7px', border: '1px solid #FECACA', background: '#FFF5F5', color: '#EF4444', cursor: 'pointer', opacity: deleting === row.content_id ? 0.5 : 1 }}>
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>
                      </button>
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
  sub: { color: '#64748B', fontSize: '0.875rem' },
  searchWrap: { display: 'flex', alignItems: 'center', gap: '0.5rem', background: '#fff', border: '1px solid #E2E8F0', borderRadius: '8px', padding: '0.5rem 0.875rem', width: '220px' },
  searchInput: { border: 'none', outline: 'none', fontSize: '0.875rem', color: '#0F172A', width: '100%', background: 'transparent' },
  btnOutline: { display: 'flex', alignItems: 'center', gap: '0.4rem', padding: '0.6rem 1rem', borderRadius: '8px', border: '1px solid #E2E8F0', background: '#fff', color: '#64748B', fontWeight: 500, fontSize: '0.875rem', cursor: 'pointer' },
  emptyBox: { background: '#fff', border: '1px dashed #E2E8F0', borderRadius: '12px', padding: '4rem', textAlign: 'center' },
  tableWrap: { background: '#fff', border: '1px solid #E2E8F0', borderRadius: '12px', overflow: 'auto', boxShadow: '0 1px 6px rgba(0,0,0,0.04)' },
  table: { width: '100%', borderCollapse: 'collapse' },
  th: { padding: '0.875rem 1.25rem', textAlign: 'left', color: '#94A3B8', fontSize: '0.75rem', fontWeight: 600, borderBottom: '1px solid #F1F5F9', background: '#FAFBFC', whiteSpace: 'nowrap', letterSpacing: '0.03em' },
  tr: { borderBottom: '1px solid #F8FAFC' },
  td: { padding: '0.875rem 1.25rem', color: '#0F172A', fontSize: '0.875rem' },
}
