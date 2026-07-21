// Deduplica la biblioteca de medios para mostrar cada archivo UNA sola vez.
//
// Un mismo archivo puede tener varias filas en media_content (una por cada
// colocación en zona, o por re-subidas), y cada una suele apuntar a una URL
// distinta en R2. Por eso NO se puede deduplicar por storage_path. Se agrupa
// por nombre+tipo, que es lo que el usuario percibe como "el mismo archivo".
//
// Se prefiere como representante la fila "maestra" de biblioteca (zone_id null)
// cuando existe, para que su edición/borrado afecte al archivo base.

export type DedupableMedia = {
  id: string
  name: string
  type: string
  zone_id?: string | null
}

export function dedupeMedia<T extends DedupableMedia>(rows: T[]): T[] {
  const byKey = new Map<string, T>()
  for (const row of rows) {
    const key = row.type === 'url'
      ? `url:${row.id}`
      : `name:${row.type}:${row.name.trim().toLowerCase()}`
    const existing = byKey.get(key)
    if (!existing) { byKey.set(key, row); continue }
    // Prefiere la fila de biblioteca (sin zona) como representante.
    if (!row.zone_id && existing.zone_id) byKey.set(key, row)
  }
  return Array.from(byKey.values())
}
