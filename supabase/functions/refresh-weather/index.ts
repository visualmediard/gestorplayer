// Edge Function: refresca el clima de cada emplazamiento.
//
// Consulta Open-Meteo (gratis, sin API key) y cachea el resultado en
// weather_cache. La llama un programador externo --cron-- cada ~15 minutos;
// Open-Meteo actualiza por horas, así que ese ritmo va holgado.
//
// El PLAYER no llama a ninguna API externa: el clima le llega dentro de
// get_player_payload. Que el player dependiera de que un tercero responda
// sería reabrir por otro lado lo que cerramos al blindar las tablas, y además
// dejaría la reproducción a merced de la latencia de un servicio ajeno.
//
// Es idempotente: llamarla de más solo repite el upsert.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4'

const SUPABASE_URL     = Deno.env.get('SUPABASE_URL') ?? ''
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

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

type Screen = { id: string; name: string; latitude: number | null; longitude: number | null }

type Observation = { temperature_c: number | null; is_raining: boolean | null; observed_at: string | null }

// Una petición por UBICACIÓN, no por pantalla: varias pantallas en el mismo
// punto comparten clima y no tiene sentido preguntarlo dos veces.
//
// timezone=UTC a propósito: con timezone=auto, Open-Meteo devuelve la hora
// local SIN offset, que es ambigua al guardarla en un timestamptz. En UTC
// parsea sin lugar a dudas.
async function fetchWeather(lat: number, lon: number): Promise<Observation> {
  const url = 'https://api.open-meteo.com/v1/forecast'
    + `?latitude=${lat}&longitude=${lon}`
    + '&current=temperature_2m,precipitation,rain'
    + '&timezone=UTC'

  const res = await fetch(url)
  if (!res.ok) throw new Error(`Open-Meteo respondió ${res.status}`)
  const data = await res.json()
  const c = data?.current
  if (!c) throw new Error('respuesta sin bloque `current`')

  // "Lloviendo ahora": Open-Meteo da la precipitación de la hora en curso.
  // Se miran los dos campos porque `rain` excluye chubascos y nieve, y
  // `precipitation` los agrega todos.
  const rain = Number(c.rain ?? 0)
  const precip = Number(c.precipitation ?? 0)

  return {
    temperature_c: c.temperature_2m != null ? Number(c.temperature_2m) : null,
    is_raining: (isFinite(rain) && rain > 0) || (isFinite(precip) && precip > 0),
    observed_at: c.time ? new Date(c.time + 'Z').toISOString() : null,
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Método no permitido' }, 405)

  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    return json({ error: 'Función no configurada en el servidor' }, 500)
  }

  // Solo con la service_role: la escribe el cron, no un usuario. Si esto
  // quedara abierto, cualquiera podría falsear el clima de una pantalla y con
  // ello decidir qué creatividad ve el cliente final.
  const auth = req.headers.get('Authorization') ?? ''
  if (auth !== `Bearer ${SERVICE_ROLE_KEY}`) {
    return json({ error: 'No autorizado' }, 401)
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const { data: screens, error } = await admin
    .from('screens')
    .select('id, name, latitude, longitude')
    .not('latitude', 'is', null)
    .not('longitude', 'is', null)

  if (error) return json({ error: 'No se pudieron leer las pantallas: ' + error.message }, 500)

  const list = (screens ?? []) as Screen[]
  if (list.length === 0) {
    return json({ ok: true, screens: 0, note: 'ninguna pantalla tiene coordenadas' })
  }

  // Agrupar por ubicación redondeada (~100 m): pantallas del mismo rótulo o de
  // la misma esquina comparten una sola petición.
  const groups = new Map<string, { lat: number; lon: number; ids: string[] }>()
  for (const s of list) {
    const lat = Number(s.latitude), lon = Number(s.longitude)
    const key = `${lat.toFixed(3)},${lon.toFixed(3)}`
    const g = groups.get(key)
    if (g) g.ids.push(s.id)
    else groups.set(key, { lat, lon, ids: [s.id] })
  }

  const now = new Date().toISOString()
  const rows: Record<string, unknown>[] = []
  const failures: { location: string; error: string }[] = []

  for (const [key, g] of groups) {
    try {
      const obs = await fetchWeather(g.lat, g.lon)
      for (const id of g.ids) {
        rows.push({
          screen_id: id,
          temperature_c: obs.temperature_c,
          is_raining: obs.is_raining,
          observed_at: obs.observed_at,
          fetched_at: now,
        })
      }
    } catch (e) {
      // Una ubicación que falla no debe tumbar el refresco de las demás. La
      // fila anterior se conserva y envejecerá hasta quedar 'stale', que es
      // justo lo que dispara el fail-safe en el player.
      failures.push({ location: key, error: (e as Error).message })
    }
  }

  if (rows.length > 0) {
    const { error: upErr } = await admin
      .from('weather_cache').upsert(rows, { onConflict: 'screen_id' })
    if (upErr) return json({ error: 'No se pudo guardar el clima: ' + upErr.message, failures }, 500)
  }

  return json({
    ok: true,
    locations: groups.size,
    screens: rows.length,
    failures,
  })
})
