import { useEffect, useState, useRef } from 'react'
import { supabase } from '../lib/supabase'

type Stat = {
  content_id: string; name: string; type: string
  zone_name: string; program_name: string; organization_id: string
  total_reproductions: number; today_reproductions: number
  last_reproduction: string | null; storage_path?: string
}

export default function Stats() {
  const [stats, setStats] = useState<Stat[]>([])
  const [loading, setLoading] = useState(true)
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null)
  const [liveCount, setLiveCount] = useState(0)
  const [search, setSearch] = useState('')
  const channelRef = useRef<any>(null)

  async function load(silent = false) {
    if (!silent) setLoading(true)
    const { data: profileData } = await supabase.from('profiles').select('organization_id').eq('id', (await supabase.auth.getUser()).data.user?.id ?? '').single()
    if (!profileData?.organization_id) { if (!silent) setLoading(false); return }
    const { data } = await supabase.from('content_stats').select('*').eq('organization_id', profileData.organization_id).order('total_reproductions', { ascending: false })
    if (data) { setStats(data as Stat[]); setLastUpdate(new Date()) }
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
  function getThumbnail(stat: Stat) {
    if (!stat.storage_path || stat.storage_path === '') return null
    try {
      const { data } = supabase.storage.from('media').getPublicUrl(stat.storage_path)
      return data.publicUrl
    } catch {
      return null
    }
  }

  const filtered = stats.filter(r =>
    r.name.toLowerCase().includes(search.toLowerCase()) ||
    r.program_name.toLowerCase().includes(search.toLowerCase()) ||
    r.zone_name.toLowerCase().includes(search.toLowerCase())
  )

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
                {['Contenido', 'Tipo', 'Programa → Zona', 'Hoy', 'Total acumulado', 'Última reproducción'].map(h => (
                  <th key={h} style={s.th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map(row => {
                const thumbUrl = getThumbnail(row)
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