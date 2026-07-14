import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

type Screen = {
  id: string; name: string; location: string | null
  width: number; height: number; is_active: boolean
  last_heartbeat: string | null; current_program_id: string | null
  operating_hours: number; device_token: string | null
  ad_capacity: number
}

type AdCount = { program_id: string; total_ads: number }

function getStatus(hb: string | null, prog: string | null) {
  if (!prog) return { label: 'Sin programa', color: '#F59E0B', dot: '#F59E0B' }
  if (!hb) return { label: 'Player no corriendo', color: '#94A3B8', dot: '#CBD5E1' }
  const mins = (Date.now() - new Date(hb).getTime()) / 60000
  if (mins < 2) return { label: 'Activa', color: '#10B981', dot: '#10B981' }
  if (mins < 5) return { label: 'Sin respuesta', color: '#F59E0B', dot: '#F59E0B' }
  return { label: 'Player no corriendo', color: '#94A3B8', dot: '#CBD5E1' }
}

function OccupancyRing({ used, capacity }: { used: number; capacity: number }) {
  const pct = capacity > 0 ? Math.min((used / capacity) * 100, 100) : 0
  const r = 28
  const circ = 2 * Math.PI * r
  const dash = (pct / 100) * circ
  const color = pct >= 90 ? '#EF4444' : pct >= 70 ? '#F59E0B' : '#10B981'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.25rem' }}>
      <div style={{ position: 'relative', width: '72px', height: '72px' }}>
        <svg width="72" height="72" style={{ transform: 'rotate(-90deg)' }}>
          <circle cx="36" cy="36" r={r} fill="none" stroke="#F1F5F9" strokeWidth="8" />
          <circle cx="36" cy="36" r={r} fill="none" stroke={color} strokeWidth="8"
            strokeDasharray={`${dash} ${circ}`} strokeLinecap="round"
            style={{ transition: 'stroke-dasharray 0.5s ease' }} />
        </svg>
        <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
          <span style={{ fontSize: '0.8rem', fontWeight: 700, color: '#0F172A' }}>{Math.round(pct)}%</span>
        </div>
      </div>
      <span style={{ fontSize: '0.7rem', color: '#94A3B8', textAlign: 'center' }}>{used}/{capacity} anuncios</span>
    </div>
  )
}

