import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../auth/AuthContext'
import { hasRole } from '../lib/roles'
import { useDialog } from '../components/Dialog'
import ScreenStage from '../components/ScreenStage'

type Screen = {
  id: string; name: string; location: string | null
  width: number; height: number; is_active: boolean
  last_heartbeat: string | null; current_program_id: string | null
  operating_hours: number; device_token: string | null
  ad_capacity: number
  operating_start: string | null; operating_end: string | null
  device_fingerprint: string | null; last_seen_at: string | null
  reset_requested_at: string | null
}

type AdCount = { program_id: string; total_ads: number }

function fmtHM(t: string | null) { return t ? String(t).slice(0, 5) : '' }

// URL de descarga del APK de Android. Vacía → se muestran los pasos sin
// botón de descarga (evita un enlace roto).
const APK_URL = ''

// La resolución se define en Programas; las columnas width/height de screens
// son NOT NULL, así que se guarda un valor fijo que la UI ya no muestra.
const DEFAULT_W = 1920
const DEFAULT_H = 1080

// Detecta si el campo "location" guarda un enlace de Google Maps.
function isMapsUrl(v: string | null): boolean {
  if (!v) return false
  return /^https?:\/\/(www\.)?(google\.[a-z.]+\/maps|maps\.google\.[a-z.]+|maps\.app\.goo\.gl|goo\.gl\/maps)/i.test(v.trim())
}

// Horas operativas del rango (cruce de medianoche incluido), redondeadas al
// entero más cercano. Se usa para el badge "Nh/día" y el cálculo de frecuencias.
function operatingHoursCount(start: string, end: string) {
  const [sh, sm] = fmtHM(start).split(':').map(Number)
  const [eh, em] = fmtHM(end).split(':').map(Number)
  let mins = (eh * 60 + em) - (sh * 60 + sm)
  if (mins <= 0) mins += 24 * 60 // cruza medianoche
  return Math.max(1, Math.round(mins / 60))
}

// Resumen del horario operativo: "06:00 a 02:00 · 20h operativas" o
// "Siempre activa" si no hay rango definido. Soporta cruce de medianoche.
function operatingSummary(start: string | null, end: string | null) {
  if (!start || !end) return 'Siempre activa'
  return `${fmtHM(start)} a ${fmtHM(end)} · ${operatingHoursCount(start, end)}h operativas`
}

async function fetchAdCounts(): Promise<AdCount[]> {
  // Build zone→program map
  const { data: zones } = await supabase.from('zones').select('id, program_id')
  const zoneProgram: Record<string, string> = {}
  for (const z of (zones ?? [])) zoneProgram[z.id] = z.program_id

  const counts: Record<string, number> = {}

  // Direct items (not inside a sub-playlist) count as 1 each
  const { data: media } = await supabase.from('media_content')
    .select('zone_id').is('archived_at', null).is('sub_playlist_id', null).not('zone_id', 'is', null)
  for (const m of (media ?? [])) {
    const pid = zoneProgram[m.zone_id]
    if (pid) counts[pid] = (counts[pid] ?? 0) + 1
  }

  // Each sub-playlist counts as 1 slot regardless of how many items it contains
  const { data: subs } = await supabase.from('sub_playlists')
    .select('zone_id').is('archived_at', null).not('zone_id', 'is', null)
  for (const s of (subs ?? [])) {
    const pid = zoneProgram[s.zone_id]
    if (pid) counts[pid] = (counts[pid] ?? 0) + 1
  }

  return Object.entries(counts).map(([program_id, total_ads]) => ({ program_id, total_ads }))
}

function getStatus(hb: string | null, prog: string | null) {
  if (!prog) return { label: 'Sin programa', color: '#F59E0B', dot: '#F59E0B' }
  if (!hb) return { label: 'Player no corriendo', color: '#94A3B8', dot: '#CBD5E1' }
  const mins = (Date.now() - new Date(hb).getTime()) / 60000
  if (mins < 2) return { label: 'Activa', color: '#10B981', dot: '#10B981' }
  if (mins < 5) return { label: 'Sin respuesta', color: '#F59E0B', dot: '#F59E0B' }
  return { label: 'Player no corriendo', color: '#94A3B8', dot: '#CBD5E1' }
}

