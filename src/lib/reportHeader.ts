import type { jsPDF } from 'jspdf'

export type OrgContact = { address: string | null; phone: string | null; email: string | null }

type HeaderOpts = {
  logoData: string | null
  imgDims: (dataUrl: string) => Promise<{ w: number; h: number }>
  orgName: string
  orgContact: OrgContact
  title: string
  subtitle: string
}

// Dibuja la cabecera tipo membrete de los reportes PDF: logo centrado arriba y,
// debajo, una banda sombreada con los datos de la empresa (nombre, dirección,
// teléfono · email). Luego el título del reporte, en la misma línea gráfica de
// antes. Devuelve la Y donde debe arrancar el contenido (tarjetas de resumen).
export async function drawReportHeader(doc: jsPDF, pageW: number, opts: HeaderOpts): Promise<number> {
  const { logoData, imgDims, orgName, orgContact, title, subtitle } = opts
  let hy = 12

  // 1. Logo centrado (o nombre grande si no hay logo).
  if (logoData) {
    try {
      const { w, h } = await imgDims(logoData)
      const fmt = logoData.startsWith('data:image/png') ? 'PNG'
        : logoData.startsWith('data:image/webp') ? 'WEBP' : 'JPEG'
      const ratio = w / h
      let dh = 16, dw = dh * ratio
      if (dw > 80) { dw = 80; dh = dw / ratio }
      doc.addImage(logoData, fmt, (pageW - dw) / 2, hy, dw, dh)
      hy += dh + 4
    } catch { hy = 22 }
  } else {
    doc.setTextColor(30, 58, 95)
    doc.setFont('helvetica', 'bold'); doc.setFontSize(18)
    doc.text(orgName || 'GestPlayer', pageW / 2, hy + 6, { align: 'center' })
    hy += 12
  }

  // 2. Banda con los datos de la empresa (solo si hay algún dato de contacto).
  const infoLines: string[] = []
  if (orgContact.address) infoLines.push(orgContact.address)
  const phoneEmail = [orgContact.phone, orgContact.email].filter(Boolean).join('   ·   ')
  if (phoneEmail) infoLines.push(phoneEmail)

  if (infoLines.length > 0) {
    const bandTop = hy
    const bandH = 10 + infoLines.length * 5
    doc.setFillColor(238, 242, 247)
    doc.rect(0, bandTop, pageW, bandH, 'F')
    doc.setDrawColor(226, 232, 240)
    doc.line(0, bandTop, pageW, bandTop)
    doc.line(0, bandTop + bandH, pageW, bandTop + bandH)
    // Rótulo "DE" + nombre en la misma fila.
    doc.setFont('helvetica', 'bold'); doc.setFontSize(7); doc.setTextColor(30, 58, 95)
    doc.text('DE', 14, bandTop + 6)
    doc.setFont('helvetica', 'bold'); doc.setFontSize(10.5); doc.setTextColor(15, 23, 42)
    doc.text(orgName || 'GestPlayer', 24, bandTop + 6)
    // Líneas de contacto.
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); doc.setTextColor(71, 85, 105)
    let ly = bandTop + 12
    for (const ln of infoLines) { doc.text(ln, 14, ly); ly += 5 }
    hy = bandTop + bandH
  }

  // 3. Título + subtítulo del reporte (misma línea gráfica de antes).
  const titleY = hy + 11
  doc.setTextColor(15, 23, 42)
  doc.setFont('helvetica', 'bold'); doc.setFontSize(17)
  doc.text(title, 14, titleY)
  doc.setFont('helvetica', 'normal'); doc.setFontSize(11); doc.setTextColor(100, 116, 139)
  doc.text(subtitle, 14, titleY + 7)

  return titleY + 15
}