export default function Screens() {
  const [screens, setScreens] = useState<Screen[]>([])
  const [adCounts, setAdCounts] = useState<AdCount[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [name, setName] = useState('')
  const [location, setLocation] = useState('')
  const [width, setWidth] = useState(1920)
  const [height, setHeight] = useState(1080)
  const [adCapacity, setAdCapacity] = useState(10)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [programs, setPrograms] = useState<{ id: string; name: string }[]>([])
  const [assigningScreen, setAssigningScreen] = useState<string | null>(null)
  const [selectedProgram, setSelectedProgram] = useState('')
  const [editingHours, setEditingHours] = useState<string | null>(null)
  const [hoursValue, setHoursValue] = useState(20)
  const [copied, setCopied] = useState<string | null>(null)
  const [search, setSearch] = useState('')

  async function load() {
    const { data } = await supabase.from('screens').select('*').order('created_at', { ascending: true })
    if (data) setScreens(data as Screen[])
    const { data: progs } = await supabase.from('programs').select('id, name')
    if (progs) setPrograms(progs)
    const { data: counts } = await supabase.from('program_ad_count').select('*')
    if (counts) setAdCounts(counts as AdCount[])
    setLoading(false)
  }

  useEffect(() => {
    load()
    const interval = setInterval(async () => {
      const { data } = await supabase.from('screens').select('*').order('created_at', { ascending: true })
      if (data) setScreens(data as Screen[])
      const { data: counts } = await supabase.from('program_ad_count').select('*')
      if (counts) setAdCounts(counts as AdCount[])
    }, 60000)
    return () => clearInterval(interval)
  }, [])

  function getAdCount(programId: string | null) {
    if (!programId) return 0
    return adCounts.find(a => a.program_id === programId)?.total_ads ?? 0
  }

  async function handleCreate() {
    if (!name.trim()) return
    setSaving(true); setError(null)
    const { data: profileData } = await supabase.from('profiles').select('organization_id').eq('id', (await supabase.auth.getUser()).data.user?.id ?? '').single()
    const { error } = await supabase.from('screens').insert({
      name: name.trim(), location: location.trim() || null,
      width, height, ad_capacity: adCapacity,
      organization_id: profileData?.organization_id ?? null
    })
    setSaving(false)
    if (error) { setError(error.message); return }
    setName(''); setLocation(''); setWidth(1920); setHeight(1080); setAdCapacity(10)
    setShowForm(false); load()
  }

  async function handleToggle(id: string, current: boolean) {
    await supabase.from('screens').update({ is_active: !current }).eq('id', id); load()
  }

  async function handleDelete(id: string) {
    if (!confirm('¿Eliminar esta pantalla?')) return
    await supabase.from('screens').delete().eq('id', id); load()
  }

  async function handleSaveHours(id: string) {
    await supabase.from('screens').update({ operating_hours: hoursValue }).eq('id', id)
    setEditingHours(null); load()
  }

  async function handleAssign(id: string) {
    await supabase.from('screens').update({ current_program_id: selectedProgram || null }).eq('id', id)
    setAssigningScreen(null); setSelectedProgram(''); load()
  }

  function copyToken(token: string) {
    navigator.clipboard.writeText(token)
    setCopied(token); setTimeout(() => setCopied(null), 2000)
  }

  return (
    <div>
      <div style={s.topbar} className="page-topbar">
        <div>
          <h1 style={s.title}>Pantallas</h1>
          <p style={s.sub}>Gestiona tus ubicaciones físicas · {screens.length} registradas</p>
        </div>
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', background: '#fff', border: '1px solid #E2E8F0', borderRadius: '8px', padding: '0.5rem 0.875rem', width: '220px' }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#94A3B8" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            <input style={{ border: 'none', outline: 'none', fontSize: '0.875rem', color: '#0F172A', width: '100%', background: 'transparent' }} placeholder="Buscar pantalla..." value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          <button style={s.btnPrimary} onClick={() => setShowForm(!showForm)}>+ Nueva pantalla</button>
        </div>
      </div>

      {showForm && (
        <div style={s.formCard}>
          <h3 style={s.formTitle}>Nueva pantalla</h3>
          <div style={s.formRow}>
            <div style={s.formGroup}>
              <label style={s.label}>Nombre</label>
              <input style={s.input} value={name} onChange={e => setName(e.target.value)} placeholder="Ej: Kennedy SN" />
            </div>
            <div style={s.formGroup}>
              <label style={s.label}>Ubicación</label>
              <input style={s.input} value={location} onChange={e => setLocation(e.target.value)} placeholder="Ej: Santo Domingo" />
            </div>
            <div style={s.formGroup}>
              <label style={s.label}>Resolución</label>
              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                <input style={{ ...s.input, width: '90px' }} type="number" value={width} onChange={e => setWidth(+e.target.value)} />
                <span style={{ color: '#94A3B8' }}>×</span>
                <input style={{ ...s.input, width: '90px' }} type="number" value={height} onChange={e => setHeight(+e.target.value)} />
              </div>
            </div>
            <div style={s.formGroup}>
              <label style={s.label}>Capacidad de anuncios</label>
              <input style={{ ...s.input, width: '100px' }} type="number" min={1} value={adCapacity} onChange={e => setAdCapacity(+e.target.value)} placeholder="Ej: 10" />
              <span style={{ color: '#94A3B8', fontSize: '0.75rem' }}>máx. anuncios por programa</span>
            </div>
          </div>
          {error && <p style={{ color: '#EF4444', fontSize: '0.8rem', marginBottom: '0.75rem' }}>{error}</p>}
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button style={s.btnPrimary} onClick={handleCreate} disabled={saving}>{saving ? 'Guardando...' : 'Registrar pantalla'}</button>
            <button style={s.btnOutline} onClick={() => setShowForm(false)}>Cancelar</button>
          </div>
        </div>
      )}

      {loading ? <p style={{ color: '#94A3B8', marginTop: '2rem' }}>Cargando...</p> : (
       <div style={s.grid}>
          {screens.filter(sc => sc.name.toLowerCase().includes(search.toLowerCase()) || (sc.location ?? '').toLowerCase().includes(search.toLowerCase())).map(sc => {
            const status = getStatus(sc.last_heartbeat, sc.current_program_id)
            const adCount = getAdCount(sc.current_program_id)
            const capacity = sc.ad_capacity ?? 10
            return (
              <div key={sc.id} style={{ ...s.card, opacity: sc.is_active ? 1 : 0.6 }}>
                <div style={s.cardHeader}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <div style={{ width: '9px', height: '9px', borderRadius: '50%', background: status.dot, boxShadow: status.dot === '#10B981' ? '0 0 6px #10B981' : 'none', flexShrink: 0 }} />
                    <span style={s.cardName}>{sc.name}</span>
                  </div>
                  <span style={{ fontSize: '0.72rem', fontWeight: 600, padding: '2px 8px', borderRadius: '20px', background: status.dot === '#10B981' ? '#ECFDF5' : '#F8FAFC', color: status.color, border: `1px solid ${status.dot === '#10B981' ? '#A7F3D0' : '#E2E8F0'}` }}>
                    {status.label}
                  </span>
                </div>

                <div style={{ display: 'flex', gap: '1rem', padding: '0.75rem 1.25rem' }}>
                  {/* Info */}
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                    {sc.location && <div style={s.meta}><span>📍</span>{sc.location}</div>}
                    <div style={s.meta}><span>🖥</span>{sc.width} × {sc.height}px</div>
                    <div style={s.meta}><span>⏱</span>{sc.last_heartbeat ? new Date(sc.last_heartbeat).toLocaleTimeString('es-DO') : 'Nunca conectada'}</div>
                    <div style={s.meta}><span>📺</span>{sc.current_program_id ? 'Programa asignado' : 'Sin programa'}</div>

                    {sc.device_token && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginTop: '0.2rem' }}>
                        <span style={{ fontFamily: 'monospace', fontSize: '0.7rem', color: '#64748B' }}>{sc.device_token.slice(0, 16)}...</span>
                        <button onClick={() => copyToken(sc.device_token!)} style={{ background: '#EFF6FF', border: '1px solid #BFDBFE', borderRadius: '4px', color: '#2563EB', fontSize: '0.68rem', padding: '1px 6px', cursor: 'pointer' }}>
                          {copied === sc.device_token ? '✓' : 'Copiar'}
                        </button>
                      </div>
                    )}

                    <div style={{ marginTop: '0.3rem' }}>
                      {editingHours === sc.id ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                          <input type="number" min={1} max={24} value={hoursValue} onChange={e => setHoursValue(+e.target.value)}
                            style={{ ...s.input, width: '55px', padding: '0.2rem 0.4rem', fontSize: '0.8rem' }} />
                          <span style={{ color: '#94A3B8', fontSize: '0.72rem' }}>h/día</span>
                          <button style={{ ...s.btnPrimary, padding: '0.2rem 0.5rem', fontSize: '0.72rem' }} onClick={() => handleSaveHours(sc.id)}>OK</button>
                          <button style={{ ...s.btnOutline, padding: '0.2rem 0.5rem', fontSize: '0.72rem' }} onClick={() => setEditingHours(null)}>✕</button>
                        </div>
                      ) : (
                        <button onClick={() => { setEditingHours(sc.id); setHoursValue(sc.operating_hours) }}
                          style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', background: '#F0FDF4', border: '1px solid #A7F3D0', borderRadius: '20px', color: '#059669', fontSize: '0.7rem', padding: '2px 9px', cursor: 'pointer' }}>
                          ⏱ {sc.operating_hours}h/día
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Occupancy ring */}
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', paddingLeft: '0.5rem' }}>
                    <OccupancyRing used={adCount} capacity={capacity} />
                  </div>
                </div>

                {assigningScreen === sc.id && (
                  <div style={{ padding: '0.6rem 1.25rem', borderTop: '1px solid #F1F5F9', display: 'flex', gap: '0.5rem' }}>
                    <select style={{ ...s.input, flex: 1, fontSize: '0.8rem' }} value={selectedProgram} onChange={e => setSelectedProgram(e.target.value)}>
                      <option value="">— Sin programa —</option>
                      {programs.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                    <button style={s.btnPrimary} onClick={() => handleAssign(sc.id)}>OK</button>
                    <button style={s.btnOutline} onClick={() => setAssigningScreen(null)}>✕</button>
                  </div>
                )}

                <div style={s.cardActions}>
                  <button style={s.btnAct} onClick={() => { setAssigningScreen(sc.id); setSelectedProgram(sc.current_program_id ?? '') }}>Asignar programa</button>
                  <button style={s.btnAct} onClick={() => handleToggle(sc.id, sc.is_active)}>{sc.is_active ? 'Desactivar' : 'Activar'}</button>
                  <button style={s.btnDel} onClick={() => handleDelete(sc.id)}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
                    Eliminar
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
  topbar: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1.75rem', flexWrap: 'wrap', gap: '1rem' },
  title: { fontSize: '1.6rem', fontWeight: 700, color: '#0F172A' },
  sub: { color: '#64748B', fontSize: '0.875rem', marginTop: '0.2rem' },
  btnPrimary: { display: 'flex', alignItems: 'center', gap: '0.4rem', padding: '0.6rem 1.1rem', borderRadius: '8px', border: 'none', background: '#3B82F6', color: '#fff', fontWeight: 600, fontSize: '0.875rem', whiteSpace: 'nowrap', cursor: 'pointer' },
  btnOutline: { padding: '0.6rem 1rem', borderRadius: '8px', border: '1px solid #E2E8F0', background: '#fff', color: '#64748B', fontWeight: 500, fontSize: '0.875rem', cursor: 'pointer' },
  formCard: { background: '#fff', border: '1px solid #E2E8F0', borderRadius: '12px', padding: '1.5rem', marginBottom: '1.75rem', boxShadow: '0 1px 4px rgba(0,0,0,0.04)' },
  formTitle: { fontWeight: 700, color: '#0F172A', marginBottom: '1rem', fontSize: '1rem' },
  formRow: { display: 'flex', gap: '1.25rem', flexWrap: 'wrap', marginBottom: '1rem' },
  formGroup: { display: 'flex', flexDirection: 'column', gap: '0.35rem' },
  label: { color: '#64748B', fontSize: '0.8rem', fontWeight: 500 },
  input: { padding: '0.55rem 0.75rem', borderRadius: '8px', border: '1px solid #E2E8F0', background: '#fff', color: '#0F172A', fontSize: '0.875rem', outline: 'none' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '1.25rem' },
  card: { background: '#fff', borderRadius: '14px', border: '1px solid #E2E8F0', boxShadow: '0 1px 6px rgba(0,0,0,0.04)', overflow: 'hidden' },
  cardHeader: { padding: '0.875rem 1.25rem 0.5rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  cardName: { fontWeight: 700, color: '#0F172A', fontSize: '0.95rem' },
  meta: { display: 'flex', alignItems: 'center', gap: '0.4rem', color: '#64748B', fontSize: '0.8rem' },
  cardActions: { padding: '0.75rem 1.25rem', borderTop: '1px solid #F1F5F9', display: 'flex', gap: '0.5rem', flexWrap: 'wrap' },
  btnAct: { padding: '0.38rem 0.75rem', borderRadius: '7px', border: '1px solid #E2E8F0', background: '#fff', color: '#64748B', fontSize: '0.78rem', fontWeight: 500, cursor: 'pointer' },
  btnDel: { display: 'flex', alignItems: 'center', gap: '0.3rem', padding: '0.38rem 0.75rem', borderRadius: '7px', border: '1px solid #FECACA', background: '#FFF5F5', color: '#EF4444', fontSize: '0.78rem', fontWeight: 500, cursor: 'pointer' },
}