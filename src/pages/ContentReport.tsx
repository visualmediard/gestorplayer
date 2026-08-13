import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../auth/AuthContext'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable'
import { drawReportHeader } from '../lib/reportHeader'
import { drawImpactsSection } from '../lib/reportImpacts'

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
  reps_per_day: number | null   // 0 = ilimitado
  total: number
  today: number
  last: string | null
}

type RangeMode = '14d' | '30d' | 'custom'

const isoDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const fmtDay = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('es-DO', { day: '2-digit', month: 'short' })
}

// Impactos estimados: cruce de reproducciones con el aforo del emplazamiento.
// Misma forma que devuelve campaign_traffic_impacts.
type TrafficImpacts = {
  days_counted: number
  days_with_plays: number
  impacts: number
  plays: number
  breakdown: { pedestrians: number; cars: number; trucks: number; buses: number; bikes: number; motorcycles: number }
  by_screen: { screen_name: string; days: number; impacts: number; plays: number }[]
}

const nfmt = (n: number) => (n || 0).toLocaleString('es-DO')

export default function ContentReport({
  name, type, onBack,
}: { name: string; type: string; onBack: () => void }) {
  const { profile } = useAuth()
  const [placements, setPlacements] = useState<Placement[]>([])
  const [daily, setDaily] = useState<{ date: string; plays: number }[]>([])
  const [rangeByContent, setRangeByContent] = useState<Record<string, number>>({})
  const [impacts, setImpacts] = useState<TrafficImpacts | null>(null)
  const [orgName, setOrgName] = useState('')
  const [logoUrl, setLogoUrl] = useState<string | null>(null)
  const [orgContact, setOrgContact] = useState<{ address: string | null; phone: string | null; email: string | null }>({ address: null, phone: null, email: null })
  const [loading, setLoading] = useState(true)
  const [rangeMode, setRangeMode] = useState<RangeMode>('14d')
  const [customFrom, setCustomFrom] = useState(isoDay(new Date(Date.now() - 13 * 864e5)))
  const [customTo, setCustomTo] = useState(isoDay(new Date()))
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null)

  // Límites del rango activo (fechas locales, inclusive). Igual que campaña.
  const fromIso = rangeMode === 'custom' ? customFrom : isoDay(new Date(Date.now() - (rangeMode === '30d' ? 29 : 13) * 864e5))
  const toIso   = rangeMode === 'custom' ? customTo   : isoDay(new Date())

  async function load() {
    setLoading(true)
    const { data: pd } = await supabase
      .from('profiles').select('organization_id').eq('id', profile?.id ?? '').single()
    const orgId = pd?.organization_id ?? ''
    if (orgId) {
      // select('*') para no fallar si aún no existen las columnas de contacto.
      const { data: org } = await supabase.from('organizations').select('*').eq('id', orgId).single()
      if (org) {
        setOrgName(org.name); setLogoUrl(org.logo_url ?? null)
        setOrgContact({ address: (org as any).address ?? null, phone: (org as any).phone ?? null, email: (org as any).email ?? null })
      }
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
    const freqOf: Record<string, number | null> = {}    // content_id → rep/día (0 = ilimitado)
    const progOf: Record<string, string | null> = {}    // zone_id → program_id
    const screensOf: Record<string, string[]> = {}      // program_id → nombres de pantalla
    if (contentIds.length > 0) {
      const { data: mc } = await supabase
        .from('media_content').select('id, zone_id, daily_frequency, is_unlimited').in('id', contentIds)
      for (const m of (mc ?? [])) {
        zoneOf[m.id] = m.zone_id ?? null
        freqOf[m.id] = m.is_unlimited ? 0 : (m.daily_frequency ?? null)
      }

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
        reps_per_day: freqOf[r.content_id] ?? null,
        total: Number(r.total_reproductions) || 0,
        today: Number(r.today_reproductions) || 0,
        last: r.last_reproduction ?? null,
      }
    })
    setPlacements(pls)
    setLoading(false)
  }
  useEffect(() => { load() }, [name]) // eslint-disable-line react-hooks/exhaustive-deps

  // Carga las cifras del RANGO desde playback_events (respeta el batching con
  // SUM(count)). Se recarga al cambiar el rango o las colocaciones.
  async function loadRange() {
    const ids = placements.map(p => p.content_id)
    if (ids.length === 0 || !fromIso || !toIso || fromIso > toIso) { setDaily([]); setRangeByContent({}); return }
    const [y1, m1, d1] = fromIso.split('-').map(Number)
    const [y2, m2, d2] = toIso.split('-').map(Number)
    const from = new Date(y1, m1 - 1, d1, 0, 0, 0, 0)
    const toEx = new Date(y2, m2 - 1, d2 + 1, 0, 0, 0, 0)   // fin exclusivo

    const { data: evs } = await supabase
      .from('playback_events')
      .select('content_id, played_at, count')
      .in('content_id', ids)
      .gte('played_at', from.toISOString())
      .lt('played_at', toEx.toISOString())

    const byDay: Record<string, number> = {}
    const byContent: Record<string, number> = {}
    for (const e of (evs ?? [])) {
      const n = Number(e.count) || 1
      const key = isoDay(new Date(e.played_at))
      byDay[key] = (byDay[key] ?? 0) + n
      byContent[e.content_id] = (byContent[e.content_id] ?? 0) + n
    }
    const series: { date: string; plays: number }[] = []
    for (let t = new Date(from); t < toEx; t = new Date(t.getTime() + 864e5)) {
      series.push({ date: `${t.getDate()}/${t.getMonth() + 1}`, plays: byDay[isoDay(t)] ?? 0 })
    }
    setDaily(series)
    setRangeByContent(byContent)
    // Impactos del mismo rango. Si la RPC falla (p. ej. aún sin correr la
    // migración) se queda en null y la sección no aparece.
    const { data: imp } = await supabase.rpc('content_traffic_impacts', {
      p_name: name, p_from: from.toISOString(), p_to: toEx.toISOString(),
    })
    setImpacts((imp as TrafficImpacts) ?? null)

    setLastUpdate(new Date())
  }
  useEffect(() => { loadRange() }, [placements, fromIso, toIso]) // eslint-disable-line react-hooks/exhaustive-deps

  // Refresco automático cada 10 min (alineado al batching), solo datos del rango.
  useEffect(() => {
    const iv = setInterval(() => { loadRange() }, 600_000)
    return () => clearInterval(iv)
  }, [placements, fromIso, toIso]) // eslint-disable-line react-hooks/exhaustive-deps

  // Totales DEL RANGO seleccionado.
  const totalPlays = daily.reduce((s, d) => s + d.plays, 0)
  const todayKey = `${new Date().getDate()}/${new Date().getMonth() + 1}`
  const todayPlays = daily.find(d => d.date === todayKey)?.plays ?? 0
  const lastPlay = placements.map(p => p.last).filter(Boolean).sort().pop() ?? null

  // Agrupa por pantalla → zona con las reproducciones DEL RANGO.
  const byZone = new Map<string, { screen_name: string; zone_name: string; reps_per_day: number | null; plays: number }>()
  for (const p of placements) {
    if (!p.screen_name) continue
    const key = `${p.screen_name}|${p.zone_name}`
    const plays = rangeByContent[p.content_id] ?? 0
    const ex = byZone.get(key)
    if (!ex) byZone.set(key, { screen_name: p.screen_name, zone_name: p.zone_name, reps_per_day: p.reps_per_day, plays })
    else ex.plays += plays
  }
  const zoneRows = Array.from(byZone.values()).sort((a, b) => b.plays - a.plays)

  // Gráfico por pantalla (agrega zonas de una misma pantalla), acotado al rango.
  const byScreen = new Map<string, number>()
  zoneRows.forEach(z => byScreen.set(z.screen_name, (byScreen.get(z.screen_name) ?? 0) + z.plays))
  const chartData = Array.from(byScreen.entries()).map(([name, plays]) => ({ name, plays }))

  // Trae el logo de la organización como data URL vía Edge Function (que lo
  // descarga en el servidor, evitando el bloqueo CORS del dominio de R2).
  async function fetchLogoDataUrl(): Promise<string | null> {
    try {
      const { data, error } = await supabase.functions.invoke('get-org-logo')
      if (error || !data?.dataUrl) return null
      return data.dataUrl as string
    } catch { return null }
  }

  function imgDims(dataUrl: string): Promise<{ w: number; h: number }> {
    return new Promise((resolve, reject) => {
      const img = new Image()
      img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight })
      img.onerror = reject
      img.src = dataUrl
    })
  }

  async function downloadPDF() {
    const doc = new jsPDF()
    const pageW = doc.internal.pageSize.getWidth()
    const pageH = doc.internal.pageSize.getHeight()

    // ── Cabecera tipo membrete: logo centrado + banda con datos de empresa ──
    const cardY = await drawReportHeader(doc, pageW, {
      logoData: logoUrl ? await fetchLogoDataUrl() : null,
      imgDims, orgName, orgContact,
      title: 'Reporte de contenido',
      subtitle: name.length > 70 ? name.slice(0, 70) + '…' : name,
    })

    // Tarjetas de resumen (mismas que el reporte de campaña: Reproducciones,
    // Pantallas, Promedio/día). El promedio se calcula sobre los últimos 14 días.
    const screenCount = new Set(zoneRows.map(z => z.screen_name ?? '—')).size
    const dailyTotal = daily.reduce((s, d) => s + d.plays, 0)
    const avgPerDay = daily.length ? Math.round(dailyTotal / daily.length) : 0
    const cardH = 22, gap = 5
    const cardW = (pageW - 28 - 2 * gap) / 3
    const cards: { label: string; value: string; color: [number, number, number] }[] = [
      { label: 'REPRODUCCIONES', value: totalPlays.toLocaleString(), color: [37, 99, 235] },
      { label: 'PANTALLAS',      value: String(screenCount),          color: [16, 185, 129] },
      { label: 'PROMEDIO / DÍA', value: avgPerDay.toLocaleString(),   color: [139, 92, 246] },
    ]
    cards.forEach((c, i) => {
      const x = 14 + i * (cardW + gap)
      doc.setFillColor(248, 250, 252)
      doc.setDrawColor(226, 232, 240)
      doc.roundedRect(x, cardY, cardW, cardH, 2.5, 2.5, 'FD')
      doc.setFillColor(c.color[0], c.color[1], c.color[2])
      doc.roundedRect(x, cardY, 1.6, cardH, 0.8, 0.8, 'F')
      doc.setTextColor(c.color[0], c.color[1], c.color[2])
      doc.setFont('helvetica', 'bold'); doc.setFontSize(16)
      doc.text(c.value, x + 6, cardY + 11)
      doc.setTextColor(148, 163, 184)
      doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5)
      doc.text(c.label, x + 6, cardY + 17)
    })

    // Detalles
    let y = cardY + cardH + 13
    doc.setTextColor(15, 23, 42); doc.setFont('helvetica', 'bold'); doc.setFontSize(11)
    doc.text('Detalles', 14, y)
    y += 6
    const line = (label: string, value: string) => {
      doc.setFont('helvetica', 'bold'); doc.setFontSize(9.5); doc.setTextColor(100, 116, 139)
      doc.text(label, 14, y)
      doc.setFont('helvetica', 'normal'); doc.setTextColor(30, 41, 59)
      doc.text(value, 50, y)
      y += 6.5
    }
    // Cliente/Período/Horario/Estado son propios de una campaña; un contenido
    // suelto no los tiene. Se muestran los campos que sí aplican al anuncio.
    line('Tipo', type === 'video' ? 'Video' : type === 'image' ? 'Imagen' : 'URL')
    line('Reporte del', `${fmtDay(fromIso)} al ${fmtDay(toIso)}`)
    line('Reproducciones hoy', todayPlays.toLocaleString())
    line('Última rep.', lastPlay ? new Date(lastPlay).toLocaleString('es-DO') : '—')

    // Tabla — mismas columnas que el reporte de campaña.
    if (impacts && impacts.days_counted > 0) {
      y = drawImpactsSection(doc, pageW, y + 5, impacts,
        `Cobertura de aforo: ${impacts.days_counted} de ${impacts.days_with_plays} dias con reproduccion`,
        `El anuncio salio ${nfmt(impacts.plays)} veces en esos dias`)
    }

    autoTable(doc, {
      startY: y + 4,
      head: [['Pantalla', 'Publicidad', 'Zona', 'Rep/día', 'Reproducciones']],
      body: zoneRows.map(z => [
        z.screen_name ?? '—',
        name,
        z.zone_name,
        z.reps_per_day === 0 ? 'Ilimitado' : String(z.reps_per_day ?? '—'),
        z.plays.toLocaleString(),
      ]),
      headStyles: { fillColor: [37, 99, 235], textColor: 255, fontStyle: 'bold', fontSize: 9 },
      bodyStyles: { fontSize: 9, textColor: [30, 41, 59] },
      alternateRowStyles: { fillColor: [248, 250, 252] },
      columnStyles: {
        3: { halign: 'center' },
        4: { halign: 'right', fontStyle: 'bold', textColor: [37, 99, 235] },
      },
      styles: { cellPadding: 3.5, lineColor: [237, 242, 247], lineWidth: 0.1 },
      margin: { left: 14, right: 14 },
    })

    // Total destacado
    let finalY = (doc as any).lastAutoTable.finalY + 8
    if (finalY + 20 > pageH - 20) { doc.addPage(); finalY = 20 }
    doc.setFillColor(37, 99, 235)
    doc.roundedRect(14, finalY, pageW - 28, 14, 2.5, 2.5, 'F')
    doc.setTextColor(255, 255, 255); doc.setFont('helvetica', 'bold'); doc.setFontSize(11)
    doc.text('TOTAL REPRODUCCIONES', 20, finalY + 9)
    doc.setFontSize(14)
    doc.text(totalPlays.toLocaleString(), pageW - 20, finalY + 9.5, { align: 'right' })

    // Footer con número de página
    const pageCount = (doc as any).internal.getNumberOfPages()
    const genStamp = `Generado: ${new Date().toLocaleDateString('es-DO')} ${new Date().toLocaleTimeString('es-DO', { hour: '2-digit', minute: '2-digit' })}`
    for (let p = 1; p <= pageCount; p++) {
      doc.setPage(p)
      doc.setDrawColor(226, 232, 240)
      doc.line(14, pageH - 16, pageW - 14, pageH - 16)
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(148, 163, 184)
      doc.text(genStamp, 14, pageH - 10)
      doc.text(`${orgName || 'GestPlayer'}  ·  Página ${p} de ${pageCount}`, pageW - 14, pageH - 10, { align: 'right' })
    }

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
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
          <span style={{ color: '#94A3B8', fontSize: '0.78rem' }}>Del {fmtDay(fromIso)} al {fmtDay(toIso)}</span>
          {lastUpdate && <span style={{ color: '#94A3B8', fontSize: '0.75rem' }}>· Actualizado: {lastUpdate.toLocaleTimeString('es-DO')}</span>}
          <span
            title="Los reproductores acumulan las reproducciones y las envían en lotes cada 10 minutos. Por eso los contadores suben en bloque."
            style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem', background: '#F1F5F9', color: '#64748B', fontSize: '0.7rem', fontWeight: 600, padding: '2px 8px', borderRadius: '20px', border: '1px solid #E2E8F0', cursor: 'help' }}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
            Sincroniza cada 10 min
          </span>
        </div>
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
          <div><div style={s.statVal}>{zoneRows.filter(z => z.plays > 0).length}</div><div style={s.statLbl}>Zonas con reproducciones</div></div>
        </div>
        <div style={{ ...s.statCard, background: 'linear-gradient(135deg, #FEF3C7, #FDE68A)', borderColor: '#FCD34D' }}>
          <div style={{ ...s.statIcon, background: '#D97706' }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
          </div>
          <div><div style={{ ...s.statVal, fontSize: '1.1rem' }}>{lastPlay ? new Date(lastPlay).toLocaleDateString('es-DO') : '—'}</div><div style={s.statLbl}>Última reproducción</div></div>
        </div>
      </div>

      {impacts && impacts.days_counted > 0 && (
        <div style={s.card}>
          <h3 style={s.cardTitle}>Impactos estimados</h3>

          <div style={{ fontSize: '2.1rem', fontWeight: 800, color: '#0F172A', lineHeight: 1.15, marginTop: '0.5rem' }}>
            {nfmt(impacts.impacts)} <span style={{ fontSize: '1rem', fontWeight: 600, color: '#64748B' }}>personas</span>
          </div>

          {/* Siempre visible, también al 100%: cuando cubre todo es argumento
              de venta, y estar siempre evita que el cliente desconfíe. */}
          <div style={{ fontSize: '0.82rem', color: '#64748B', marginTop: '0.3rem' }}>
            Cobertura de aforo: {impacts.days_counted} de {impacts.days_with_plays} días con reproducción
          </div>
          <div style={{ fontSize: '0.82rem', color: '#64748B', marginTop: '0.15rem' }}>
            Este anuncio salió {nfmt(impacts.plays)} veces en esos días
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', marginTop: '0.9rem' }}>
            {[
              ['Peatones', impacts.breakdown.pedestrians], ['Autos', impacts.breakdown.cars],
              ['Motos', impacts.breakdown.motorcycles], ['Camiones', impacts.breakdown.trucks],
              ['Autobuses', impacts.breakdown.buses], ['Bicicletas', impacts.breakdown.bikes],
            ].map(([label, v]) => (
              <span key={label as string} style={{ background: '#F8FAFC', border: '1px solid #E2E8F0', borderRadius: '999px', padding: '0.2rem 0.6rem', fontSize: '0.75rem', color: '#475569' }}>
                {label as string} <strong style={{ color: '#0F172A' }}>{nfmt(v as number)}</strong>
              </span>
            ))}
          </div>

          {impacts.by_screen.length > 1 && (
            <div style={{ marginTop: '0.9rem', borderTop: '1px solid #F1F5F9', paddingTop: '0.7rem' }}>
              {impacts.by_screen.map(r => (
                <div key={r.screen_name} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', color: '#475569', padding: '0.2rem 0' }}>
                  <span>{r.screen_name}</span>
                  <span>{r.days} días · <strong style={{ color: '#0F172A' }}>{nfmt(r.impacts)}</strong></span>
                </div>
              ))}
            </div>
          )}

          <div style={{ fontSize: '0.7rem', color: '#94A3B8', marginTop: '0.8rem' }}>
            Fuente: reporte de conteo vehicular de terceros
          </div>
        </div>
      )}

      {/* Chart por día */}
      <div style={s.card}>
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
      <div style={{ ...s.card, marginTop: '1.25rem' }}>
        <div style={{ marginBottom: '1rem' }}>
          <h3 style={s.cardTitle}>Reproducciones por pantalla</h3>
          <p style={s.cardSub}>Distribución en el rango seleccionado</p>
        </div>
        {chartData.length === 0 ? (
          <p style={{ color: '#94A3B8', fontSize: '0.9rem', textAlign: 'center', padding: '3rem 0' }}>Sin reproducciones registradas en este rango.</p>
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

      {/* Detalle por zona */}
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
              {zoneRows.length === 0 ? (
                <tr><td colSpan={5} style={{ padding: '2rem', textAlign: 'center', color: '#94A3B8' }}>Sin datos.</td></tr>
              ) : zoneRows.map((z, i) => (
                <tr key={i} className="table-row" style={{ borderBottom: '1px solid #F8FAFC' }}>
                  <td style={{ ...s.td, fontWeight: 600 }}>{z.screen_name}</td>
                  <td style={{ ...s.td, color: '#0F172A' }}>{name}</td>
                  <td style={{ ...s.td, color: '#64748B' }}>{z.zone_name}</td>
                  <td style={{ ...s.td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{z.reps_per_day === 0 ? '∞' : (z.reps_per_day ?? '—')}</td>
                  <td style={{ ...s.td, textAlign: 'right', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{z.plays.toLocaleString()}</td>
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
  dateInput:  { padding: '0.38rem 0.6rem', borderRadius: '7px', border: '1px solid #E2E8F0', background: '#fff', color: '#0F172A', fontSize: '0.82rem', outline: 'none' },
  th:         { padding: '0.75rem 1rem', textAlign: 'left', color: '#94A3B8', fontSize: '0.72rem', fontWeight: 700, borderBottom: '1px solid #F1F5F9', background: '#FAFBFC', textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap' },
  td:         { padding: '0.75rem 1rem', color: '#0F172A', fontSize: '0.85rem' },
}
