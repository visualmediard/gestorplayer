import { supabase } from './supabase'

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY

/**
 * Uploads a file to Supabase Storage using XMLHttpRequest so the real upload
 * progress can be reported. The supabase-js client uses fetch under the hood,
 * which does NOT emit upload progress events, so its `onUploadProgress` option
 * never fires and the bar stays at 0% until completion.
 *
 * Returns an object shaped like the supabase-js result ({ error }) so callers
 * can swap it in with minimal changes.
 */
export async function uploadWithProgress(
  bucket: string,
  path: string,
  file: File,
  onProgress?: (percent: number) => void,
  opts?: { upsert?: boolean },
): Promise<{ error: { message: string } | null }> {
  const { data: sessionData } = await supabase.auth.getSession()
  const token = sessionData.session?.access_token ?? SUPABASE_ANON_KEY
  const encodedPath = path.split('/').map(encodeURIComponent).join('/')
  const url = `${SUPABASE_URL}/storage/v1/object/${bucket}/${encodedPath}`

  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', url, true)
    xhr.setRequestHeader('Authorization', `Bearer ${token}`)
    xhr.setRequestHeader('apikey', SUPABASE_ANON_KEY)
    xhr.setRequestHeader('x-upsert', opts?.upsert ? 'true' : 'false')
    if (file.type) xhr.setRequestHeader('Content-Type', file.type)

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) {
        onProgress(Math.round((e.loaded / e.total) * 100))
      }
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.(100)
        resolve({ error: null })
      } else {
        let message = `Error ${xhr.status} al subir`
        try {
          const j = JSON.parse(xhr.responseText)
          message = j.message || j.error || message
        } catch { /* keep default */ }
        resolve({ error: { message } })
      }
    }
    xhr.onerror = () => resolve({ error: { message: 'Error de red al subir el archivo' } })
    xhr.send(file)
  })
}
