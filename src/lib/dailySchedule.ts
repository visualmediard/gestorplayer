// ¿Un contenido/campaña está EN REPOSO ahora mismo por su horario diario?
//
// Indicador visual del dashboard. Replica exactamente la lógica que el
// reproductor usa en isWithinSchedule (player/index.html), incluido el cruce
// de medianoche, para que dashboard y player coincidan.
//
// - Sin horario (start o end nulos) → nunca está en reposo (sale siempre).
// - Rango normal (start <= end, ej. 06:00–22:00): reposo si la hora está
//   fuera de [start, end).
// - Rango que cruza medianoche (start > end, ej. 22:00–06:00): reposo si la
//   hora está en el hueco [end, start).

function toMinutes(t: string | null | undefined): number | null {
  if (!t) return null
  const [h, m] = String(t).slice(0, 5).split(':').map(Number)
  if (Number.isNaN(h) || Number.isNaN(m)) return null
  return h * 60 + m
}

export function isResting(
  start: string | null | undefined,
  end: string | null | undefined,
  now: Date = new Date(),
): boolean {
  const s = toMinutes(start)
  const e = toMinutes(end)
  if (s === null || e === null) return false   // sin restricción → siempre activo
  if (s === e) return false                     // ventana de 24h

  const mins = now.getHours() * 60 + now.getMinutes()
  const within = s < e
    ? (mins >= s && mins < e)                   // mismo día
    : (mins >= s || mins < e)                   // cruza medianoche
  return !within
}

// Etiqueta corta del rango, para tooltips: "06:00–22:00".
export function scheduleRangeLabel(
  start: string | null | undefined,
  end: string | null | undefined,
): string {
  if (!start || !end) return ''
  return `${String(start).slice(0, 5)}–${String(end).slice(0, 5)}`
}

// Estado de una campaña por su RANGO DE FECHAS (no por el horario diario):
//   'scheduled' → aún no empieza (hoy < starts_at)
//   'finished'  → ya terminó (hoy > ends_at)
//   'live'      → está dentro del rango [starts_at, ends_at]
//
// Compara solo la FECHA local (no la hora), parseando "YYYY-MM-DD" como fecha
// local igual que isExpired en ZoneEditor y que el player, para no adelantar ni
// atrasar un día en zonas detrás de UTC. Es un cálculo visual del dashboard.
function localDay(dateStr: string | null | undefined): { start: Date; end: Date } | null {
  if (!dateStr) return null
  const [y, mo, d] = String(dateStr).slice(0, 10).split('-').map(Number)
  if (!y || !mo || !d) return null
  return {
    start: new Date(y, mo - 1, d, 0, 0, 0, 0),
    end: new Date(y, mo - 1, d, 23, 59, 59, 999),
  }
}

export function campaignDateState(
  startsAt: string | null | undefined,
  endsAt: string | null | undefined,
  now: Date = new Date(),
): 'scheduled' | 'finished' | 'live' {
  const start = localDay(startsAt)
  const end = localDay(endsAt)
  if (start && now < start.start) return 'scheduled'
  if (end && now > end.end) return 'finished'
  return 'live'
}
