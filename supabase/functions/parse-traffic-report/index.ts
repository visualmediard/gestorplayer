// Edge Function: interpreta el Excel de conteo vehicular de la empresa externa.
//
// SOLO INTERPRETA: no escribe en la base. Así el panel puede mostrar una vista
// previa y avisar de solapamientos ANTES de que el usuario confirme; el
// guardado lo hace el frontend con un upsert bajo RLS.
//
// Se parsea aquí y no en el navegador para no meter ~800 KB de librería al
// bundle que cargan todos los usuarios, todos los días, por una función que se
// usa una vez al mes. Además, si el proveedor cambia el formato, se corrige
// con un `functions deploy` sin tocar la web.
//
// Formato observado (Av. Kennedy & Av. Máximo Gómez, jul-ago 2026):
//   fila 1: "29 jul 2026 - 12 ago 2026"          ← periodo
//   fila 2: "<ubicación> - <dirección completa>" ← punto de medición
//   fila 3: Fecha | Peatones | Autos | Camiones | Autobús | Bicicletas |
//           Motocicletas | Total Conteo | Total Impactos
//   filas 4+: un día por fila, y una fila final "Total" que se descarta.
//
// Las cabeceras NO se asumen por posición ni la tabla por número de fila: se
// busca la fila que contiene "Fecha" y las columnas se localizan por nombre.
// Si el proveedor inserta una columna, sigue funcionando.

import * as XLSX from 'https://esm.sh/xlsx@0.18.5'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? ''

const MAX_BYTES = 5 * 1024 * 1024   // un reporte mensual pesa ~25 KB

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { ...cors, 'Content-Type': 'application/json' },
  })
}

