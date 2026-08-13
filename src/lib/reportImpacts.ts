import type { jsPDF } from 'jspdf'

export type TrafficImpacts = {
  days_counted: number
  days_with_plays: number
  impacts: number
  plays: number
  breakdown: {
    pedestrians: number; cars: number; trucks: number
    buses: number; bikes: number; motorcycles: number
  }
  by_screen: { screen_name: string; days: number; impacts: number; plays: number }[]
}

const nf = (n: number) => (n || 0).toLocaleString('es-DO')

// Sección de impactos estimados del PDF. Compartida por el reporte de campaña
// y el de contenido, que solo se diferencian en el texto de la cobertura.
//
// Se dibuja con primitivas (rect, roundedRect) en vez de texto plano porque es
// la cifra que el cliente final mira primero: una tabla de números no comunica
// la proporción entre tipos de vehículo, y esa proporción es lo que hace
// creíble el total.
//
// Devuelve la Y donde continuar.
export function drawImpactsSection(
  doc: jsPDF,
  pageW: number,
  y: number,
  imp: TrafficImpacts,
  coverageLabel: string,
  playsLabel: string,
): number {
  const M = 14                      // margen izquierdo, igual que el resto
  const W = pageW - M * 2

  doc.setTextColor(15, 23, 42)
  doc.setFont('helvetica', 'bold'); doc.setFontSize(11)
  doc.text('Impactos estimados', M, y)
  y += 5

  // ── Tarjeta del titular ──────────────────────────────────────────────────
  const cardH = 24
  doc.setFillColor(240, 253, 244)              // verde muy claro
  doc.setDrawColor(187, 247, 208)
  doc.setLineWidth(0.3)
  doc.roundedRect(M, y, W, cardH, 2.5, 2.5, 'FD')
  doc.setFillColor(16, 185, 129)               // acento sólido a la izquierda
  doc.roundedRect(M, y, 1.8, cardH, 0.9, 0.9, 'F')

  doc.setFont('helvetica', 'bold'); doc.setFontSize(20); doc.setTextColor(6, 95, 70)
  doc.text(nf(imp.impacts), M + 7, y + 12)
  const numW = doc.getTextWidth(nf(imp.impacts))
  doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(21, 128, 61)
  doc.text('personas', M + 9 + numW, y + 12)

  doc.setFontSize(8.5); doc.setTextColor(71, 85, 105)
  doc.text(coverageLabel, M + 7, y + 19)
  y += cardH + 7

  // ── Barras por tipo ──────────────────────────────────────────────────────
  // Proporcionales al mayor, no al total: con seis categorías muy desiguales,
  // escalar al total dejaría las pequeñas invisibles.
  const b = imp.breakdown
  const rows: [string, number][] = [
    ['Peatones', b.pedestrians], ['Autos', b.cars], ['Motocicletas', b.motorcycles],
    ['Camiones', b.trucks], ['Autobuses', b.buses], ['Bicicletas', b.bikes],
  ]
  const max = Math.max(1, ...rows.map(r => r[1]))
  const labelW = 26
  const valueW = 22
  const barMax = W - labelW - valueW - 4

  doc.setFontSize(8)
  for (const [label, v] of rows) {
    doc.setFont('helvetica', 'normal'); doc.setTextColor(71, 85, 105)
    doc.text(label, M, y + 2.6)

    doc.setFillColor(226, 232, 240)                       // carril
    doc.roundedRect(M + labelW, y, barMax, 3.4, 1.7, 1.7, 'F')
    const wBar = Math.max(1.5, (v / max) * barMax)
    doc.setFillColor(37, 99, 235)                         // barra
    doc.roundedRect(M + labelW, y, wBar, 3.4, 1.7, 1.7, 'F')

    doc.setFont('helvetica', 'bold'); doc.setTextColor(15, 23, 42)
    doc.text(nf(v), M + labelW + barMax + 3, y + 2.6)
    y += 6.2
  }

  y += 1
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(71, 85, 105)
  doc.text(playsLabel, M, y)
  y += 5.5

  // ── Desglose por emplazamiento (solo con más de uno) ─────────────────────
  if (imp.by_screen.length > 1) {
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5); doc.setTextColor(100, 116, 139)
    doc.text('Por emplazamiento', M, y)
    y += 5
    doc.setFont('helvetica', 'normal'); doc.setTextColor(71, 85, 105)
    for (const r of imp.by_screen) {
      doc.text(r.screen_name, M, y)
      doc.text(`${r.days} dias`, M + W - 46, y, { align: 'right' })
      doc.setFont('helvetica', 'bold'); doc.setTextColor(15, 23, 42)
      doc.text(nf(r.impacts), M + W, y, { align: 'right' })
      doc.setFont('helvetica', 'normal'); doc.setTextColor(71, 85, 105)
      y += 5
    }
    y += 1
  }

  doc.setFontSize(7.5); doc.setTextColor(148, 163, 184)
  doc.text('Fuente: reporte de conteo vehicular de terceros', M, y)
  return y + 5
}
