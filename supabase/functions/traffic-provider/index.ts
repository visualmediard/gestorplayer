// Edge Function: conector con DataVisiooh (conteo vehicular).
//
// Acciones:
//   - validate: comprueba el token guardado contra /clients y persiste el hash
//               de cliente. Devuelve el nombre para que el admin confirme de
//               un vistazo que pegó el token correcto.
//   - panels:   lista los emplazamientos del cliente, cruzados con el estado
//               de sus sensores, para mapearlos a las zonas de GestPlayer.
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

  let body: { action?: string }
  try { body = await req.json() } catch { return json({ error: 'Cuerpo inválido' }, 400) }

  const action = body.action
  if (action !== 'validate' && action !== 'panels') {
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

  // ── panels ──────────────────────────────────────────────────────────────
  const { data: cfg } = await admin
    .from('traffic_providers').select('hash')
    .eq('organization_id', orgId).single()

  if (!cfg?.hash) {
    return json({ error: 'Valida el token antes de listar los emplazamientos' }, 400)
  }
  const hash = cfg.hash as string

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
