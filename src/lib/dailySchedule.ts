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
