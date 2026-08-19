// Edge Function: conector con DataVisiooh (conteo vehicular).
//
// Acciones:
//   - validate: comprueba el token guardado contra /clients y persiste el hash
//               de cliente. Devuelve el nombre para que el admin confirme de
//               un vistazo que pegó el token correcto.
//   - panels:   lista los emplazamientos del cliente, cruzados con el estado
//               de sus sensores, para mapearlos a las zonas de GestPlayer.
//   - sync:     trae el conteo de los últimos días y lo vuelca en
//               traffic_counts, una fila por zona y día.
//
// EL TOKEN NUNCA SALE DE AQUÍ. Se lee con service_role desde
// traffic_provider_secrets --tabla que el frontend no puede ni consultar-- se
// usa como cabecera hacia DataVisiooh, y no aparece en ninguna respuesta ni en
// ningún log. Esa es la razón de ser de esta función: es el único lugar del
// sistema autorizado a verlo.
//
// La URL base es una constante, no un dato configurable: si el admin pudiera
// escribirla, este servidor haría fetch() a donde él quisiera (SSRF), que es
// exactamente el bug que se corrigió en get-org-logo.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4'

const SUPABASE_URL      = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
const SERVICE_ROLE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

const DATAVISIOOH_API = 'https://api4devs.datavisiooh.com'
const UPSTREAM_TIMEOUT_MS = 30_000

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

type Panel = { id: number; name: string; description: string | null; address: string | null }

// Una fila por bucket Y POR TIPO: hay que pivotarla a una fila por día.
type DataRow = { event_date: string; total: number; type: string }
type PanelBlock = { panel_id: number; data: DataRow[] | null }

// Tipos del proveedor → columnas de traffic_counts. El resto se ignora en
// silencio: si mañana añaden una categoría, la carga no debe romperse.
const TYPE_TO_COLUMN: Record<string, string> = {
  person: 'pedestrians',
  car: 'cars',
  truck: 'trucks',
  bus: 'buses',
  bicycle: 'bikes',
  motorbike: 'motorcycles',
}

// Ventana por defecto. Se re-pide una ventana entera en vez del último día
// porque el proveedor corrige datos recientes: al hacer upsert, cada
// sincronización repara sola lo que hubiera quedado mal.
const DEFAULT_DAYS = 7
const MAX_DAYS = 90

// Fecha "de hoy" en República Dominicana (UTC-4 todo el año, sin horario de
// verano). Se usa la hora local y no UTC porque los días del proveedor son
// días naturales de allí, y con UTC las últimas cuatro horas de cada jornada
// caerían en el día siguiente.
//
// PENDIENTE: el proveedor no documenta la zona horaria de event_date. Esto es
// la hipótesis razonable, no una certeza confirmada por ellos.
const RD_OFFSET_MS = 4 * 60 * 60 * 1000

function rdToday(): Date {
  const now = new Date(Date.now() - RD_OFFSET_MS)
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10)
}

// Enumera los días del rango, extremos incluidos. Se necesita completo porque
// un panel vivo sin datos escribe CEROS, y para eso hay que saber qué días
// tocaba escribir aunque el proveedor no devuelva ninguna fila de ellos.
function daysBetween(start: Date, end: Date): string[] {
  const out: string[] = []
  for (let t = start.getTime(); t <= end.getTime(); t += 86_400_000) {
    out.push(isoDay(new Date(t)))
  }
  return out
}

// data[] → { '2026-08-13': { cars: 32354, buses: 533, ... , _total: 97858 } }
function pivotByDay(rows: DataRow[] | null): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {}
  for (const r of rows ?? []) {
    const day = (r.event_date ?? '').slice(0, 10)
    if (!day) continue
    const col = TYPE_TO_COLUMN[r.type]
    const n = Number(r.total) || 0
    const bucket = out[day] ?? (out[day] = { _total: 0 })
    if (col) bucket[col] = (bucket[col] ?? 0) + n
    // El total del día suma TODOS los tipos, incluidos los que no tienen
    // columna propia: si no, el total dejaría de cuadrar con el desglose real
    // del proveedor en cuanto añadieran una categoría.
    bucket._total += n
  }
  return out
}
type SensorEntry = { status: number | null; updated: string | null }
type SensorsRow = { panel_id: number; sensors_status: Record<string, SensorEntry> | null }

