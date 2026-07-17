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

export default function CampaignReport({ campaignId, onBack }: { campaignId: string; onBack: () => void }) {
  const { profile } = useAuth()
  const [camp, setCamp] = useState<Campaign | null>(null)
  const [details, setDetails] = useState<Detail[]>([])
  const [orgName, setOrgName] = useState('')
  const [loading, setLoading] = useState(true)

  async function load() {
    setLoading(true)
    const [{ data: c }, { data: d }, { data: pd }] = await Promise.all([
      supabase.from('campaigns').select('*').eq('id', campaignId).single(),
      supabase.from('campaign_zone_detail').select('*').eq('campaign_id', campaignId),
      supabase.from('profiles').select('organization_id').eq('id', profile?.id ?? '').single(),
    ])
    if (c) setCamp(c as Campaign)
    if (d) {
      const rows = d as Detail[]
      // Fetch the injected records to get their storage_path
      const mediaIds = [...new Set(rows.map(r => r.media_id).filter(Boolean))]
      const pathById: Record<string, string> = {}
      const nameById: Record<string, string> = {}
      if (mediaIds.length > 0) {
        const { data: injected } = await supabase
          .from('media_content').select('id, name, storage_path').in('id', mediaIds)
        for (const m of (injected ?? [])) {
          pathById[m.id] = m.storage_path
          nameById[m.id] = m.name
        }
        // Resolve original name by storage_path (library items: campaign_id=null, zone_id=null)
        const paths = [...new Set(Object.values(pathById).filter(Boolean))]
        if (paths.length > 0) {
          const { data: originals } = await supabase
            .from('media_content').select('storage_path, name')
            .in('storage_path', paths).is('campaign_id', null).is('zone_id', null)
          const origByPath: Record<string, string> = {}
          for (const o of (originals ?? [])) origByPath[o.storage_path] = o.name
          // Override with original name when available
          for (const id of mediaIds) {
            const orig = origByPath[pathById[id]]
            if (orig) nameById[id] = orig
          }
        }
      }
      setDetails(rows.map(r => ({ ...r, media_name: nameById[r.media_id] ?? r.program_name })))
    }
    if (pd?.organization_id) {
      const { data: org } = await supabase.from('organizations').select('name').eq('id', pd.organization_id).single()
      if (org) setOrgName(org.name)
    }
    setLoading(false)
  }
  useEffect(() => { load() }, [campaignId])

  const totalPlays  = details.reduce((sum, d) => sum + Number(d.total_plays), 0)
  const todayPlays  = details.reduce((sum, d) => sum + Number(d.today_plays), 0)
  const totalZones  = details.length

  const daysLeft = camp ? Math.max(0, Math.ceil((new Date(camp.ends_at).getTime() - Date.now()) / (1000 * 60 * 60 * 24))) : 0

  // Group by screen for chart
  const byScreen = new Map<string, number>()
  details.forEach(d => {
    const key = d.screen_name ?? 'Sin pantalla'
    byScreen.set(key, (byScreen.get(key) ?? 0) + Number(d.total_plays))
  })
  const chartData = Array.from(byScreen.entries()).map(([name, plays]) => ({ name, plays }))

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
    doc.text('GestorPlayer', 14, 15)
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
    if (camp.daily_start_time && camp.daily_end_time) {
      line('Horario:', `${camp.daily_start_time.slice(0,5)} - ${camp.daily_end_time.slice(0,5)}`)
    }
    line('Estado:',   camp.status.toUpperCase())

    // Table
    autoTable(doc, {
      startY: y + 6,
      head: [['Pantalla', 'Publicidad', 'Zona', 'Rep/día', 'Total']],
      body: details.map(d => [
        d.screen_name ?? '—',
        d.media_name ?? d.program_name,
        d.zone_name,
        String(d.reps_per_day ?? '—'),
        Number(d.total_plays).toLocaleString(),
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
    doc.text('Powered by GestorPlayer', pageW - 14, pageH - 12, { align: 'right' })

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

      {/* Stat cards */}
      <div style={s.statGrid}>
        <div style={{ ...s.statCard, background: 'linear-gradient(135deg, #EFF6FF, #DBEAFE)', borderColor: '#BFDBFE' }}>
          <div style={{ ...s.statIcon, background: '#2563EB' }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
          </div>
          <div>
            <div style={s.statVal}>{totalZones}</div>
            <div style={s.statLbl}>Zonas activas</div>
          </div>
        </div>

        <div style={{ ...s.statCard, background: 'linear-gradient(135deg, #ECFDF5, #D1FAE5)', borderColor: '#A7F3D0' }}>
          <div style={{ ...s.statIcon, background: '#059669' }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2"><polygon points="5,3 19,12 5,21"/></svg>
          </div>
          <div>
            <div style={s.statVal}>{totalPlays.toLocaleString()}</div>
            <div style={s.statLbl}>Reproducciones totales</div>
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

      {/* Chart */}
      <div style={s.card}>
        <div style={{ marginBottom: '1rem' }}>
          <h3 style={s.cardTitle}>Reproducciones por pantalla</h3>
          <p style={s.cardSub}>Distribución total en el período de la campaña</p>
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
          <p style={s.cardSub}>Reproducciones registradas en cada punto</p>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={s.th}>Pantalla</th>
                <th style={s.th}>Publicidad</th>
                <th style={s.th}>Zona</th>
                <th style={{ ...s.th, textAlign: 'right' }}>Rep/día</th>
                <th style={{ ...s.th, textAlign: 'right' }}>Total</th>
                <th style={{ ...s.th, textAlign: 'right' }}>Hoy</th>
              </tr>
            </thead>
            <tbody>
              {details.length === 0 ? (
                <tr><td colSpan={6} style={{ padding: '2rem', textAlign: 'center', color: '#94A3B8' }}>Sin datos.</td></tr>
              ) : details.map((d, i) => {
                const showScreen = i === 0 || details[i - 1].screen_id !== d.screen_id
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
                    <td style={{ ...s.td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{d.reps_per_day ?? '—'}</td>
                    <td style={{ ...s.td, textAlign: 'right', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{Number(d.total_plays).toLocaleString()}</td>
                    <td style={{ ...s.td, textAlign: 'right', color: '#059669', fontVariantNumeric: 'tabular-nums' }}>{Number(d.today_plays).toLocaleString()}</td>
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
  th:         { padding: '0.75rem 1rem', textAlign: 'left' as const, color: '#94A3B8', fontSize: '0.72rem', fontWeight: 700, borderBottom: '1px solid #F1F5F9', background: '#FAFBFC', textTransform: 'uppercase' as const, letterSpacing: '0.05em', whiteSpace: 'nowrap' as const },
  td:         { padding: '0.75rem 1rem', color: '#0F172A', fontSize: '0.85rem' },
}
