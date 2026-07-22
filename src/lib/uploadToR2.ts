import { supabase } from './supabase'

const FUNCTIONS_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/upload-to-r2`
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY

/**
 * Sube un archivo a Cloudflare R2 a través de la Edge Function `upload-to-r2`.
 * Las credenciales de R2 viven en el servidor; aquí solo mandamos el archivo
 * con el JWT del usuario. Reporta progreso real vía XMLHttpRequest.
 *
 * Devuelve { url } con la URL pública de R2 (que se guarda en storage_path),
 * o { error } si algo falla.
 */
export async function uploadToR2(
  file: File,
  onProgress?: (percent: number) => void,
): Promise<{ url: string | null; size: number | null; error: { message: string } | null }> {
  const { data: sessionData } = await supabase.auth.getSession()
  const token = sessionData.session?.access_token
  if (!token) return { url: null, size: null, error: { message: 'No hay sesión activa' } }

  const form = new FormData()
  form.append('file', file)

  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', FUNCTIONS_URL, true)
    xhr.setRequestHeader('Authorization', `Bearer ${token}`)
    xhr.setRequestHeader('apikey', SUPABASE_ANON_KEY)
    // No fijamos Content-Type: el navegador pone el boundary del multipart.

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) {
        onProgress(Math.round((e.loaded / e.total) * 100))
      }
    }
    xhr.onload = () => {
      let body: any = null
      try { body = JSON.parse(xhr.responseText) } catch { /* ignore */ }
      if (xhr.status >= 200 && xhr.status < 300 && body?.url) {
        onProgress?.(100)
        // El servidor devuelve `size`; si faltara, el llamador usa file.size.
        resolve({ url: body.url as string, size: typeof body.size === 'number' ? body.size : file.size, error: null })
      } else {
        const message = body?.error || `Error ${xhr.status} al subir`
        resolve({ url: null, size: null, error: { message } })
      }
    }
    xhr.onerror = () => resolve({ url: null, size: null, error: { message: 'Error de red al subir el archivo' } })
    xhr.send(form)
  })
}
