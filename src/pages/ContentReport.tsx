import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../auth/AuthContext'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable'

// Reporte de repeticiones para un video/imagen SUELTO (no de campaña).
// Agrupa todas las colocaciones del mismo archivo (por nombre) y muestra:
// totales, reproducciones por día, y el detalle por pantalla → zona.
//
// La pantalla se resuelve con la cadena contenido → zona → programa →
// screens.current_program_id. Solo se listan filas con pantalla asignada
// (colocaciones históricas sin pantalla suman en los totales pero no se
// muestran en la tabla).

type Placement = {
  content_id: string
  zone_name: string
  screen_name: string | null
  total: number
  today: number
  last: string | null
}

export default function ContentReport({
  name, type, onBack,
}: { name: string; type: string; onBack: () => void }) {
  const { profile } = useAuth()
  const [placements, setPlacements] = useState<Placement[]>([])
  const [daily, setDaily] = useState<{ date: string; plays: number }[]>([])
  const [orgName, setOrgName] = useState('')
  const [loading, setLoading] = useState(true)

  async function load() {
    setLoading(true)
    const { data: pd } = await supabase
      .from('profiles').select('organization_id').eq('id', profile?.id ?? '').single()
    const orgId = pd?.organization_id ?? ''
    if (orgId) {
      const { data: org } = await supabase.from('organizations').select('name').eq('id', orgId).single()
      if (org) setOrgName(org.name)
    }

    // Todas las colocaciones (content_ids) de este archivo, por nombre.
    const { data: rows } = await supabase
      .from('content_stats')
      .select('content_id, zone_name, total_reproductions, today_reproductions, last_reproduction')
      .eq('organization_id', orgId)
      .eq('name', name)

    // Resolver la pantalla de cada colocación: contenido → zona → programa →
    // pantalla (screens.current_program_id). Lecturas puntuales, sin loops.
    const contentIds = (rows ?? []).map((r: any) => r.content_id)
    const zoneOf: Record<string, string | null> = {}    // content_id → zone_id
    const progOf: Record<string, string | null> = {}    // zone_id → program_id
    const screensOf: Record<string, string[]> = {}      // program_id → nombres de pantalla
    if (contentIds.length > 0) {
      const { data: mc } = await supabase
        .from('media_content').select('id, zone_id').in('id', contentIds)
      for (const m of (mc ?? [])) zoneOf[m.id] = m.zone_id ?? null

      const zoneIds = [...new Set(Object.values(zoneOf).filter(Boolean))] as string[]
      if (zoneIds.length > 0) {
        const { data: zs } = await supabase
          .from('zones').select('id, program_id').in('id', zoneIds)
        for (const z of (zs ?? [])) progOf[z.id] = z.program_id ?? null

        const progIds = [...new Set(Object.values(progOf).filter(Boolean))] as string[]
        if (progIds.length > 0) {
          const { data: scs } = await supabase
            .from('screens').select('name, current_program_id').in('current_program_id', progIds)
          for (const sc of (scs ?? [])) {
            if (!sc.current_program_id) continue
            if (!screensOf[sc.current_program_id]) screensOf[sc.current_program_id] = []
            screensOf[sc.current_program_id].push(sc.name)
          }
        }
      }
    }

    const pls: Placement[] = (rows ?? []).map((r: any) => {
      const zid = zoneOf[r.content_id] ?? null
      const pid = zid ? (progOf[zid] ?? null) : null
      const names = pid ? (screensOf[pid] ?? []) : []
      return {
        content_id: r.content_id,
        zone_name: r.zone_name ?? '—',
        screen_name: names.length > 0 ? names.join(', ') : null,
        total: Number(r.total_reproductions) || 0,
        today: Number(r.today_reproductions) || 0,
        last: r.last_reproduction ?? null,
      }
    })
    setPlacements(pls)

    // Reproducciones por día (últimos 14 días) desde playback_events.
    const ids = pls.map(p => p.content_id)
    if (ids.length > 0) {
      const since = new Date(Date.now() - 13 * 864e5)
      since.setHours(0, 0, 0, 0)
      const { data: evs } = await supabase
        .from('playback_events')
        .select('played_at, count')
        .in('content_id', ids)
        .gte('played_at', since.toISOString())
      const byDay: Record<string, number> = {}
      for (const e of (evs ?? [])) {
        const d = new Date(e.played_at)
        const key = `${d.getDate()}/${d.getMonth() + 1}`
        // Con el batching una fila representa N reproducciones: hay que sumar
        // `count`, no contar filas (antes subcontaba ~15x).
        byDay[key] = (byDay[key] ?? 0) + (Number(e.count) || 1)
      }
      const days: { date: string; plays: number }[] = []
      for (let i = 13; i >= 0; i--) {
        const d = new Date(Date.now() - i * 864e5)
        const key = `${d.getDate()}/${d.getMonth() + 1}`
        days.push({ date: key, plays: byDay[key] ?? 0 })
      }
      setDaily(days)
    } else {
      setDaily([])
    }
    setLoading(false)
  }
  useEffect(() => { load() }, [name]) // eslint-disable-line react-hooks/exhaustive-deps

  // Agrupa por pantalla → zona para la tabla de detalle. Solo se muestran
  // filas con pantalla asignada (Opción A); las históricas sin pantalla
  // siguen sumando en los totales de arriba.
  const byZone = new Map<string, Placement>()
  for (const p of placements) {
    const key = `${p.screen_name ?? ''}|${p.zone_name}`
    const ex = byZone.get(key)
    if (!ex) byZone.set(key, { ...p })
    else { ex.total += p.total; ex.today += p.today; if ((p.last ?? '') > (ex.last ?? '')) ex.last = p.last }
  }
  const zoneRows = Array.from(byZone.values())
    .filter(z => z.screen_name)
    .sort((a, b) => b.total - a.total)

  const totalPlays = placements.reduce((s, p) => s + p.total, 0)
  const todayPlays = placements.reduce((s, p) => s + p.today, 0)
  const lastPlay = placements.map(p => p.last).filter(Boolean).sort().pop() ?? null

  function downloadPDF() {
    const doc = new jsPDF()
    const pageW = doc.internal.pageSize.getWidth()

    doc.setFillColor(37, 99, 235)
    doc.rect(0, 0, pageW, 30, 'F')
    doc.setTextColor(255, 255, 255)
    doc.setFont('helvetica', 'bold'); doc.setFontSize(20)
    doc.text('GestPlayer', 14, 15)
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10)
    doc.text(orgName || 'Digital Signage Platform', 14, 22)

    doc.setTextColor(15, 23, 42)
    doc.setFont('helvetica', 'bold'); doc.setFontSize(16)
    doc.text('REPORTE DE CONTENIDO', 14, 45)
    doc.setDrawColor(226, 232, 240); doc.line(14, 48, pageW - 14, 48)

    let y = 58
    const line = (label: string, value: string) => {
      doc.setFont('helvetica', 'bold'); doc.setTextColor(15, 23, 42); doc.setFontSize(10)
      doc.text(label, 14, y)
      doc.setFont('helvetica', 'normal'); doc.setTextColor(71, 85, 105)
      doc.text(value, 55, y)
      y += 7
    }
    line('Contenido:', name)
    line('Tipo:', type === 'video' ? 'Video' : type === 'image' ? 'Imagen' : 'URL')
    line('Total rep.:', totalPlays.toLocaleString())
    line('Hoy:', todayPlays.toLocaleString())
    line('Última rep.:', lastPlay ? new Date(lastPlay).toLocaleString('es-DO') : '—')

    autoTable(doc, {
      startY: y + 6,
      head: [['Pantalla', 'Zona', 'Total', 'Hoy']],
      body: zoneRows.map(z => [
        z.screen_name ?? '—', z.zone_name, z.total.toLocaleString(), z.today.toLocaleString(),
      ]),
      headStyles: { fillColor: [37, 99, 235], textColor: 255, fontStyle: 'bold', fontSize: 9 },
      bodyStyles: { fontSize: 9, textColor: [15, 23, 42] },
      alternateRowStyles: { fillColor: [248, 250, 252] },
      styles: { cellPadding: 3 },
      margin: { left: 14, right: 14 },
    })

    const finalY = (doc as any).lastAutoTable.finalY + 8
    doc.setFillColor(239, 246, 255)
    doc.rect(14, finalY, pageW - 28, 12, 'F')
    doc.setTextColor(37, 99, 235); doc.setFont('helvetica', 'bold'); doc.setFontSize(11)
    doc.text('TOTAL REPRODUCCIONES:', 18, finalY + 8)
    doc.setFontSize(12)
    doc.text(totalPlays.toLocaleString(), pageW - 18, finalY + 8, { align: 'right' })

    const pageH = doc.internal.pageSize.getHeight()
    doc.setDrawColor(226, 232, 240); doc.line(14, pageH - 18, pageW - 14, pageH - 18)
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(148, 163, 184)
    doc.text(`Generado: ${new Date().toLocaleDateString('es-DO')} ${new Date().toLocaleTimeString('es-DO', { hour: '2-digit', minute: '2-digit' })}`, 14, pageH - 12)
    doc.text('Powered by GestPlayer', pageW - 14, pageH - 12, { align: 'right' })

    doc.save(`reporte-${name.replace(/\s+/g, '-').toLowerCase().slice(0, 40)}.pdf`)
  }

  if (loading) {
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
            <h1 style={s.title}>{name}</h1>
            <p style={s.sub}>{type === 'video' ? 'Video' : type === 'image' ? 'Imagen' : 'URL'} · Reporte de contenido</p>
          </div>
        </div>
        <button onClick={downloadPDF} style={s.btnPrimary}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          Descargar PDF
        </button>
      </div>

      {/* Stat cards */}
      <div style={s.statGrid}>
        <div style={{ ...s.statCard, background: 'linear-gradient(135deg, #ECFDF5, #D1FAE5)', borderColor: '#A7F3D0' }}>
          <div style={{ ...s.statIcon, background: '#059669' }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2"><polygon points="5,3 19,12 5,21"/></svg>
          </div>
          <div><div style={s.statVal}>{totalPlays.toLocaleString()}</div><div style={s.statLbl}>Reproducciones totales</div></div>
        </div>
        <div style={{ ...s.statCard, background: 'linear-gradient(135deg, #EFF6FF, #DBEAFE)', borderColor: '#BFDBFE' }}>
          <div style={{ ...s.statIcon, background: '#2563EB' }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          </div>
          <div><div style={s.statVal}>{todayPlays.toLocaleString()}</div><div style={s.statLbl}>Reproducciones hoy</div></div>
        </div>
        <div style={{ ...s.statCard, background: 'linear-gradient(135deg, #F5F3FF, #EDE9FE)', borderColor: '#DDD6FE' }}>
          <div style={{ ...s.statIcon, background: '#7C3AED' }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/></svg>
          </div>
          <div><div style={s.statVal}>{zoneRows.length}</div><div style={s.statLbl}>Zonas donde aparece</div></div>
        </div>
        <div style={{ ...s.statCard, background: 'linear-gradient(135deg, #FEF3C7, #FDE68A)', borderColor: '#FCD34D' }}>
          <div style={{ ...s.statIcon, background: '#D97706' }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
          </div>
          <div><div style={{ ...s.statVal, fontSize: '1.1rem' }}>{lastPlay ? new Date(lastPlay).toLocaleDateString('es-DO') : '—'}</div><div style={s.statLbl}>Última reproducción</div></div>
        </div>
      </div>

      {/* Chart por día */}
      <div style={s.card}>
        <div style={{ marginBottom: '1rem' }}>
          <h3 style={s.cardTitle}>Reproducciones por día</h3>
          <p style={s.cardSub}>Últimos 14 días</p>
        </div>
        {daily.every(d => d.plays === 0) ? (
          <p style={{ color: '#94A3B8', fontSize: '0.9rem', textAlign: 'center', padding: '3rem 0' }}>Sin reproducciones en los últimos 14 días.</p>
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

      {/* Detalle por zona */}
      <div style={{ ...s.card, marginTop: '1.25rem' }}>
        <div style={{ marginBottom: '1rem' }}>
          <h3 style={s.cardTitle}>Detalle por pantalla y zona</h3>
          <p style={s.cardSub}>Dónde se está reproduciendo este contenido</p>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={s.th}>Pantalla</th>
                <th style={s.th}>Zona</th>
                <th style={{ ...s.th, textAlign: 'right' }}>Total</th>
                <th style={{ ...s.th, textAlign: 'right' }}>Hoy</th>
              </tr>
            </thead>
            <tbody>
              {zoneRows.length === 0 ? (
                <tr><td colSpan={4} style={{ padding: '2rem', textAlign: 'center', color: '#94A3B8' }}>Sin pantallas mostrando este contenido ahora mismo.</td></tr>
              ) : zoneRows.map((z, i) => (
                <tr key={i} className="table-row" style={{ borderBottom: '1px solid #F8FAFC' }}>
                  <td style={{ ...s.td, fontWeight: 600 }}>{z.screen_name}</td>
                  <td style={{ ...s.td, color: '#64748B' }}>{z.zone_name}</td>
                  <td style={{ ...s.td, textAlign: 'right', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{z.total.toLocaleString()}</td>
                  <td style={{ ...s.td, textAlign: 'right', color: '#059669', fontVariantNumeric: 'tabular-nums' }}>{z.today.toLocaleString()}</td>
                </tr>
              ))}
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
  th:         { padding: '0.75rem 1rem', textAlign: 'left', color: '#94A3B8', fontSize: '0.72rem', fontWeight: 700, borderBottom: '1px solid #F1F5F9', background: '#FAFBFC', textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap' },
  td:         { padding: '0.75rem 1rem', color: '#0F172A', fontSize: '0.85rem' },
}
