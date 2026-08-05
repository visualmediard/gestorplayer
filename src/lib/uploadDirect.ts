import { supabase } from './supabase'

/**
 * Sube un archivo DIRECTO a Cloudflare R2 con una URL PUT prefirmada que emite
 * la Edge Function `sign-r2-upload`. El archivo NO pasa por la Edge Function
 * (sin límite de body ni doble ancho de banda), y el progreso es real vía XHR.
 *
 * Devuelve { url } con la URL pública de R2 (para storage_path), o { error }.
 * Misma firma que uploadToR2, así que es intercambiable.
 */
export async function uploadDirect(
  file: File,
  onProgress?: (percent: number) => void,
  folder?: string,
): Promise<{ url: string | null; size: number | null; error: { message: string } | null }> {
  // 1. Pedir la URL firmada (aquí se valida sesión + org + cupo).
  const { data, error } = await supabase.functions.invoke('sign-r2-upload', {
    body: { fileName: file.name, contentType: file.type, size: file.size, folder: folder ?? null },
  })
  if (error) {
    let msg = error.message
    try { const j = await (error as any).context?.json(); if (j?.error) msg = j.error } catch { /* ignore */ }
    return { url: null, size: null, error: { message: msg } }
  }
  const uploadUrl = (data as any)?.uploadUrl
  const publicUrl = (data as any)?.publicUrl
  if (!uploadUrl || !publicUrl) return { url: null, size: null, error: { message: 'Respuesta de firma inválida' } }

  // 2. PUT directo a R2 con progreso real.
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', uploadUrl, true)
    if (file.type) xhr.setRequestHeader('Content-Type', file.type)
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100))
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.(100)
        resolve({ url: publicUrl as string, size: file.size, error: null })
      } else {
        resolve({ url: null, size: null, error: { message: `R2 rechazó la subida (${xhr.status})` } })
      }
    }
    xhr.onerror = () => resolve({ url: null, size: null, error: { message: 'Error de red al subir a R2' } })
    xhr.send(file)
  })
}
