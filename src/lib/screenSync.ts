// Estado de sincronización de una pantalla respecto a la última publicación.
//
// Verde significa "el dispositivo recibió y aplicó esta publicación", NO "se
// está reproduciendo bien": un video corrupto daría verde igual. La telemetría
// de reproducción real es otra pieza.

// Una pantalla está "en línea" si su player latió hace menos de 2 minutos.
// El umbral vive aquí para que el semáforo, el estado "Activa" de Pantallas y
// el contador del dashboard no puedan desfasarse entre sí.
export const ONLINE_THRESHOLD_MIN = 2

export function isHeartbeatFresh(lastHeartbeat: string | null): boolean {
  if (!lastHeartbeat) return false
  return (Date.now() - new Date(lastHeartbeat).getTime()) / 60000 < ONLINE_THRESHOLD_MIN
}

export type SyncState = 'synced' | 'syncing' | 'waiting' | 'unknown'

export type ScreenSync = {
  id: string
  name: string
  last_heartbeat: string | null
  synced_published_at: string | null
}

// El orden de las comprobaciones es la regla, no una casualidad: NULL se
// evalúa PRIMERO, antes de comparar fechas. Una pantalla cuyo player todavía no
// reporta el acuse (app antigua, o aún sin latir tras actualizarse) no está
// desincronizada — es que no sabemos qué versión tiene. Pintarla de ámbar sería
// una alarma falsa, y durante la transición el gris será el estado normal.
export function syncState(sc: ScreenSync, publishedAt: string | null): SyncState {
  if (!sc.synced_published_at) return 'unknown'
  if (!publishedAt) return 'synced'          // nunca se publicó: nada que esperar
  if (new Date(sc.synced_published_at).getTime() >= new Date(publishedAt).getTime()) {
    return 'synced'
  }
  // Aún no la tiene, pero está viva: le toca en el próximo poll (≤15 s). Sin
  // este estado, una pantalla perfectamente conectada se vería en ámbar de
  // "esperando conexión" durante los primeros segundos, que sería mentira.
  return isHeartbeatFresh(sc.last_heartbeat) ? 'syncing' : 'waiting'
}

export const SYNC_UI: Record<SyncState, { dot: string; fg: string; bg: string; border: string; label: string }> = {
  synced:  { dot: '#10B981', fg: '#047857', bg: '#ECFDF5', border: '#A7F3D0', label: 'Sincronizada' },
  syncing: { dot: '#3B82F6', fg: '#1D4ED8', bg: '#EFF6FF', border: '#BFDBFE', label: 'Sincronizando…' },
  waiting: { dot: '#F59E0B', fg: '#B45309', bg: '#FFFBEB', border: '#FDE68A', label: 'Esperando conexión' },
  unknown: { dot: '#CBD5E1', fg: '#64748B', bg: '#F8FAFC', border: '#E2E8F0', label: 'Estado desconocido' },
}

// Lo que necesita atención va primero: ámbar, gris, azul, verde.
const ORDER: Record<SyncState, number> = { waiting: 0, unknown: 1, syncing: 2, synced: 3 }

export function sortByAttention(a: SyncState, b: SyncState): number {
  return ORDER[a] - ORDER[b]
}