// Una pantalla está "en línea" si su player latió hace menos de 2 min (misma
// regla que el indicador del dashboard y el estado "Activa").
function isScreenOnline(sc: Screen): boolean {
  return getStatus(sc.last_heartbeat, sc.current_program_id).label === 'Activa'
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
  const { profile } = useAuth()
  const { confirm, alert } = useDialog()
  // Vendedor solo ve la lista y la ocupación (lectura); admin/operador gestionan.
  const canManage = hasRole(profile?.role, 'admin', 'operator')
  const [screens, setScreens] = useState<Screen[]>([])
  const [adCounts, setAdCounts] = useState<AdCount[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [name, setName] = useState('')
  const [location, setLocation] = useState('')
  const [adCapacity, setAdCapacity] = useState(10)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [programs, setPrograms] = useState<{ id: string; name: string; width: number; height: number }[]>([])
  const [assigningScreen, setAssigningScreen] = useState<string | null>(null)
  const [selectedProgram, setSelectedProgram] = useState('')
  const [editingHours, setEditingHours] = useState<string | null>(null)
  const [hoursValue, setHoursValue] = useState(20)
  const [copied, setCopied] = useState<string | null>(null)
  const [preview, setPreview] = useState<Screen | null>(null)
  const [releasing, setReleasing] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  // Vista lista/tarjeta, recordada entre sesiones por página.
  const [view, setView] = useState<'grid' | 'list'>(() => (localStorage.getItem('gp_view_screens') === 'list' ? 'list' : 'grid'))
  function changeView(v: 'grid' | 'list') { setView(v); localStorage.setItem('gp_view_screens', v) }
  // Filtro por estado. Al entrar desde los indicadores del dashboard, se lee un
  // valor "de una sola vez" desde localStorage y se limpia enseguida.
  const [statusFilter, setStatusFilter] = useState<'all' | 'online' | 'offline'>(() => {
    const f = localStorage.getItem('gp_screens_filter')
    if (f === 'online' || f === 'offline') { localStorage.removeItem('gp_screens_filter'); return f }
    return 'all'
  })
  const [editScreen, setEditScreen] = useState<Screen | null>(null)
  const [editName, setEditName] = useState('')
  const [editLocation, setEditLocation] = useState('')
  const [editCapacity, setEditCapacity] = useState(10)
  const [editSaving, setEditSaving] = useState(false)
  const [editOpEnabled, setEditOpEnabled] = useState(false)
  const [editOpStart, setEditOpStart] = useState('06:00')
  const [resetSent, setResetSent] = useState<string | null>(null)
  const [editOpEnd, setEditOpEnd] = useState('00:00')
  // Paso 2 tras crear: cómo instalar la pantalla recién creada.
  const [installFor, setInstallFor] = useState<{ name: string; token: string | null } | null>(null)
  const [installTab, setInstallTab] = useState<'web' | 'android'>('web')
  const [linkCopied, setLinkCopied] = useState(false)

  async function load() {
    const { data } = await supabase.from('screens').select('*').order('created_at', { ascending: true })
    if (data) setScreens(data as Screen[])
    const { data: progs } = await supabase.from('programs').select('id, name, width, height')
    if (progs) setPrograms(progs)
    setAdCounts(await fetchAdCounts())
    setLoading(false)
  }

  useEffect(() => {
    load()
    const interval = setInterval(async () => {
      const { data } = await supabase.from('screens').select('*').order('created_at', { ascending: true })
      if (data) setScreens(data as Screen[])
      setAdCounts(await fetchAdCounts())
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
    const { data: created, error } = await supabase.from('screens').insert({
      name: name.trim(), location: location.trim() || null,
      width: DEFAULT_W, height: DEFAULT_H, ad_capacity: adCapacity,
      organization_id: profileData?.organization_id ?? null
    }).select('id, name, device_token').single()
    setSaving(false)
    if (error) { setError(error.message); return }
    setName(''); setLocation(''); setAdCapacity(10)
    setShowForm(false); load()
    // En vez de solo cerrar el formulario: mostrar cómo instalarla.
    if (created) {
      setInstallTab('web'); setLinkCopied(false)
      setInstallFor({ name: created.name, token: (created as any).device_token ?? null })
    }
  }

  function playUrlFor(tk: string) { return `${window.location.origin}/play?token=${tk}` }

  async function copyPlayLink(tk: string) {
    const text = playUrlFor(tk)
    let ok = false
    try {
      await navigator.clipboard.writeText(text)
      ok = true
    } catch {
      // Fallback para navegadores sin Clipboard API o con permiso denegado
      // (habitual en navegadores de Smart TV y contextos no seguros).
      try {
        const ta = document.createElement('textarea')
        ta.value = text
        ta.setAttribute('readonly', '')
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        ok = document.execCommand('copy')
        document.body.removeChild(ta)
      } catch { /* sin portapapeles: la URL sigue visible para copiarla a mano */ }
    }
    if (ok) {
      setLinkCopied(true)
      setTimeout(() => setLinkCopied(false), 2500)
    }
  }


  async function handleReset(id: string) {
    setResetSent(id)
    setTimeout(() => setResetSent(null), 3000)
    await supabase.from('screens').update({ reset_requested_at: new Date().toISOString() }).eq('id', id)
  }

  async function handleDelete(id: string) {
    if (!await confirm({ title: '¿Eliminar esta pantalla?', confirmLabel: 'Eliminar', danger: true })) return
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

  function openEdit(sc: Screen) {
    setEditScreen(sc)
    setEditName(sc.name)
    setEditLocation(sc.location ?? '')
    setEditCapacity(sc.ad_capacity ?? 10)
    const hasOp = !!(sc.operating_start && sc.operating_end)
    setEditOpEnabled(hasOp)
    setEditOpStart(fmtHM(sc.operating_start) || '06:00')
    setEditOpEnd(fmtHM(sc.operating_end) || '00:00')
  }

  async function handleSaveEdit() {
    if (!editScreen || !editName.trim()) return
    setEditSaving(true)
    const opUpdate = editOpEnabled
      ? { operating_start: editOpStart, operating_end: editOpEnd, operating_hours: operatingHoursCount(editOpStart, editOpEnd) }
      : { operating_start: null, operating_end: null }
    await supabase.from('screens').update({
      name: editName.trim(),
      location: editLocation.trim() || null,
      ad_capacity: editCapacity,
      ...opUpdate,
    }).eq('id', editScreen.id)
    setEditSaving(false)
    setEditScreen(null)
    load()
  }

  function copyToken(token: string) {
    navigator.clipboard.writeText(token)
    setCopied(token); setTimeout(() => setCopied(null), 2000)
  }

  // Libera el dispositivo vinculado a la pantalla (borra device_fingerprint).
  // El próximo equipo que abra el player con este token quedará vinculado.
  async function handleRelease(sc: Screen) {
    if (!await confirm({
      title: `¿Liberar el dispositivo de "${sc.name}"?`,
      message: 'El próximo equipo que se conecte con este token quedará vinculado. Úsalo si cambiaste, reparaste o reinstalaste la pantalla física.',
      confirmLabel: 'Liberar',
    })) return
    setReleasing(sc.id)
    const { error } = await supabase.rpc('release_screen_device', { p_screen_id: sc.id })
    setReleasing(null)
    if (error) { await alert({ title: 'No se pudo liberar el dispositivo', message: error.message }); return }
    load()
  }

  // Lista visible tras aplicar búsqueda + filtro por estado.
  const visibleScreens = screens.filter(sc =>
    (sc.name.toLowerCase().includes(search.toLowerCase()) || (sc.location ?? '').toLowerCase().includes(search.toLowerCase()))
    && (statusFilter === 'all' || (statusFilter === 'online' ? isScreenOnline(sc) : !isScreenOnline(sc)))
  )

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
          <div style={s.viewToggle}>
            <button onClick={() => changeView('grid')} title="Vista de tarjetas" aria-label="Vista de tarjetas"
              style={{ ...s.viewBtn, ...(view === 'grid' ? s.viewBtnActive : {}) }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
            </button>
            <button onClick={() => changeView('list')} title="Vista de lista" aria-label="Vista de lista"
              style={{ ...s.viewBtn, ...(view === 'list' ? s.viewBtnActive : {}) }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
            </button>
          </div>
          {canManage && <button style={s.btnPrimary} onClick={() => setShowForm(!showForm)}>+ Nueva pantalla</button>}
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
              <label style={s.label}>Dirección</label>
              <input style={{ ...s.input, minWidth: '260px' }} value={location} onChange={e => setLocation(e.target.value)}
                placeholder="Dirección o enlace de Google Maps" />
              <span style={{ color: '#94A3B8', fontSize: '0.75rem' }}>Puedes pegar un enlace de Google Maps</span>
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

      {!loading && screens.length > 0 && (
        <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.1rem', flexWrap: 'wrap' }}>
          {([['all', 'Todas', screens.length], ['online', 'En línea', screens.filter(isScreenOnline).length], ['offline', 'Desconectadas', screens.filter(sc => !isScreenOnline(sc)).length]] as ['all' | 'online' | 'offline', string, number][]).map(([val, label, count]) => (
            <button key={val} onClick={() => setStatusFilter(val)} style={{ ...s.filterChip, ...(statusFilter === val ? s.filterChipActive : {}) }}>
              {val !== 'all' && <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: val === 'online' ? '#10B981' : '#CBD5E1', flexShrink: 0 }} />}
              {label} <span style={{ opacity: 0.65 }}>{count}</span>
            </button>
          ))}
        </div>
      )}

      {loading ? <p style={{ color: '#94A3B8', marginTop: '2rem' }}>Cargando...</p> : visibleScreens.length === 0 ? (
        <p style={{ color: '#94A3B8', marginTop: '2rem' }}>
          {screens.length === 0
            ? 'No hay pantallas registradas todavía.'
            : statusFilter === 'online' ? 'No hay pantallas en línea en este momento.'
            : statusFilter === 'offline' ? 'No hay pantallas desconectadas.'
            : 'Ninguna pantalla coincide con la búsqueda.'}
        </p>
      ) : (
       <div style={view === 'grid' ? s.grid : s.list}>
          {visibleScreens.map(sc => {
            const status = getStatus(sc.last_heartbeat, sc.current_program_id)
            const adCount = getAdCount(sc.current_program_id)
            const capacity = sc.ad_capacity ?? 10
            const occColor = capacity > 0 && (adCount / capacity) >= 0.9 ? '#EF4444' : capacity > 0 && (adCount / capacity) >= 0.7 ? '#F59E0B' : '#10B981'

            // ── Vista lista: fila horizontal limpia y compacta ──────────────
            if (view === 'list') {
              return (
                <div key={sc.id} style={{ display: 'flex', flexDirection: 'column', opacity: sc.is_active ? 1 : 0.6 }}>
                  <div style={s.listRow}>
                    <div style={{ width: '9px', height: '9px', borderRadius: '50%', background: status.dot, boxShadow: status.dot === '#10B981' ? '0 0 6px #10B981' : 'none', flexShrink: 0 }} />
                    <div style={{ flex: '3 1 210px', minWidth: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <span style={{ ...s.cardName, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: '60px' }}>{sc.name}</span>
                      <span style={{ flexShrink: 0, fontSize: '0.68rem', fontWeight: 600, padding: '1px 7px', borderRadius: '20px', background: status.dot === '#10B981' ? '#ECFDF5' : '#F8FAFC', color: status.color, border: `1px solid ${status.dot === '#10B981' ? '#A7F3D0' : '#E2E8F0'}` }}>{status.label}</span>
                    </div>
                    <div style={{ flex: '2 1 150px', minWidth: 0, fontSize: '0.8rem', color: '#64748B', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {sc.location
                        ? (isMapsUrl(sc.location)
                          ? <a href={sc.location.trim()} target="_blank" rel="noopener noreferrer" style={{ color: '#2563EB', textDecoration: 'none', fontWeight: 600 }}>📍 Ver en Google Maps</a>
                          : <>📍 {sc.location}</>)
                        : <span style={{ color: '#CBD5E1' }}>Sin ubicación</span>}
                    </div>
                    <div style={{ flex: '1 1 110px', minWidth: 0, fontSize: '0.8rem', color: sc.current_program_id ? '#64748B' : '#F59E0B', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {sc.current_program_id ? '📺 Programa asignado' : '📺 Sin programa'}
                    </div>
                    <div style={{ flexShrink: 0, fontSize: '0.8rem', fontWeight: 700, color: occColor, minWidth: '42px', textAlign: 'right' }}>{adCount}/{capacity}</div>
                    <div style={{ display: 'flex', gap: '0.4rem', flexShrink: 0, marginLeft: '0.25rem', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                      {canManage && <button style={s.btnAct} onClick={() => { setAssigningScreen(sc.id); setSelectedProgram(sc.current_program_id ?? '') }}>Asignar</button>}
                      <button style={s.btnAct} onClick={() => setPreview(sc)}>Captura</button>
                      {canManage && <button style={{ ...s.btnAct, ...(resetSent === sc.id ? { color: '#10B981', border: '1px solid #10B981' } : {}) }} onClick={() => handleReset(sc.id)} disabled={resetSent === sc.id}>{resetSent === sc.id ? 'Enviada' : 'Reiniciar'}</button>}
                      {canManage && <button style={s.btnAct} onClick={() => openEdit(sc)}>Editar</button>}
                    </div>
                  </div>
                  {canManage && assigningScreen === sc.id && (
                    <div style={{ display: 'flex', gap: '0.5rem', padding: '0.5rem 1rem 0' }}>
                      <select style={{ ...s.input, flex: 1, fontSize: '0.8rem' }} value={selectedProgram} onChange={e => setSelectedProgram(e.target.value)}>
                        <option value="">— Sin programa —</option>
                        {programs.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                      </select>
                      <button style={s.btnPrimary} onClick={() => handleAssign(sc.id)}>OK</button>
                      <button style={s.btnOutline} onClick={() => setAssigningScreen(null)}>✕</button>
                    </div>
                  )}
                </div>
              )
            }

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
                    {sc.location && (
                      <div style={s.meta}>
                        {isMapsUrl(sc.location) ? (
                          <a href={sc.location.trim()} target="_blank" rel="noopener noreferrer"
                            title="Abrir en Google Maps"
                            style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', color: '#2563EB', textDecoration: 'none', fontWeight: 600 }}>
                            <span>📍</span>Ver en Google Maps
                          </a>
                        ) : (
                          <><span>📍</span>{sc.location}</>
                        )}
                      </div>
                    )}
                    <div style={s.meta}><span>⏱</span>{sc.last_heartbeat ? new Date(sc.last_heartbeat).toLocaleTimeString('es-DO') : 'Nunca conectada'}</div>
                    <div style={s.meta}><span>📺</span>{sc.current_program_id ? 'Programa asignado' : 'Sin programa'}</div>
                    <div style={s.meta}><span>🕐</span>{(sc.operating_start && sc.operating_end) ? operatingSummary(sc.operating_start, sc.operating_end) : 'Siempre activa'}</div>

                    {sc.device_token && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginTop: '0.2rem' }}>
                        <span style={{ fontFamily: 'monospace', fontSize: '0.7rem', color: '#64748B' }}>{sc.device_token.slice(0, 16)}...</span>
                        <button onClick={() => copyToken(sc.device_token!)} style={{ background: '#EFF6FF', border: '1px solid #BFDBFE', borderRadius: '4px', color: '#2563EB', fontSize: '0.68rem', padding: '1px 6px', cursor: 'pointer' }}>
                          {copied === sc.device_token ? '✓' : 'Copiar'}
                        </button>
                      </div>
                    )}

                    {sc.device_fingerprint && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginTop: '0.2rem' }}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem', fontSize: '0.7rem', color: '#059669' }}>
                          🔒 Dispositivo vinculado
                        </span>
                        {canManage && (
                          <button
                            onClick={() => handleRelease(sc)}
                            disabled={releasing === sc.id}
                            title="Borra la vinculación para que otro equipo pueda usar este token"
                            style={{ background: '#FFF5F5', border: '1px solid #FECACA', borderRadius: '4px', color: '#EF4444', fontSize: '0.68rem', padding: '1px 6px', cursor: 'pointer', opacity: releasing === sc.id ? 0.6 : 1 }}
                          >
                            {releasing === sc.id ? 'Liberando…' : 'Liberar'}
                          </button>
                        )}
                      </div>
                    )}

                    {canManage ? (
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
                    ) : (
                      // Vendedor: horas en solo lectura (sin control de edición).
                      <div style={{ marginTop: '0.3rem' }}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem', background: '#F0FDF4', border: '1px solid #A7F3D0', borderRadius: '20px', color: '#059669', fontSize: '0.7rem', padding: '2px 9px' }}>
                          ⏱ {sc.operating_hours}h/día
                        </span>
                      </div>
                    )}
                  </div>

                  {/* Occupancy ring */}
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', paddingLeft: '0.5rem' }}>
                    <OccupancyRing used={adCount} capacity={capacity} />
                  </div>
                </div>

                {canManage && assigningScreen === sc.id && (
                  <div style={{ padding: '0.6rem 1.25rem', borderTop: '1px solid #F1F5F9', display: 'flex', gap: '0.5rem' }}>
                    <select style={{ ...s.input, flex: 1, fontSize: '0.8rem' }} value={selectedProgram} onChange={e => setSelectedProgram(e.target.value)}>
                      <option value="">— Sin programa —</option>
                      {programs.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                    <button style={s.btnPrimary} onClick={() => handleAssign(sc.id)}>OK</button>
                    <button style={s.btnOutline} onClick={() => setAssigningScreen(null)}>✕</button>
                  </div>
                )}

                {canManage && (
                  <div style={{ padding: '0 1.25rem 0.5rem' }}>
                    <button
                      style={s.btnPlayer}
                      onClick={() => openEdit(sc)}>
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                      Editar esta pantalla
                    </button>
                  </div>
                )}

                <div style={s.cardActions}>
                  {canManage && <button style={s.btnAct} onClick={() => { setAssigningScreen(sc.id); setSelectedProgram(sc.current_program_id ?? '') }}>Asignar programa</button>}
                  <button style={s.btnAct} onClick={() => setPreview(sc)} title="Ver una captura de lo que se está reproduciendo">
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}>
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
                      Captura
                    </span>
                  </button>
                  {canManage && (
                    <>
                      <button
                        style={{ ...s.btnAct, ...(resetSent === sc.id ? { color: '#10B981', border: '1px solid #10B981' } : {}) }}
                        onClick={() => handleReset(sc.id)}
                        disabled={resetSent === sc.id}
                        title="Fuerza una re-sincronización remota del reproductor">
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}>
                          {resetSent === sc.id
                            ? <><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>Señal enviada</>
                            : <><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>Reiniciar</>
                          }
                        </span>
                      </button>
                      <button style={s.btnDel} onClick={() => handleDelete(sc.id)}>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
                        Eliminar
                      </button>
                    </>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Edit screen modal */}
      {editScreen && createPortal(
        <div className="backdrop" style={s.modalBackdrop} onClick={e => { if (e.target === e.currentTarget) setEditScreen(null) }}>
          <div className="modal-pop" style={{ ...s.modalCard, maxWidth: '480px' }}>
            <div style={s.modalHeader}>
              <span style={{ fontWeight: 700, color: '#0F172A', fontSize: '0.95rem' }}>Editar pantalla</span>
              <button onClick={() => setEditScreen(null)} style={s.modalClose} aria-label="Cerrar">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>
            <div style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div style={s.formGroup}>
                <label style={s.label}>Nombre</label>
                <input style={s.input} value={editName} onChange={e => setEditName(e.target.value)} placeholder="Ej: Kennedy SN" />
              </div>
              <div style={s.formGroup}>
                <label style={s.label}>Dirección</label>
                <input style={s.input} value={editLocation} onChange={e => setEditLocation(e.target.value)}
                  placeholder="Dirección o enlace de Google Maps" />
                <span style={{ color: '#94A3B8', fontSize: '0.75rem' }}>Puedes pegar un enlace de Google Maps</span>
              </div>
              <div style={s.formGroup}>
                <label style={s.label}>Capacidad de anuncios</label>
                <input style={{ ...s.input, width: '100px' }} type="number" min={1} value={editCapacity} onChange={e => setEditCapacity(+e.target.value)} />
              </div>

              {/* Horario operativo */}
              <div style={{ borderTop: '1px solid #F1F5F9', paddingTop: '1rem', display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', fontWeight: 600, color: '#0F172A', fontSize: '0.875rem' }}>
                  <input type="checkbox" checked={editOpEnabled} onChange={e => setEditOpEnabled(e.target.checked)} />
                  Horario operativo
                </label>
                {editOpEnabled ? (
                  <>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                      <input type="time" style={{ ...s.input, width: '130px' }} value={editOpStart} onChange={e => setEditOpStart(e.target.value)} />
                      <span style={{ color: '#64748B', fontSize: '0.85rem' }}>a</span>
                      <input type="time" style={{ ...s.input, width: '130px' }} value={editOpEnd} onChange={e => setEditOpEnd(e.target.value)} />
                    </div>
                    <span style={{ color: '#2563EB', fontSize: '0.8rem', fontWeight: 500 }}>{operatingSummary(editOpStart, editOpEnd)}</span>
                    <span style={{ color: '#94A3B8', fontSize: '0.72rem' }}>Fuera de este horario la pantalla queda en negro y no cuenta estadísticas. Soporta cruce de medianoche (ej. 06:00 a 02:00).</span>
                  </>
                ) : (
                  <span style={{ color: '#94A3B8', fontSize: '0.8rem' }}>Siempre activa · reproduce 24h</span>
                )}
              </div>

              <div style={{ display: 'flex', gap: '0.5rem', paddingTop: '0.25rem' }}>
                <button style={s.btnPrimary} onClick={handleSaveEdit} disabled={editSaving}>{editSaving ? 'Guardando...' : 'Guardar cambios'}</button>
                <button style={s.btnOutline} onClick={() => setEditScreen(null)}>Cancelar</button>
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Capture / live preview modal */}
      {preview && createPortal(
        <div className="backdrop" style={s.modalBackdrop} onClick={e => { if (e.target === e.currentTarget) setPreview(null) }}>
          <div className="modal-pop" style={s.modalCard}>
            <div style={s.modalHeader}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', minWidth: 0 }}>
                <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: getStatus(preview.last_heartbeat, preview.current_program_id).dot, flexShrink: 0 }} />
                <span style={{ fontWeight: 700, color: '#0F172A', fontSize: '0.95rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{preview.name}</span>
                {(() => {
                  const pg = programs.find(p => p.id === preview.current_program_id)
                  return pg ? <span style={{ color: '#94A3B8', fontSize: '0.78rem', flexShrink: 0 }}>· {pg.width}×{pg.height}</span> : null
                })()}
              </div>
              <button onClick={() => setPreview(null)} style={s.modalClose} aria-label="Cerrar">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>
            <div style={{ position: 'relative', width: '100%', aspectRatio: (() => {
              const pg = programs.find(p => p.id === preview.current_program_id)
              return pg ? `${pg.width} / ${pg.height}` : '16 / 9'
            })(), background: '#000', maxHeight: '70vh' }}>
              {preview.current_program_id
                ? <ScreenStage client={supabase} programId={preview.current_program_id} />
                : <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '0.4rem', color: 'rgba(255,255,255,0.6)' }}>
                    <div style={{ fontSize: '2rem' }}>📺</div>
                    <span style={{ fontSize: '0.85rem' }}>Sin programa asignado</span>
                  </div>
              }
            </div>
            <div style={{ padding: '0.6rem 1rem', color: '#94A3B8', fontSize: '0.72rem', textAlign: 'center' }}>
              Vista de lo que se está reproduciendo · muestra el contenido asignado a esta pantalla
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Paso 2 tras crear una pantalla: cómo instalarla */}
      {installFor && createPortal(
        <div className="backdrop" style={s.modalBackdrop} onClick={e => { if (e.target === e.currentTarget) setInstallFor(null) }}>
          <div className="modal-pop" style={{ ...s.modalCard, maxWidth: '520px', padding: '1.5rem' }}>
            <h3 style={{ fontWeight: 700, color: '#0F172A', fontSize: '1.05rem' }}>¿Cómo instalar esta pantalla?</h3>
            <p style={{ color: '#64748B', fontSize: '0.82rem', margin: '0.25rem 0 1.1rem' }}>
              <b style={{ color: '#0F172A' }}>{installFor.name}</b> se creó correctamente. Elige el método de instalación.
            </p>

            <div style={{ display: 'flex', gap: '0.6rem', marginBottom: '1.1rem' }}>
              {[
                {
                  key: 'web' as const, label: 'Navegador', hint: 'TV, Smart TV, PC',
                  icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8" /><path d="M12 17v4" /></svg>,
                },
                {
                  key: 'android' as const, label: 'Android', hint: 'App GestPlayer',
                  icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><rect x="5" y="2" width="14" height="20" rx="2.5" /><path d="M11 18h2" /></svg>,
                },
              ].map(opt => {
                const active = installTab === opt.key
                return (
                  <button key={opt.key} onClick={() => setInstallTab(opt.key)}
                    style={{
                      flex: 1, display: 'flex', alignItems: 'center', gap: '0.6rem', textAlign: 'left',
                      padding: '0.75rem 0.85rem', borderRadius: '10px', cursor: 'pointer',
                      border: `1.5px solid ${active ? '#2563EB' : '#E2E8F0'}`,
                      background: active ? '#EFF6FF' : '#fff',
                      transition: 'border-color .15s, background .15s',
                    }}>
                    <span style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      width: '34px', height: '34px', borderRadius: '9px', flexShrink: 0,
                      background: active ? '#2563EB' : '#F1F5F9',
                      color: active ? '#fff' : '#64748B',
                    }}>{opt.icon}</span>
                    <span style={{ minWidth: 0 }}>
                      <span style={{ display: 'block', fontWeight: 700, fontSize: '0.85rem', color: active ? '#2563EB' : '#0F172A' }}>{opt.label}</span>
                      <span style={{ display: 'block', fontSize: '0.7rem', color: '#94A3B8' }}>{opt.hint}</span>
                    </span>
                  </button>
                )
              })}
            </div>

            {installTab === 'web' ? (
              <div>
                {installFor.token ? (
                  <>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', background: '#F8FAFC', border: '1px solid #E2E8F0', borderRadius: '8px', padding: '0.6rem 0.75rem', marginBottom: '0.75rem' }}>
                      <span style={{ flex: 1, minWidth: 0, fontFamily: 'monospace', fontSize: '0.75rem', color: '#0F172A', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {playUrlFor(installFor.token)}
                      </span>
                      <button onClick={() => copyPlayLink(installFor.token!)}
                        style={{ ...s.btnAct, flexShrink: 0, ...(linkCopied ? { color: '#10B981', border: '1px solid #10B981' } : {}) }}>
                        {linkCopied ? '✓ Copiado' : 'Copiar enlace'}
                      </button>
                    </div>
                    <ol style={{ margin: 0, paddingLeft: '1.1rem', color: '#475569', fontSize: '0.82rem', lineHeight: 1.9 }}>
                      <li>Abre el navegador en el dispositivo</li>
                      <li>Escribe o pega esta URL</li>
                      <li>Escanea el QR que aparece con tu teléfono</li>
                    </ol>
                  </>
                ) : (
                  <p style={{ color: '#B45309', fontSize: '0.82rem', background: '#FFFBEB', border: '1px solid #FDE68A', borderRadius: '8px', padding: '0.6rem 0.75rem' }}>
                    La pantalla se creó, pero aún no tiene token. Ciérralo y copia el token desde su tarjeta.
                  </p>
                )}
              </div>
            ) : (
              <div>
                <p style={{ color: '#475569', fontSize: '0.85rem', marginBottom: '0.75rem' }}>
                  Instala la aplicación <b>GestPlayer.apk</b> en el dispositivo Android.
                </p>
                {APK_URL ? (
                  <a href={APK_URL} target="_blank" rel="noopener noreferrer"
                    style={{ ...s.btnPrimary, display: 'inline-flex', alignItems: 'center', gap: '0.4rem', textDecoration: 'none', marginBottom: '0.85rem' }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>
                    Descargar GestPlayer.apk
                  </a>
                ) : (
                  <p style={{ color: '#64748B', fontSize: '0.78rem', background: '#F8FAFC', border: '1px solid #E2E8F0', borderRadius: '8px', padding: '0.6rem 0.75rem', marginBottom: '0.85rem' }}>
                    Solicita el archivo GestPlayer.apk a tu proveedor.
                  </p>
                )}
                <ol style={{ margin: 0, paddingLeft: '1.1rem', color: '#475569', fontSize: '0.82rem', lineHeight: 1.9 }}>
                  <li>Instala el APK</li>
                  <li>Abre la app</li>
                  <li>Escanea el QR que aparece en pantalla</li>
                  <li>Selecciona esta pantalla (<b>{installFor.name}</b>)</li>
                </ol>
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '1.25rem' }}>
              <button style={s.btnPrimary} onClick={() => setInstallFor(null)}>Listo</button>
            </div>
          </div>
        </div>,
        document.body
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
  modalBackdrop: { position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.55)', backdropFilter: 'blur(4px)', zIndex: 500, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1.5rem' },
  modalCard: { background: '#fff', borderRadius: '14px', width: '100%', maxWidth: '640px', overflow: 'hidden', boxShadow: '0 24px 64px rgba(0,0,0,0.25)' },
  modalHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.75rem', padding: '0.75rem 1rem', borderBottom: '1px solid #F1F5F9' },
  modalClose: { display: 'flex', alignItems: 'center', justifyContent: 'center', width: '30px', height: '30px', borderRadius: '7px', border: '1px solid #E2E8F0', background: '#F8FAFC', color: '#64748B', cursor: 'pointer', flexShrink: 0 },
  formCard: { background: '#fff', border: '1px solid #E2E8F0', borderRadius: '12px', padding: '1.5rem', marginBottom: '1.75rem', boxShadow: '0 1px 4px rgba(0,0,0,0.04)' },
  formTitle: { fontWeight: 700, color: '#0F172A', marginBottom: '1rem', fontSize: '1rem' },
  formRow: { display: 'flex', gap: '1.25rem', flexWrap: 'wrap', marginBottom: '1rem' },
  formGroup: { display: 'flex', flexDirection: 'column', gap: '0.35rem' },
  label: { color: '#64748B', fontSize: '0.8rem', fontWeight: 500 },
  input: { padding: '0.55rem 0.75rem', borderRadius: '8px', border: '1px solid #E2E8F0', background: '#fff', color: '#0F172A', fontSize: '0.875rem', outline: 'none' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '1.25rem' },
  list: { display: 'flex', flexDirection: 'column', gap: '0.5rem' },
  listRow: { display: 'flex', alignItems: 'center', gap: '0.85rem', background: '#fff', border: '1px solid #E2E8F0', borderRadius: '10px', padding: '0.7rem 1rem', boxShadow: '0 1px 3px rgba(0,0,0,0.03)' },
  viewToggle: { display: 'flex', gap: '2px', background: '#F1F5F9', border: '1px solid #E2E8F0', borderRadius: '8px', padding: '2px', flexShrink: 0 },
  viewBtn: { display: 'flex', alignItems: 'center', justifyContent: 'center', width: '30px', height: '30px', border: 'none', borderRadius: '6px', background: 'transparent', color: '#94A3B8', cursor: 'pointer' },
  viewBtnActive: { background: '#fff', color: '#2563EB', boxShadow: '0 1px 2px rgba(0,0,0,0.08)' },
  filterChip: { display: 'inline-flex', alignItems: 'center', gap: '0.4rem', padding: '0.4rem 0.8rem', borderRadius: '20px', border: '1px solid #E2E8F0', background: '#fff', color: '#64748B', fontSize: '0.8rem', fontWeight: 600, cursor: 'pointer' },
  filterChipActive: { background: '#EFF6FF', borderColor: '#BFDBFE', color: '#2563EB' },
  card: { background: '#fff', borderRadius: '14px', border: '1px solid #E2E8F0', boxShadow: '0 1px 6px rgba(0,0,0,0.04)', overflow: 'hidden' },
  cardHeader: { padding: '0.875rem 1.25rem 0.5rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  cardName: { fontWeight: 700, color: '#0F172A', fontSize: '0.95rem' },
  meta: { display: 'flex', alignItems: 'center', gap: '0.4rem', color: '#64748B', fontSize: '0.8rem' },
  cardActions: { padding: '0.75rem 1.25rem', borderTop: '1px solid #F1F5F9', display: 'flex', gap: '0.5rem', flexWrap: 'wrap' },
  btnAct: { padding: '0.38rem 0.75rem', borderRadius: '7px', border: '1px solid #E2E8F0', background: '#fff', color: '#64748B', fontSize: '0.78rem', fontWeight: 500, cursor: 'pointer' },
  btnPlayer: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.4rem', width: '100%', padding: '0.5rem 0.75rem', borderRadius: '8px', border: 'none', background: '#2563EB', color: '#fff', fontSize: '0.82rem', fontWeight: 600, cursor: 'pointer' },
  btnDel: { display: 'flex', alignItems: 'center', gap: '0.3rem', padding: '0.38rem 0.75rem', borderRadius: '7px', border: '1px solid #FECACA', background: '#FFF5F5', color: '#EF4444', fontSize: '0.78rem', fontWeight: 500, cursor: 'pointer' },
}