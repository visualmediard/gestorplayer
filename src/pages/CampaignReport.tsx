import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../auth/AuthContext'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable'

type Campaign = {
  id: string; name: string; client_name: string | null
  media_content_id: string | null
  starts_at: string; ends_at: string
  daily_start_time: string | null; daily_end_time: string | null
  status: string
}
type Detail = {
  campaign_id: string; media_id: string
  reps_per_day: number
  zone_id: string; zone_name: string
  program_id: string; program_name: string
  screen_id: string | null; screen_name: string | null
  total_plays: number; today_plays: number
  media_name?: string
}

// ── Rango de fechas del reporte ────────────────────────────────────────
// Los totales salen de playback_events acotado al rango (vía RPC que agrega
// en el servidor con SUM(count)), no de las vistas históricas.
type RangeMode = '14d' | '30d' | 'custom'

function isoDay(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function fmtDay(iso: string) {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('es-DO')
}

export default function CampaignReport({ campaignId, onBack }: { campaignId: string; onBack: () => void }) {
  const { profile } = useAuth()
  const [camp, setCamp] = useState<Campaign | null>(null)
  const [details, setDetails] = useState<Detail[]>([])
  const [orgName, setOrgName] = useState('')
  const [loading, setLoading] = useState(true)

  // Rango: por defecto últimos 14 días (igual que el reporte de contenido).
  const [rangeMode, setRangeMode] = useState<RangeMode>('14d')
  const [customFrom, setCustomFrom] = useState(isoDay(new Date(Date.now() - 13 * 864e5)))
  const [customTo, setCustomTo] = useState(isoDay(new Date()))
  const [daily, setDaily] = useState<{ date: string; plays: number }[]>([])
  const [byScreenRange, setByScreenRange] = useState<{ screen_name: string; zone_name: string; plays: number }[]>([])

  // Límites del rango activo (fechas locales, inclusive).
  const fromIso = rangeMode === 'custom' ? customFrom : isoDay(new Date(Date.now() - (rangeMode === '30d' ? 29 : 13) * 864e5))
  const toIso   = rangeMode === 'custom' ? customTo   : isoDay(new Date())

  async function load() {
    setLoading(true)
    const [{ data: c }, { data: pd }] = await Promise.all([
      supabase.from('campaigns').select('*').eq('id', campaignId).single(),
      supabase.from('profiles').select('organization_id').eq('id', profile?.id ?? '').single(),
    ])
    if (c) setCamp(c as Campaign)
    if (pd?.organization_id) {
      const { data: org } = await supabase.from('organizations').select('name').eq('id', pd.organization_id).single()
      if (org) setOrgName(org.name)
    }

    // Zone/screen/play data from view — aggregate per zone to avoid duplicates
    const { data: viewRows } = await supabase
      .from('campaign_zone_detail')
      .select('zone_id, zone_name, screen_id, screen_name, reps_per_day, total_plays, today_plays')
      .eq('campaign_id', campaignId)
    const zoneMap: Record<string, { zone_name: string; screen_id: string | null; screen_name: string | null; reps_per_day: number; total_plays: number; today_plays: number }> = {}
    for (const row of (viewRows ?? [])) {
      if (zoneMap[row.zone_id]) {
        zoneMap[row.zone_id].total_plays += Number(row.total_plays)
        zoneMap[row.zone_id].today_plays += Number(row.today_plays)
      } else {
        zoneMap[row.zone_id] = {
          zone_name: row.zone_name, screen_id: row.screen_id, screen_name: row.screen_name,
          reps_per_day: row.reps_per_day, total_plays: Number(row.total_plays), today_plays: Number(row.today_plays),
        }
      }
    }

    // Only media that belongs to this campaign (source of truth for media list)
    const { data: campMedia } = await supabase
      .from('media_content')
      .select('id, name, storage_path, zone_id, sub_playlist_id, daily_frequency, is_unlimited')
      .eq('campaign_id', campaignId)
      .is('archived_at', null)

    // Sub-playlist frequency lives on the sub_playlists row, not on individual items
    const subIds = [...new Set((campMedia ?? []).map(m => m.sub_playlist_id).filter(Boolean))]
    const subFreqMap: Record<string, { freq: number; unlimited: boolean }> = {}
    if (subIds.length > 0) {
      const { data: subs } = await supabase
        .from('sub_playlists').select('id, daily_frequency, is_unlimited').in('id', subIds)
      for (const s of (subs ?? []))
        subFreqMap[s.id] = { freq: s.daily_frequency ?? 0, unlimited: s.is_unlimited ?? true }
    }

    if (!campMedia || campMedia.length === 0) { setDetails([]); setLoading(false); return }

    // Resolve original name by storage_path (library records have campaign_id=null, zone_id=null)
    const paths = [...new Set(campMedia.map(m => m.storage_path).filter(Boolean))]
    const origName: Record<string, string> = {}
    if (paths.length > 0) {
      const { data: originals } = await supabase
        .from('media_content').select('storage_path, name')
        .in('storage_path', paths).is('campaign_id', null).is('zone_id', null)
      for (const o of (originals ?? [])) origName[o.storage_path] = o.name
    }

    // Build one row per campaign media item
    const rows: Detail[] = campMedia.map(m => {
      const z = zoneMap[m.zone_id] ?? { zone_name: '—', screen_id: null, screen_name: null, reps_per_day: 0, total_plays: 0, today_plays: 0 }
      return {
        campaign_id: campaignId, media_id: m.id,
        media_name: origName[m.storage_path] ?? m.name,
        zone_id: m.zone_id, zone_name: z.zone_name,
        program_id: '', program_name: '',
        screen_id: z.screen_id, screen_name: z.screen_name,
        reps_per_day: m.sub_playlist_id
          ? (subFreqMap[m.sub_playlist_id]?.unlimited ? 0 : (subFreqMap[m.sub_playlist_id]?.freq ?? 0))
          : (m.is_unlimited ? 0 : (m.daily_frequency ?? 0)),
        total_plays: z.total_plays, today_plays: z.today_plays,
      }
    })
    rows.sort((a, b) => {
      const sc = (a.screen_name ?? '').localeCompare(b.screen_name ?? '')
      return sc !== 0 ? sc : a.zone_name.localeCompare(b.zone_name)
    })
    setDetails(rows)
    setLoading(false)
  }
  useEffect(() => { load() }, [campaignId])

  // Carga las cifras del RANGO desde playback_events (RPC que agrega en el
  // servidor con SUM(count), respetando el batching). Se recarga al cambiar
  // el rango — evento del usuario, no polling.
  async function loadRange() {
    if (!fromIso || !toIso || fromIso > toIso) return
    const [y1, m1, d1] = fromIso.split('-').map(Number)
    const [y2, m2, d2] = toIso.split('-').map(Number)
    const from = new Date(y1, m1 - 1, d1, 0, 0, 0, 0)
    const toEx = new Date(y2, m2 - 1, d2 + 1, 0, 0, 0, 0)   // fin exclusivo

    const [{ data: dayRows }, { data: scrRows }] = await Promise.all([
      supabase.rpc('campaign_daily_plays', {
        p_campaign_id: campaignId, p_from: from.toISOString(), p_to: toEx.toISOString(),
      }),
      supabase.rpc('campaign_screen_plays', {
        p_campaign_id: campaignId, p_from: from.toISOString(), p_to: toEx.toISOString(),
      }),
    ])

    // Serie continua: incluye los días sin reproducciones como 0.
    const byDay: Record<string, number> = {}
    for (const r of (dayRows ?? [])) byDay[r.day as string] = Number(r.plays) || 0
    const series: { date: string; plays: number }[] = []
    for (let t = new Date(from); t < toEx; t = new Date(t.getTime() + 864e5)) {
      series.push({ date: `${t.getDate()}/${t.getMonth() + 1}`, plays: byDay[isoDay(t)] ?? 0 })
    }
    setDaily(series)
    setByScreenRange((scrRows ?? []).map((r: any) => ({
      screen_name: r.screen_name, zone_name: r.zone_name, plays: Number(r.plays) || 0,
    })))
  }
  useEffect(() => { loadRange() }, [campaignId, fromIso, toIso]) // eslint-disable-line react-hooks/exhaustive-deps

  // Totales DEL RANGO seleccionado.
  const totalPlays = daily.reduce((s, d) => s + d.plays, 0)
  const todayKey = `${new Date().getDate()}/${new Date().getMonth() + 1}`
  const todayPlays = daily.find(d => d.date === todayKey)?.plays ?? 0
  const totalZones = new Set(byScreenRange.map(r => `${r.screen_name}|${r.zone_name}`)).size

  const daysLeft = camp ? Math.max(0, Math.ceil((new Date(camp.ends_at).getTime() - Date.now()) / (1000 * 60 * 60 * 24))) : 0

  // Gráfico por pantalla — también acotado al rango.
  const byScreen = new Map<string, number>()
  byScreenRange.forEach(r => {
    byScreen.set(r.screen_name, (byScreen.get(r.screen_name) ?? 0) + r.plays)
  })
  const chartData = Array.from(byScreen.entries()).map(([name, plays]) => ({ name, plays }))

  // Detalle por zona: configuración (rep/día, publicidad) de la vista +
  // reproducciones del rango.
  const playsByZone = new Map<string, number>()
  byScreenRange.forEach(r => {
    const k = `${r.screen_name}|${r.zone_name}`
    playsByZone.set(k, (playsByZone.get(k) ?? 0) + r.plays)
  })
  const detailRows = details.map(d => ({
    ...d,
    range_plays: playsByZone.get(`${d.screen_name ?? '—'}|${d.zone_name}`) ?? 0,
  }))

  function downloadPDF() {
    if (!camp) return
    const doc = new jsPDF()
    const pageW = doc.internal.pageSize.getWidth()

    // Header bar
    doc.setFillColor(37, 99, 235)
    doc.rect(0, 0, pageW, 30, 'F')
    doc.setTextColor(255, 255, 255)
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(20)
    doc.text('GestPlayer', 14, 15)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(10)
    doc.text(orgName || 'Digital Signage Platform', 14, 22)

    // Report title
    doc.setTextColor(15, 23, 42)
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(16)
    doc.text('REPORTE DE CAMPAÑA', 14, 45)

    doc.setDrawColor(226, 232, 240)
    doc.line(14, 48, pageW - 14, 48)

    // Meta
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(10)
    doc.setTextColor(100, 116, 139)

    let y = 58
    const line = (label: string, value: string) => {
      doc.setFont('helvetica', 'bold'); doc.setTextColor(15, 23, 42)
      doc.text(label, 14, y)
      doc.setFont('helvetica', 'normal'); doc.setTextColor(71, 85, 105)
      doc.text(value, 55, y)
      y += 7
    }
    line('Campaña:',  camp.name)
    line('Cliente:',  camp.client_name ?? '—')
    line('Período:',  `${new Date(camp.starts_at).toLocaleDateString('es-DO')} - ${new Date(camp.ends_at).toLocaleDateString('es-DO')}`)
    // Rango del reporte: las cifras de abajo corresponden solo a este rango.
    line('Reporte del:', `${fmtDay(fromIso)} al ${fmtDay(toIso)}`)
    if (camp.daily_start_time && camp.daily_end_time) {
      line('Horario:', `${camp.daily_start_time.slice(0,5)} - ${camp.daily_end_time.slice(0,5)}`)
    }
    line('Estado:',   camp.status.toUpperCase())

    // Table
    autoTable(doc, {
      startY: y + 6,
      head: [['Pantalla', 'Publicidad', 'Zona', 'Rep/día', 'Reproducciones']],
      body: detailRows.map(d => [
        d.screen_name ?? '—',
        d.media_name ?? d.program_name,
        d.zone_name,
        d.reps_per_day === 0 ? 'Ilimitado' : String(d.reps_per_day ?? '—'),
        d.range_plays.toLocaleString(),
      ]),
      headStyles: { fillColor: [37, 99, 235], textColor: 255, fontStyle: 'bold', fontSize: 9 },
      bodyStyles: { fontSize: 9, textColor: [15, 23, 42] },
      alternateRowStyles: { fillColor: [248, 250, 252] },
      styles: { cellPadding: 3 },
      margin: { left: 14, right: 14 },
    })

    const finalY = (doc as any).lastAutoTable.finalY + 8

    // Total box
    doc.setFillColor(239, 246, 255)
    doc.rect(14, finalY, pageW - 28, 12, 'F')
    doc.setTextColor(37, 99, 235); doc.setFont('helvetica', 'bold'); doc.setFontSize(11)
    doc.text('TOTAL REPRODUCCIONES:', 18, finalY + 8)
    doc.setFontSize(12)
    doc.text(totalPlays.toLocaleString(), pageW - 18, finalY + 8, { align: 'right' })

    // Footer
    const pageH = doc.internal.pageSize.getHeight()
    doc.setDrawColor(226, 232, 240)
    doc.line(14, pageH - 18, pageW - 14, pageH - 18)
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(148, 163, 184)
    doc.text(`Generado: ${new Date().toLocaleDateString('es-DO')} ${new Date().toLocaleTimeString('es-DO', { hour: '2-digit', minute: '2-digit' })}`, 14, pageH - 12)
    doc.text('Powered by GestPlayer', pageW - 14, pageH - 12, { align: 'right' })

    doc.save(`reporte-${camp.name.replace(/\s+/g, '-').toLowerCase()}.pdf`)
  }

  if (loading || !camp) {
    return <div style={{ padding: '2rem' }}><div className="skeleton" style={{ height: '80px', borderRadius: '12px', marginBottom: '1rem' }} /><div className="skeleton" style={{ height: '300px', borderRadius: '12px' }} /></div>
  }

  return (
    <div>
      {/* Header */}
      <div style={s.topbar} className="page-topbar">
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.875rem', minWidth: 0 }}>
          <button onClick={onBack} style={s.btnBack}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><polyline points="15 18 9 12 15 6"/></svg>
            Volver
          </button>
          <div style={{ minWidth: 0 }}>
            <h1 style={s.title}>{camp.name}</h1>
            <p style={s.sub}>{camp.client_name ?? '—'} · Reporte de campaña</p>
          </div>
        </div>
        <button onClick={downloadPDF} style={s.btnPrimary}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          Descargar PDF
        </button>
      </div>

      {/* Selector de rango — las cifras de abajo corresponden a este rango */}
      <div style={{ ...s.card, padding: '0.875rem 1.25rem', marginBottom: '1.25rem', display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
        <span style={{ color: '#64748B', fontSize: '0.82rem', fontWeight: 600 }}>Rango:</span>
        {([['14d', 'Últimos 14 días'], ['30d', 'Últimos 30 días'], ['custom', 'Personalizado']] as [RangeMode, string][]).map(([mode, label]) => (
          <button
            key={mode}
            onClick={() => setRangeMode(mode)}
            style={{
              padding: '0.4rem 0.85rem', borderRadius: '7px', fontSize: '0.82rem', cursor: 'pointer',
              fontWeight: rangeMode === mode ? 700 : 500,
              border: `1px solid ${rangeMode === mode ? '#2563EB' : '#E2E8F0'}`,
              background: rangeMode === mode ? '#EFF6FF' : '#fff',
              color: rangeMode === mode ? '#2563EB' : '#64748B',
            }}
          >{label}</button>
        ))}
        {rangeMode === 'custom' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
            <input type="date" value={customFrom} max={customTo} onChange={e => setCustomFrom(e.target.value)} style={s.dateInput} />
            <span style={{ color: '#94A3B8', fontSize: '0.82rem' }}>al</span>
            <input type="date" value={customTo} min={customFrom} onChange={e => setCustomTo(e.target.value)} style={s.dateInput} />
          </div>
        )}
        <span style={{ marginLeft: 'auto', color: '#94A3B8', fontSize: '0.78rem' }}>
          Del {fmtDay(fromIso)} al {fmtDay(toIso)}
        </span>
      </div>

      {/* Stat cards */}
      <div style={s.statGrid}>
        <div style={{ ...s.statCard, background: 'linear-gradient(135deg, #EFF6FF, #DBEAFE)', borderColor: '#BFDBFE' }}>
          <div style={{ ...s.statIcon, background: '#2563EB' }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
          </div>
          <div>
            <div style={s.statVal}>{totalZones}</div>
            <div style={s.statLbl}>Zonas con reproducciones</div>
          </div>
        </div>

        <div style={{ ...s.statCard, background: 'linear-gradient(135deg, #ECFDF5, #D1FAE5)', borderColor: '#A7F3D0' }}>
          <div style={{ ...s.statIcon, background: '#059669' }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2"><polygon points="5,3 19,12 5,21"/></svg>
          </div>
          <div>
            <div style={s.statVal}>{totalPlays.toLocaleString()}</div>
            <div style={s.statLbl}>Reproducciones del rango</div>
          </div>
        </div>

        <div style={{ ...s.statCard, background: 'linear-gradient(135deg, #FEF3C7, #FDE68A)', borderColor: '#FCD34D' }}>
          <div style={{ ...s.statIcon, background: '#D97706' }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          </div>
          <div>
            <div style={s.statVal}>{todayPlays.toLocaleString()}</div>
            <div style={s.statLbl}>Reproducciones hoy</div>
          </div>
        </div>

        <div style={{ ...s.statCard, background: 'linear-gradient(135deg, #F5F3FF, #EDE9FE)', borderColor: '#DDD6FE' }}>
          <div style={{ ...s.statIcon, background: '#7C3AED' }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
          </div>
          <div>
            <div style={s.statVal}>{daysLeft}</div>
            <div style={s.statLbl}>Días restantes</div>
          </div>
        </div>
      </div>

      {/* Chart por día */}
      <div style={{ ...s.card, marginBottom: '1.25rem' }}>
        <div style={{ marginBottom: '1rem' }}>
          <h3 style={s.cardTitle}>Reproducciones por día</h3>
          <p style={s.cardSub}>Del {fmtDay(fromIso)} al {fmtDay(toIso)}</p>
        </div>
        {daily.length === 0 || daily.every(d => d.plays === 0) ? (
          <p style={{ color: '#94A3B8', fontSize: '0.9rem', textAlign: 'center', padding: '3rem 0' }}>Sin reproducciones en este rango.</p>
        ) : (
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={daily}>
              <CartesianGrid strokeDasharray="3 3" stroke="#F1F5F9" />
              <XAxis dataKey="date" tick={{ fill: '#64748B', fontSize: 12 }} axisLine={{ stroke: '#E2E8F0' }} tickLine={false} />
              <YAxis tick={{ fill: '#64748B', fontSize: 12 }} axisLine={{ stroke: '#E2E8F0' }} tickLine={false} allowDecimals={false} />
              <Tooltip
                contentStyle={{ background: '#fff', border: '1px solid #E2E8F0', borderRadius: '8px', fontSize: '0.85rem', boxShadow: '0 4px 12px rgba(0,0,0,0.08)' }}
                labelStyle={{ color: '#0F172A', fontWeight: 700 }}
                cursor={{ fill: '#EFF6FF' }}
              />
              <Bar dataKey="plays" fill="#2563EB" radius={[6, 6, 0, 0]} name="Reproducciones" />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Chart por pantalla */}
      <div style={s.card}>
        <div style={{ marginBottom: '1rem' }}>
          <h3 style={s.cardTitle}>Reproducciones por pantalla</h3>
          <p style={s.cardSub}>Distribución en el rango seleccionado</p>
        </div>
        {chartData.length === 0 ? (
          <p style={{ color: '#94A3B8', fontSize: '0.9rem', textAlign: 'center', padding: '3rem 0' }}>Sin reproducciones registradas todavía.</p>
        ) : (
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#F1F5F9" />
              <XAxis dataKey="name" tick={{ fill: '#64748B', fontSize: 12 }} axisLine={{ stroke: '#E2E8F0' }} tickLine={false} />
              <YAxis tick={{ fill: '#64748B', fontSize: 12 }} axisLine={{ stroke: '#E2E8F0' }} tickLine={false} />
              <Tooltip
                contentStyle={{ background: '#fff', border: '1px solid #E2E8F0', borderRadius: '8px', fontSize: '0.85rem', boxShadow: '0 4px 12px rgba(0,0,0,0.08)' }}
                labelStyle={{ color: '#0F172A', fontWeight: 700 }}
                cursor={{ fill: '#EFF6FF' }}
              />
              <Bar dataKey="plays" fill="#2563EB" radius={[6, 6, 0, 0]} name="Reproducciones" />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Detail table */}
      <div style={{ ...s.card, marginTop: '1.25rem' }}>
        <div style={{ marginBottom: '1rem' }}>
          <h3 style={s.cardTitle}>Detalle por zona</h3>
          <p style={s.cardSub}>Reproducciones del {fmtDay(fromIso)} al {fmtDay(toIso)}</p>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={s.th}>Pantalla</th>
                <th style={s.th}>Publicidad</th>
                <th style={s.th}>Zona</th>
                <th style={{ ...s.th, textAlign: 'right' }}>Rep/día</th>
                <th style={{ ...s.th, textAlign: 'right' }}>Reproducciones</th>
              </tr>
            </thead>
            <tbody>
              {detailRows.length === 0 ? (
                <tr><td colSpan={5} style={{ padding: '2rem', textAlign: 'center', color: '#94A3B8' }}>Sin datos.</td></tr>
              ) : detailRows.map((d, i) => {
                const showScreen = i === 0 || detailRows[i - 1].screen_id !== d.screen_id
                return (
                  <tr key={i} className="table-row" style={{ borderBottom: '1px solid #F8FAFC' }}>
                    <td style={s.td}>
                      {showScreen
                        ? <span style={{ fontWeight: 600, color: '#0F172A' }}>{d.screen_name ?? '—'}</span>
                        : <span style={{ color: '#CBD5E1', fontSize: '0.75rem', paddingLeft: '0.5rem' }}>↳</span>
                      }
                    </td>
                    <td style={{ ...s.td, color: '#0F172A' }}>{d.media_name ?? '—'}</td>
                    <td style={{ ...s.td, color: '#64748B' }}>{d.zone_name}</td>
                    <td style={{ ...s.td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{d.reps_per_day === 0 ? '∞' : (d.reps_per_day ?? '—')}</td>
                    <td style={{ ...s.td, textAlign: 'right', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{d.range_plays.toLocaleString()}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  topbar:     { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.75rem', flexWrap: 'wrap', gap: '1rem' },
  title:      { fontSize: '1.5rem', fontWeight: 700, color: '#0F172A', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  sub:        { color: '#64748B', fontSize: '0.875rem', marginTop: '0.2rem' },
  btnBack:    { display: 'flex', alignItems: 'center', gap: '0.375rem', padding: '0.5rem 0.875rem', borderRadius: '7px', border: '1px solid #E2E8F0', background: '#fff', color: '#64748B', fontWeight: 500, fontSize: '0.85rem', cursor: 'pointer', flexShrink: 0 },
  btnPrimary: { display: 'flex', alignItems: 'center', gap: '0.4rem', padding: '0.55rem 1rem', borderRadius: '8px', border: 'none', background: '#2563EB', color: '#fff', fontWeight: 600, fontSize: '0.875rem', cursor: 'pointer', whiteSpace: 'nowrap' },

  statGrid:   { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1rem', marginBottom: '1.5rem' },
  statCard:   { display: 'flex', alignItems: 'center', gap: '0.875rem', padding: '1.125rem', borderRadius: '12px', border: '1px solid' },
  statIcon:   { width: '42px', height: '42px', borderRadius: '10px', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  statVal:    { fontSize: '1.75rem', fontWeight: 800, color: '#0F172A', lineHeight: 1 },
  statLbl:    { fontSize: '0.78rem', color: '#64748B', marginTop: '4px', fontWeight: 500 },

  card:       { background: '#fff', border: '1px solid #E2E8F0', borderRadius: '14px', padding: '1.5rem', boxShadow: '0 1px 6px rgba(0,0,0,0.04)' },
  cardTitle:  { fontSize: '1rem', fontWeight: 700, color: '#0F172A' },
  cardSub:    { fontSize: '0.8rem', color: '#94A3B8', marginTop: '2px' },
  dateInput:  { padding: '0.38rem 0.6rem', borderRadius: '7px', border: '1px solid #E2E8F0', background: '#fff', color: '#0F172A', fontSize: '0.82rem', outline: 'none' },
  th:         { padding: '0.75rem 1rem', textAlign: 'left' as const, color: '#94A3B8', fontSize: '0.72rem', fontWeight: 700, borderBottom: '1px solid #F1F5F9', background: '#FAFBFC', textTransform: 'uppercase' as const, letterSpacing: '0.05em', whiteSpace: 'nowrap' as const },
  td:         { padding: '0.75rem 1rem', color: '#0F172A', fontSize: '0.85rem' },
}
