import { supabase } from './supabase'

// Un storage_path puede ser una ruta de Supabase Storage (archivos antiguos,
// p. ej. "library/123.mp4") O una URL pública completa de Cloudflare R2
// (archivos nuevos, p. ej. "https://pub-xxx.r2.dev/org/video/123_x.mp4").
//
// Detectamos la forma de URL y la devolvemos tal cual; en caso contrario la
// resolvemos a través de Supabase. Así los archivos ya subidos siguen
// funcionando sin migrar.
export function resolveMediaUrl(path: string | null | undefined): string {
  if (!path) return ''
  if (/^https?:\/\//i.test(path)) return path
  return supabase.storage.from('media').getPublicUrl(path).data.publicUrl
}

// True si el storage_path es una URL remota (R2 u otra), no una ruta de Supabase.
export function isRemoteUrl(path: string | null | undefined): boolean {
  return !!path && /^https?:\/\//i.test(path)
}