// Marcas que el proveedor escribe a mano en la descripción. No hay campo
// `active` en su API: esta convención de texto es todo lo que hay.
const INACTIVE_HINTS = ['(desactivada)', '(eliminar)', '(conteo duplicado)']

function looksInactive(p: Panel): boolean {
  const d = (p.description ?? '').toLowerCase()
  return INACTIVE_HINTS.some(h => d.includes(h))
}

// Un panel puede declarar varios sensores. Se toma el de reporte más reciente
// como representativo: es el que mejor describe si ese emplazamiento está
// entregando datos ahora mismo.
function pickSensor(row: SensorsRow | undefined): { status: number | null; updated: string | null } {
  const map = row?.sensors_status
  if (!map) return { status: null, updated: null }
  let best: SensorEntry | null = null
  for (const entry of Object.values(map)) {
    if (!best || (entry.updated ?? '') > (best.updated ?? '')) best = entry
  }
  return { status: best?.status ?? null, updated: best?.updated ?? null }
}

// Llamada a DataVisiooh. Devuelve el cuerpo ya parseado o lanza con un mensaje
// que NO incluye las cabeceras enviadas (ahí va el token).
async function callProvider(path: string, token: string, hash?: string): Promise<unknown> {
  const headers: Record<string, string> = { 'api-token': token }
  if (hash) headers['hash'] = hash

  let res: Response
  try {
    res = await fetch(`${DATAVISIOOH_API}${path}`, {
      headers,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      // El host es una constante, pero seguir redirecciones lo volvería
      // variable: un 30x del upstream sacaría la petición --con el token en
      // la cabecera-- hacia otro dominio. Con 'error' no hay salto posible.
      redirect: 'error',
    })
  } catch (e) {
    throw new Error(`No se pudo contactar con DataVisiooh: ${(e as Error).name}`)
  }

  if (res.status === 401 || res.status === 403) {
    throw new Error('DataVisiooh rechazó el token. Comprueba que sea el vigente.')
  }
  if (!res.ok) {
    throw new Error(`DataVisiooh respondió ${res.status} en ${path}`)
  }
  return await res.json()
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Método no permitido' }, 405)

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SERVICE_ROLE_KEY) {
    return json({ error: 'Función no configurada en el servidor' }, 500)
  }

  // 1. Identificar al llamante con SU JWT. La autorización no se confía al
  //    cliente: se comprueba contra profiles, igual que en admin-manage-user.
  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return json({ error: 'No autorizado' }, 401)

  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  })
  const { data: { user }, error: authError } = await userClient.auth.getUser()
  if (authError || !user) return json({ error: 'Sesión inválida' }, 401)

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const { data: caller } = await admin
    .from('profiles').select('role, organization_id').eq('id', user.id).single()

  if (!caller || caller.role !== 'admin') {
    return json({ error: 'Solo un administrador puede configurar el conteo vehicular' }, 403)
  }
  if (!caller.organization_id) {
    return json({ error: 'El usuario no tiene organización' }, 400)
  }
  const orgId = caller.organization_id as string

  let body: { action?: string; days?: number }
  try { body = await req.json() } catch { return json({ error: 'Cuerpo inválido' }, 400) }

  const action = body.action
  if (action !== 'validate' && action !== 'panels' && action !== 'sync') {
    return json({ error: 'Acción no reconocida' }, 400)
  }

  // 2. El token, solo aquí dentro.
  const { data: secret } = await admin
    .from('traffic_provider_secrets').select('token')
    .eq('organization_id', orgId).single()

  if (!secret?.token) {
    return json({ error: 'No hay token configurado para tu organización' }, 400)
  }
  const token = secret.token as string

  // ── validate ────────────────────────────────────────────────────────────
  if (action === 'validate') {
    let payload: { clients?: { name: string; hash: string }[]; total?: number }
    try {
      payload = await callProvider('/clients', token) as typeof payload
    } catch (e) {
      return json({ error: (e as Error).message }, 502)
    }

    const clients = payload?.clients ?? []
    if (clients.length === 0) {
      return json({ error: 'El token es válido pero no da acceso a ninguna cuenta' }, 400)
    }

    // Se guarda la primera. Con varias cuentas haría falta que el admin
    // eligiera, así que se avisa en vez de decidir en silencio por él.
    const chosen = clients[0]

    const { error: upErr } = await admin
      .from('traffic_providers')
      .update({ hash: chosen.hash, updated_at: new Date().toISOString() })
      .eq('organization_id', orgId)

    if (upErr) return json({ error: 'No se pudo guardar el hash: ' + upErr.message }, 500)

    return json({
      ok: true,
      client_name: chosen.name,
      clients_total: clients.length,
      needs_choice: clients.length > 1,
    })
  }

  // ── hash de cliente, necesario para todo lo que no sea /clients ─────────
  // Guardar un token nuevo lo pone a NULL a propósito (puede ser de otra
  // cuenta), así que este corte es el caso normal tras cambiar el token, no
  // una rareza. Sin él, el proveedor respondería un error mucho menos claro.
  const { data: cfg } = await admin
    .from('traffic_providers').select('hash')
    .eq('organization_id', orgId).single()

  if (!cfg?.hash) {
    return json({
      error: action === 'sync'
        ? 'Valida la conexión antes de sincronizar'
        : 'Valida el token antes de listar los emplazamientos',
    }, 400)
  }
  const hash = cfg.hash as string

  // ── sync ────────────────────────────────────────────────────────────────
  if (action === 'sync') {
    const days = Math.min(MAX_DAYS, Math.max(1, Number(body.days) || DEFAULT_DAYS))
    const end = rdToday()
    const start = new Date(end.getTime() - (days - 1) * 86_400_000)
    // end_date es INCLUSIVO (comprobado contra la API: start=end devuelve ese
    // día), así que la ventana es [hoy-(n-1), hoy] y no hace falta sumar uno.
    const startParam = `${isoDay(start)}T00:00:00`
    const endParam   = `${isoDay(end)}T00:00:00`

    // Zonas mapeadas de ESTA organización, en dos consultas explícitas.
    //
    // Esta es la ÚNICA barrera entre organizaciones para esta ruta: `admin` es
    // el cliente de service_role, que salta la RLS, así que las políticas de
    // zones y traffic_counts no se evalúan aquí.
    //
    // Se resuelve con un IN sobre ids obtenidos a partir de orgId --y no
    // filtrando por un recurso embebido-- porque aquella forma dependía del
    // sufijo `!inner`: sin él, PostgREST devuelve TODAS las zonas con el
    // embebido en null en vez de filtrarlas. La consulta seguiría siendo
    // válida y el aislamiento se rompería en silencio, sin error. Una consulta
    // de más es un precio ridículo por que el fallo sea imposible.
    const { data: progs, error: pErr } = await admin
      .from('programs').select('id').eq('organization_id', orgId)

    if (pErr) return json({ error: 'No se pudieron leer los programas: ' + pErr.message }, 500)

    const programIds = (progs ?? []).map(p => p.id as string)
    if (programIds.length === 0) {
      return json({ ok: true, zones: 0, rows: 0, warnings: [], note: 'la organización no tiene programas' })
    }

    const { data: zoneRows, error: zErr } = await admin
      .from('zones')
      .select('id, name, traffic_panel_id')
      .in('program_id', programIds)
      .not('traffic_panel_id', 'is', null)

    if (zErr) return json({ error: 'No se pudieron leer las zonas: ' + zErr.message }, 500)

    const zones = (zoneRows ?? []) as { id: string; name: string; traffic_panel_id: number }[]
    if (zones.length === 0) {
      return json({ ok: true, zones: 0, rows: 0, warnings: [], note: 'ninguna zona tiene emplazamiento asignado' })
    }

    // DOS llamadas en total, no dos por zona: /all_panels devuelve un bloque
    // por panel con su propio panel_id, así que se piden una vez y se indexan.
    const qs = `?start_date=${startParam}&end_date=${endParam}&group_by=day&types=all`
    let counts: PanelBlock[]
    let impacts: PanelBlock[]
    try {
      const [c, i] = await Promise.all([
        callProvider(`/all_panels/processed_data${qs}`, token, hash),
        callProvider(`/all_panels/impact_processed_data${qs}`, token, hash),
      ])
      counts  = ((c as { panels?: PanelBlock[] })?.panels ?? [])
      impacts = ((i as { panels?: PanelBlock[] })?.panels ?? [])
    } catch (e) {
      return json({ error: (e as Error).message }, 502)
    }

    const countsBy  = new Map<number, PanelBlock>(counts.map(p => [p.panel_id, p]))
    const impactsBy = new Map<number, PanelBlock>(impacts.map(p => [p.panel_id, p]))

    const allDays = daysBetween(start, end)
    const rows: Record<string, unknown>[] = []
    const warnings: { zone: string; panel_id: number; reason: string }[] = []
    const nowIso = new Date().toISOString()

    for (const z of zones) {
      const panelId = z.traffic_panel_id
      const cBlock = countsBy.get(panelId)

      // Un panel mapeado que el proveedor no lista entre los activos: se avisa
      // y NO se escribe nada. Escribir ceros aquí sería inventar que el
      // emplazamiento midió cero, cuando en realidad no sabemos qué midió.
      if (!cBlock) {
        warnings.push({
          zone: z.name, panel_id: panelId,
          reason: 'El proveedor no lo incluye entre sus emplazamientos activos. No se escribió nada.',
        })
        continue
      }

      const byDayCounts  = pivotByDay(cBlock.data)
      const byDayImpacts = pivotByDay(impactsBy.get(panelId)?.data ?? null)

      // Se recorren TODOS los días de la ventana, no solo los que devolvió el
      // proveedor: un panel activo sin datos ese día se guarda como cero, que
      // es información real (no hubo tráfico medido) y evita huecos que luego
      // se confundan con "todavía no sincronizado".
      for (const day of allDays) {
        const c = byDayCounts[day] ?? {}
        const i = byDayImpacts[day] ?? {}
        rows.push({
          zone_id: z.id,
          date: day,
          pedestrians: c.pedestrians ?? 0,
          cars:        c.cars ?? 0,
          trucks:      c.trucks ?? 0,
          buses:       c.buses ?? 0,
          bikes:       c.bikes ?? 0,
          motorcycles: c.motorcycles ?? 0,
          total_count: c._total ?? 0,
          // Se guarda tal cual lo entrega el proveedor, sin recalcular: ese
          // factor lo firma él y es lo que hace la cifra defendible.
          total_impacts: i._total ?? 0,
          source_file: `datavisiooh:panel_${panelId}`,
          source_location: String(panelId),
          imported_at: nowIso,
          imported_by: user.id,
        })
      }
    }

    if (rows.length > 0) {
      // La API manda sobre lo importado a mano: un día que ya existiera por
      // Excel se sobrescribe, y source_file deja constancia de quién lo puso.
      const { error: upErr } = await admin
        .from('traffic_counts').upsert(rows, { onConflict: 'zone_id,date' })
      if (upErr) return json({ error: 'No se pudo guardar el conteo: ' + upErr.message, warnings }, 500)
    }

    return json({
      ok: true,
      zones: zones.length - warnings.length,
      rows: rows.length,
      from: isoDay(start),
      to: isoDay(end),
      warnings,
    })
  }

  // ── panels ──────────────────────────────────────────────────────────────

  let panels: Panel[]
  let sensors: SensorsRow[]
  try {
    // En paralelo: son independientes y así el selector abre antes.
    const [p, s] = await Promise.all([
      callProvider('/panels', token, hash),
      callProvider('/sensors_status', token, hash),
    ])
    panels = (p ?? []) as Panel[]
    sensors = (s ?? []) as SensorsRow[]
  } catch (e) {
    return json({ error: (e as Error).message }, 502)
  }

  const byPanel = new Map<number, SensorsRow>()
  for (const row of sensors) byPanel.set(row.panel_id, row)

  const list = panels.map(p => {
    const sensor = pickSensor(byPanel.get(p.id))
    return {
      id: p.id,
      name: p.name,
      description: p.description,
      address: p.address,
      // `status` se expone en crudo: el proveedor no documenta qué significan
      // sus valores (se ven 1 y 2), y etiquetarlos sería inventar.
      sensor_status: sensor.status,
      sensor_updated: sensor.updated,
      // Esto sí es nuestro y sí es accionable: un sensor que lleva días sin
      // reportar dará conteos en cero sin avisar.
      sensor_stale: sensor.updated
        ? (Date.now() - Date.parse(sensor.updated)) > 48 * 60 * 60 * 1000
        : true,
      looks_inactive: looksInactive(p),
    }
  })

  // Los sospechosos van al final, no se ocultan: la pista es una convención de
  // texto del proveedor, y si se equivoca, esconder el panel dejaría a alguien
  // sin entender por qué no aparece. El panel los atenúa; la decisión es suya.
  list.sort((a, b) => {
    if (a.looks_inactive !== b.looks_inactive) return a.looks_inactive ? 1 : -1
    return a.name.localeCompare(b.name)
  })

  return json({
    ok: true,
    panels: list,
    total: list.length,
    inactive: list.filter(p => p.looks_inactive).length,
  })
})
