import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../auth/AuthContext'

type MediaItem = { id: string; name: string; type: string; storage_path: string; created_at: string }
type Program = { id: string; name: string; thumbnail_url: string | null; published_at: string | null }
type Screen = { id: string; name: string; last_heartbeat: string | null; current_program_id: string | null; is_active: boolean }
type ProgramMap = Record<string, string>

function getStatus(hb: string | null, prog: string | null) {
  if (!prog) return { dot: '#CBD5E1' }
  if (!hb) return { dot: '#F59E0B' }
  const mins = (Date.now() - new Date(hb).getTime()) / 60000
  if (mins < 2) return { dot: '#10B981' }
  return { dot: '#F59E0B' }
}

export default function DashboardHome({
  onNavigate,
  onEditProgram,
}: {
  onNavigate?: (p: string) => void
  onEditProgram?: (id: string) => void
}) {
  const { profile } = useAuth()
  const [media, setMedia] = useState<MediaItem[]>([])
  const [programs, setPrograms] = useState<Program[]>([])
  const [screens, setScreens] = useState<Screen[]>([])
  const [programMap, setProgramMap] = useState<ProgramMap>({})
  const [loading, setLoading] = useState(true)
  const [publishing, setPublishing] = useState<string | null>(null)

  const nav = onNavigate ?? (() => {})

  async function load() {
    setLoading(true)
    const { data: profileData } = await supabase
      .from('profiles').select('organization_id').eq('id', profile?.id ?? '').single()
    const orgId = profileData?.organization_id

    const [{ data: mediaData }, { data: progData }, { data: screenData }] = await Promise.all([
      supabase.from('media_content').select('id, name, type, storage_path, created_at').order('created_at', { ascending: false }).limit(8),
      supabase.from('programs').select('id, name, thumbnail_url, published_at').eq('organization_id', orgId ?? '').order('created_at', { ascending: false }).limit(8),
      supabase.from('screens').select('id, name, last_heartbeat, current_program_id, is_active').eq('organization_id', orgId ?? '').order('name'),
    ])

    if (mediaData) setMedia(mediaData as MediaItem[])
    if (progData) setPrograms(progData as Program[])
    if (screenData) setScreens(screenData as Screen[])

    if (progData) {
      const map: ProgramMap = {}
      progData.forEach((p: any) => { map[p.id] = p.name })
      // Fetch all programs for name map (not just 8)
      const { data: allProgs } = await supabase.from('programs').select('id, name').eq('organization_id', orgId ?? '')
      if (allProgs) allProgs.forEach((p: any) => { map[p.id] = p.name })
      setProgramMap(map)
    }
    setLoading(false)
  }

  async function handlePublish(programId: string) {
    setPublishing(programId)
    const now = new Date().toISOString()
    await supabase.from('programs').update({ published_at: now }).eq('id', programId)
    await supabase.from('screens').update({ updated_at: now } as any).eq('current_program_id', programId)
    setPublishing(null); load()
  }

  function getPublicUrl(path: string) {
    return supabase.storage.from('media').getPublicUrl(path).data.publicUrl
  }

  const online = screens.filter(sc => {
    if (!sc.current_program_id || !sc.last_heartbeat) return false
    return (Date.now() - new Date(sc.last_heartbeat).getTime()) / 60000 < 2
  }).length
  const offline = screens.length - online

  useEffect(() => { load() }, [])

  return (
    <div>
      {/* Header */}
      <div style={s.pageHeader}>
        <div>
          <h1 style={s.title}>Bienvenido, {profile?.full_name} 👋</h1>
          <p style={s.sub}>{(profile as any)?.organization_name ?? 'GestorPlayer'} · Panel de control</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <div style={s.statPill}>
            <div style={{ ...s.dot, background: '#10B981', boxShadow: '0 0 6px #10B981' }} />
            En línea: <strong>{online}</strong>
          </div>
          <div style={s.statPill}>
            <div style={{ ...s.dot, background: '#CBD5E1' }} />
            Desconectado: <strong>{offline}</strong>
          </div>
        </div>
      </div>

      {loading ? (
        <div style={s.grid3}>
          {[0, 1, 2].map(i => <div key={i} style={{ height: '500px', borderRadius: '14px' }} className="skeleton" />)}
        </div>
      ) : (
        <div style={s.grid3}>

          {/* Panel 1: Mis medios */}
          <div style={s.panel}>
            <div style={s.panelHeader}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <div style={{ ...s.panelIcon, background: '#FEF3C7' }}>📁</div>
                <span style={s.panelTitle}>Mis medios</span>
              </div>
              <button style={s.btnPrimary} onClick={() => nav('content')}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                Subir medios
              </button>
            </div>
            <div style={s.colHeader}>
              <span>Nombre del medio</span>
              <span>Actualizado</span>
            </div>
            <div style={s.list}>
              {media.length === 0
                ? <p style={s.empty}>Sin medios todavía.</p>
                : media.map(item => (
                  <div key={item.id} style={s.listRow} className="table-row">
                    <div style={s.thumb}>
                      {item.type === 'image'
                        ? <img src={getPublicUrl(item.storage_path)} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                        : item.type === 'video'
                          ? <video src={getPublicUrl(item.storage_path)} style={{ width: '100%', height: '100%', objectFit: 'cover' }} preload="metadata" muted onLoadedMetadata={e => { e.currentTarget.currentTime = 1 }} />
                          : <div style={{ width: '100%', height: '100%', background: '#DBEAFE', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>🌐</div>
                      }
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <p style={s.itemName}>{item.name}</p>
                    </div>
                    <span style={s.itemDate}>
                      {new Date(item.created_at).toLocaleString('es-DO', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                ))
              }
            </div>
            <div style={s.panelFooter}>
              <span style={s.footerLink} onClick={() => nav('content')}>Ver biblioteca de medios →</span>
            </div>
          </div>

          {/* Panel 2: Mis programas */}
          <div style={s.panel}>
            <div style={s.panelHeader}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <div style={{ ...s.panelIcon, background: '#DBEAFE' }}>▣</div>
                <span style={s.panelTitle}>Mis programas</span>
              </div>
              <button style={s.btnPrimary} onClick={() => nav('programs')}>+ Programa</button>
            </div>
            <div style={s.colHeader}>
              <span>Nombre del programa</span>
              <span>Operar</span>
            </div>
            <div style={s.list}>
              {programs.length === 0
                ? <p style={s.empty}>Sin programas todavía.</p>
                : programs.map(p => (
                  <div key={p.id} style={s.listRow} className="table-row">
                    <div style={s.thumb}>
                      {p.thumbnail_url
                        ? <img src={p.thumbnail_url} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                        : <div style={{ width: '100%', height: '100%', background: 'linear-gradient(135deg, #1E3A5F, #2563EB)' }} />
                      }
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <p style={{ ...s.itemName, cursor: 'pointer', color: '#0F172A' }}
                        onClick={() => onEditProgram?.(p.id)}>
                        {p.name}
                      </p>
                    </div>
                    <button
                      onClick={() => handlePublish(p.id)}
                      disabled={publishing === p.id}
                      style={{ background: 'none', border: 'none', color: '#2563EB', fontSize: '0.78rem', fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.25rem', flexShrink: 0, padding: '0.25rem 0', opacity: publishing === p.id ? 0.5 : 1 }}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
                      {publishing === p.id ? '...' : 'Publicar'}
                    </button>
                  </div>
                ))
              }
            </div>
            <div style={s.panelFooter}>
              <span style={s.footerLink} onClick={() => nav('programs')}>Ver programas →</span>
            </div>
          </div>

          {/* Panel 3: Mis pantallas */}
          <div style={s.panel}>
            <div style={s.panelHeader}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <div style={{ ...s.panelIcon, background: '#D1FAE5' }}>◫</div>
                <span style={s.panelTitle}>Mis pantallas</span>
              </div>
              <button style={s.btnPrimary} onClick={() => nav('screens')}>+ Agregar</button>
            </div>
            <div style={s.colHeader}>
              <span>Nombre de la pantalla</span>
              <span>Programa actual</span>
            </div>
            <div style={s.list}>
              {screens.length === 0
                ? <p style={s.empty}>Sin pantallas registradas.</p>
                : screens.map(sc => {
                  const status = getStatus(sc.last_heartbeat, sc.current_program_id)
                  const progId = sc.current_program_id
                  const progName = progId ? programMap[progId] : null
                  return (
                    <div key={sc.id} style={s.listRow} className="table-row">
                      <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: status.dot, flexShrink: 0, boxShadow: status.dot === '#10B981' ? '0 0 5px #10B981' : 'none' }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <p style={s.itemName}>{sc.name}</p>
                      </div>
                      {progId && progName ? (
                        <button
                          onClick={() => onEditProgram?.(progId)}
                          style={{ background: 'none', border: 'none', color: '#2563EB', fontSize: '0.75rem', fontWeight: 700, cursor: 'pointer', flexShrink: 0, maxWidth: '110px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', padding: 0, textAlign: 'right' }}
                        >
                          {progName}
                        </button>
                      ) : (
                        <span style={{ color: '#CBD5E1', fontSize: '0.75rem', flexShrink: 0 }}>—</span>
                      )}
                    </div>
                  )
                })
              }
            </div>
            <div style={s.panelFooter}>
              <span style={s.footerLink} onClick={() => nav('screens')}>Ver pantallas →</span>
            </div>
          </div>

        </div>
      )}
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  pageHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1.5rem', flexWrap: 'wrap', gap: '1rem' },
  title: { fontSize: '1.5rem', fontWeight: 700, color: '#0F172A' },
  sub: { color: '#64748B', fontSize: '0.875rem', marginTop: '0.2rem' },
  statPill: { display: 'flex', alignItems: 'center', gap: '0.4rem', background: '#fff', border: '1px solid #E2E8F0', borderRadius: '20px', padding: '0.35rem 0.875rem', color: '#64748B', fontSize: '0.8rem' },
  dot: { width: '7px', height: '7px', borderRadius: '50%', flexShrink: 0 },
  grid3: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '1.25rem', alignItems: 'start' },
  panel: { background: '#fff', borderRadius: '14px', border: '1px solid #E2E8F0', boxShadow: '0 1px 6px rgba(0,0,0,0.04)', overflow: 'hidden', display: 'flex', flexDirection: 'column' },
  panelHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '1rem 1.25rem', borderBottom: '1px solid #F1F5F9' },
  panelIcon: { width: '28px', height: '28px', borderRadius: '7px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.9rem' },
  panelTitle: { fontWeight: 700, color: '#0F172A', fontSize: '0.95rem' },
  btnPrimary: { display: 'flex', alignItems: 'center', gap: '0.35rem', padding: '0.4rem 0.875rem', borderRadius: '7px', border: 'none', background: '#2563EB', color: '#fff', fontWeight: 600, fontSize: '0.78rem', cursor: 'pointer', whiteSpace: 'nowrap' },
  colHeader: { display: 'flex', justifyContent: 'space-between', padding: '0.5rem 1.25rem', background: '#FAFBFC', borderBottom: '1px solid #F1F5F9', color: '#94A3B8', fontSize: '0.72rem', fontWeight: 600, letterSpacing: '0.03em' },
  list: { flex: 1, overflowY: 'auto', maxHeight: '420px' },
  listRow: { display: 'flex', alignItems: 'center', gap: '0.625rem', padding: '0.625rem 1.25rem', borderBottom: '1px solid #F8FAFC' },
  thumb: { width: '44px', height: '30px', borderRadius: '5px', overflow: 'hidden', background: '#F1F5F9', flexShrink: 0 },
  itemName: { fontSize: '0.82rem', color: '#0F172A', fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  itemDate: { color: '#94A3B8', fontSize: '0.72rem', flexShrink: 0 },
  panelFooter: { padding: '0.75rem 1.25rem', borderTop: '1px solid #F1F5F9' },
  footerLink: { color: '#2563EB', fontSize: '0.8rem', fontWeight: 500, cursor: 'pointer' },
  empty: { color: '#94A3B8', fontSize: '0.85rem', padding: '2rem', textAlign: 'center' },
}