// Normaliza para comparar cabeceras: sin acentos, sin espacios de más.
function norm(s: unknown): string {
  return String(s ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .trim().toLowerCase()
}

const MONTHS: Record<string, number> = {
  ene: 1, feb: 2, mar: 3, abr: 4, may: 5, jun: 6,
  jul: 7, ago: 8, sep: 9, set: 9, oct: 10, nov: 11, dic: 12,
}

// "29 jul 2026 - 12 ago 2026" → { fromY, toY, fromM, toM }
function parsePeriod(text: string) {
  const re = /(\d{1,2})\s*([a-zá-ú]{3,})\.?\s*(\d{4})/gi
  const found: { d: number; m: number; y: number }[] = []
  for (const m of text.matchAll(re)) {
    const mm = MONTHS[norm(m[2]).slice(0, 3)]
    if (mm) found.push({ d: +m[1], m: mm, y: +m[3] })
  }
  if (found.length < 2) return null
  return { from: found[0], to: found[found.length - 1] }
}

const pad = (n: number) => String(n).padStart(2, '0')

// "29/jul" no trae año: se deduce del periodo. Con un reporte a caballo entre
// dos años (dic → ene), el año de inicio daría una fecha anterior al periodo,
// así que en ese caso se toma el de fin.
function resolveDate(cell: unknown, period: ReturnType<typeof parsePeriod>): string | null {
  if (cell === null || cell === undefined || cell === '') return null

  // En el reporte observado la columna Fecha son celdas de TEXTO ("29/jul"),
  // así que SheetJS las entrega como string. Pero si el proveedor las guardara
  // como fecha real, llegarían como Date o como serial de Excel (días desde el
  // 30/12/1899), y el parseo de texto de abajo fallaría en silencio dejando el
  // archivo entero sin días utilizables. Se cubren los tres casos.
  if (cell instanceof Date) {
    return `${cell.getUTCFullYear()}-${pad(cell.getUTCMonth() + 1)}-${pad(cell.getUTCDate())}`
  }
  if (typeof cell === 'number' && isFinite(cell) && cell > 20000 && cell < 80000) {
    const d = new Date(Math.round((cell - 25569) * 86400000))  // 25569 = 1970-01-01
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
  }

  const raw = String(cell).trim()
  if (!raw) return null

  const m = raw.match(/^(\d{1,2})\s*[\/\-\s]\s*([a-zá-ú]{3,})\.?$/i)
  if (!m || !period) return null
  const day = +m[1]
  const mon = MONTHS[norm(m[2]).slice(0, 3)]
  if (!mon || day < 1 || day > 31) return null

  const candidates = period.from.y === period.to.y
    ? [period.from.y]
    : [period.from.y, period.to.y]

  for (const y of candidates) {
    const iso = `${y}-${pad(mon)}-${pad(day)}`
    const fromISO = `${period.from.y}-${pad(period.from.m)}-${pad(period.from.d)}`
    const toISO   = `${period.to.y}-${pad(period.to.m)}-${pad(period.to.d)}`
    if (iso >= fromISO && iso <= toISO) return iso
  }
  // Fuera del periodo declarado: se devuelve con el año de inicio y quien
  // llama lo marca como aviso, en vez de descartar un día en silencio.
  return `${period.from.y}-${pad(mon)}-${pad(day)}`
}

function toInt(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(String(v).replace(/[^\d.-]/g, ''))
  return isFinite(n) ? Math.round(n) : null
}

// Cabecera del proveedor → columna de traffic_counts.
const COLUMNS: { key: string; match: string[] }[] = [
  { key: 'pedestrians', match: ['peatones', 'peaton'] },
  { key: 'cars',        match: ['autos', 'auto', 'carros', 'vehiculos livianos'] },
  { key: 'trucks',      match: ['camiones', 'camion'] },
  { key: 'buses',       match: ['autobus', 'autobuses', 'buses', 'bus'] },
  { key: 'bikes',       match: ['bicicletas', 'bicicleta'] },
  { key: 'motorcycles', match: ['motocicletas', 'motocicleta', 'motos'] },
  { key: 'total_count', match: ['total conteo', 'conteo total'] },
  { key: 'total_impacts', match: ['total impactos', 'impactos totales', 'impactos'] },
]

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Método no permitido' }, 405)
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return json({ error: 'Función no configurada en el servidor' }, 500)
  }

  // 1. Autenticar y exigir rol admin: importar aforo es una acción de admin,
  //    igual que la escritura en traffic_counts.
  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return json({ error: 'No autorizado' }, 401)

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  })
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) return json({ error: 'Sesión inválida' }, 401)

  const { data: profile } = await supabase
    .from('profiles').select('role').eq('id', user.id).single()
  if (profile?.role !== 'admin') {
    return json({ error: 'Solo un administrador puede importar reportes de conteo' }, 403)
  }

  // 2. Leer el archivo
  let form: FormData
  try { form = await req.formData() }
  catch { return json({ error: 'Cuerpo inválido (se esperaba multipart/form-data)' }, 400) }

  const file = form.get('file')
  if (!(file instanceof File)) return json({ error: 'Falta el archivo' }, 400)
  if (file.size > MAX_BYTES) return json({ error: 'El archivo es demasiado grande' }, 413)

  // 3. Parsear la hoja como matriz cruda (header:1): la tabla no empieza en la
  //    primera fila, así que no se puede dejar que la librería infiera cabeceras.
  let grid: unknown[][]
  try {
    const wb = XLSX.read(new Uint8Array(await file.arrayBuffer()), { type: 'array' })
    const ws = wb.Sheets[wb.SheetNames[0]]
    if (!ws) throw new Error('el archivo no tiene hojas')
    grid = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null }) as unknown[][]
  } catch (e) {
    return json({ error: 'No se pudo leer el Excel: ' + (e as Error).message }, 400)
  }

  const warnings: string[] = []

  // 4. Periodo y ubicación: las dos primeras filas con contenido, antes de la
  //    cabecera. Se buscan por forma, no por número de fila.
  const headerIdx = grid.findIndex(r => (r ?? []).some(c => norm(c) === 'fecha'))
  if (headerIdx < 0) {
    return json({ error: 'No se encontró la fila de cabeceras (falta la columna "Fecha")' }, 400)
  }

  let periodText = ''
  let location = ''
  for (let i = 0; i < headerIdx; i++) {
    const text = (grid[i] ?? []).map(c => String(c ?? '').trim()).filter(Boolean).join(' ')
    if (!text) continue
    if (!periodText && parsePeriod(text)) periodText = text
    else if (!location) location = text
  }

  const period = parsePeriod(periodText)
  if (!period) {
    return json({ error: 'No se pudo leer el periodo del reporte (primera fila)' }, 400)
  }
  if (!location) warnings.push('El archivo no indica la ubicación del punto de medición.')

  // 5. Mapear columnas por NOMBRE, no por posición
  const header = grid[headerIdx] ?? []
  const dateCol = header.findIndex(c => norm(c) === 'fecha')
  const colIndex: Record<string, number> = {}
  for (const col of COLUMNS) {
    const idx = header.findIndex(c => col.match.includes(norm(c)))
    if (idx >= 0) colIndex[col.key] = idx
  }
  if (colIndex.total_impacts === undefined) {
    return json({
      error: 'El reporte no trae la columna "Total Impactos", que es la cifra que se reporta al cliente.',
    }, 400)
  }
  for (const col of COLUMNS) {
    if (colIndex[col.key] === undefined && col.key !== 'total_impacts') {
      warnings.push(`No se encontró la columna "${col.match[0]}"; ese desglose quedará vacío.`)
    }
  }

  // 6. Filas de datos. La fila "Total" se descarta porque su primera celda no
  //    es una fecha, no por su posición.
  const fromISO = `${period.from.y}-${pad(period.from.m)}-${pad(period.from.d)}`
  const toISO   = `${period.to.y}-${pad(period.to.m)}-${pad(period.to.d)}`

  const rows: Record<string, unknown>[] = []
  const seen = new Set<string>()

  for (let i = headerIdx + 1; i < grid.length; i++) {
    const r = grid[i] ?? []
    const iso = resolveDate(r[dateCol], period)
    if (!iso) continue                       // fila "Total" o vacía

    if (iso < fromISO || iso > toISO) {
      warnings.push(`El día ${iso} queda fuera del periodo declarado (${fromISO} a ${toISO}); se importará igual.`)
    }
    if (seen.has(iso)) {
      warnings.push(`El día ${iso} aparece más de una vez en el archivo; se conserva el primero.`)
      continue
    }
    seen.add(iso)

    const row: Record<string, unknown> = { date: iso }
    for (const col of COLUMNS) {
      row[col.key] = colIndex[col.key] === undefined ? null : toInt(r[colIndex[col.key]])
    }
    if (row.total_impacts === null) {
      warnings.push(`El día ${iso} no trae "Total Impactos"; se omite.`)
      continue
    }
    rows.push(row)
  }

  if (rows.length === 0) {
    return json({ error: 'El archivo no contiene ningún día con datos utilizables.', warnings }, 400)
  }

  // Huecos dentro del periodo: el reporte debe reflejar los días REALMENTE
  // cubiertos, así que conviene saberlo antes de confirmar la importación.
  const expected = Math.round(
    (Date.parse(toISO) - Date.parse(fromISO)) / 86400000) + 1
  if (rows.length < expected) {
    warnings.push(`El periodo abarca ${expected} días pero el archivo trae ${rows.length}.`)
  }

  return json({
    location,
    source_file: file.name,
    period: { from: fromISO, to: toISO },
    rows,
    totals: {
      days: rows.length,
      total_count: rows.reduce((a, r) => a + ((r.total_count as number) ?? 0), 0),
      total_impacts: rows.reduce((a, r) => a + ((r.total_impacts as number) ?? 0), 0),
    },
    warnings,
  }, 200)
})
