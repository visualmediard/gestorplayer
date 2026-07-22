import { supabase } from './supabase'

export type StorageUsage = { usedBytes: number; limitBytes: number }

// Consumo de almacenamiento de la organización del usuario (RPC en el
// servidor, agrega por storage_path único respetando RLS). Devuelve null si no
// se pudo obtener.
export async function fetchStorageUsage(): Promise<StorageUsage | null> {
  const { data, error } = await supabase.rpc('org_storage_usage')
  if (error || !data || data.length === 0) return null
  const row = data[0] as { used_bytes: number | string; limit_mb: number }
  return {
    usedBytes: Number(row.used_bytes) || 0,
    limitBytes: (Number(row.limit_mb) || 2048) * 1024 * 1024,
  }
}

// Chequeo previo de UX antes de subir. La barrera real es la Edge Function;
// esto evita empezar una subida que se va a rechazar. Fail-open: si no se pudo
// leer el consumo, deja pasar (el servidor decidirá).
export async function checkStorageFits(fileSize: number): Promise<{ ok: boolean; message?: string }> {
  const usage = await fetchStorageUsage()
  if (!usage) return { ok: true }
  if (usage.usedBytes + fileSize <= usage.limitBytes) return { ok: true }
  const limitGb = (usage.limitBytes / (1024 ** 3)).toFixed(usage.limitBytes % (1024 ** 3) === 0 ? 0 : 1)
  return {
    ok: false,
    message:
      `Has alcanzado tu límite de almacenamiento (${limitGb} GB). ` +
      `Elimina videos que ya no estén corriendo en pantalla, o contacta a tu proveedor para ampliar tu espacio.`,
  }
}

// Aviso de "el almacenamiento cambió" (subida/borrado) para que el widget del
// sidebar se refresque sin polling.
const STORAGE_EVENT = 'gp:storage-changed'
export function notifyStorageChanged() {
  window.dispatchEvent(new Event(STORAGE_EVENT))
}
export function onStorageChanged(cb: () => void): () => void {
  window.addEventListener(STORAGE_EVENT, cb)
  return () => window.removeEventListener(STORAGE_EVENT, cb)
}

// "1.2 GB", "850 MB", etc.
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}
