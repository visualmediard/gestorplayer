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

// Iconos de contacto dibujados con primitivas vectoriales (jsPDF no trae fuente
// de iconos). `y` es la línea base del texto; el icono se dibuja a su izquierda.
function drawContactIcon(doc: jsPDF, kind: 'pin' | 'phone' | 'mail', x: number, y: number) {
  doc.setDrawColor(37, 99, 235); doc.setFillColor(37, 99, 235); doc.setLineWidth(0.4)
  if (kind === 'pin') {
    doc.circle(x + 1.6, y - 2.4, 1.1, 'S')       // aro
    doc.circle(x + 1.6, y - 2.4, 0.4, 'F')        // centro
    doc.line(x + 1.6, y - 1.3, x + 1.6, y - 0.1)  // punta
  } else if (kind === 'phone') {
    doc.roundedRect(x + 0.5, y - 3.7, 2.6, 3.9, 0.5, 0.5, 'S')  // cuerpo
    doc.circle(x + 1.8, y - 0.6, 0.25, 'F')                     // botón
  } else {
    const w = 4, h = 2.9
    doc.rect(x, y - 3.1, w, h, 'S')                 // sobre
    doc.line(x, y - 3.1, x + w / 2, y - 1.5)        // solapa izq
    doc.line(x + w, y - 3.1, x + w / 2, y - 1.5)    // solapa der
  }
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

  // 2. Banda con los datos de la empresa: nombre + una fila por dato, cada una
  //    con su icono y su etiqueta (solo se muestran los campos que existan).
  const fields: { icon: 'pin' | 'phone' | 'mail'; label: string; value: string }[] = []
  if (orgContact.address) fields.push({ icon: 'pin', label: 'Dirección', value: orgContact.address })
  if (orgContact.phone) fields.push({ icon: 'phone', label: 'Teléfono', value: orgContact.phone })
  if (orgContact.email) fields.push({ icon: 'mail', label: 'Email', value: orgContact.email })

  if (fields.length > 0) {
    const bandTop = hy
    const rowH = 6
    const nameY = bandTop + 7
    const firstRowY = nameY + 6.5
    const bandH = (firstRowY - bandTop) + (fields.length - 1) * rowH + 4

    // Fondo + acento azul a la izquierda + líneas sutiles arriba/abajo.
    doc.setFillColor(238, 242, 247)
    doc.rect(0, bandTop, pageW, bandH, 'F')
    doc.setFillColor(37, 99, 235)
    doc.rect(0, bandTop, 1.6, bandH, 'F')
    doc.setDrawColor(226, 232, 240); doc.setLineWidth(0.2)
    doc.line(0, bandTop, pageW, bandTop)
    doc.line(0, bandTop + bandH, pageW, bandTop + bandH)

    // Nombre de la empresa (encabezado de la banda).
    doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(15, 23, 42)
    doc.text(orgName || 'GestPlayer', 14, nameY)

    // Filas: icono + etiqueta (negrita) + valor.
    let ly = firstRowY
    for (const f of fields) {
      drawContactIcon(doc, f.icon, 14, ly)
      doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5); doc.setTextColor(71, 85, 105)
      doc.text(f.label + ':', 21, ly)
      const labelW = doc.getTextWidth(f.label + ':  ')
      doc.setFont('helvetica', 'normal'); doc.setTextColor(51, 65, 85)
      doc.text(f.value, 21 + labelW, ly)
      ly += rowH
    }
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
