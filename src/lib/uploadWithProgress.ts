import { supabase } from './supabase'

export async function uploadWithProgress(
  path: string,
  file: File,
  onProgress: (pct: number) => void,
): Promise<{ error: { message: string } | null }> {
  const { data: { session } } = await supabase.auth.getSession()
  const token = session?.access_token
  if (!token) return { error: { message: 'Sesión no válida' } }

  const baseUrl = import.meta.env.VITE_SUPABASE_URL
  const apiKey = import.meta.env.VITE_SUPABASE_ANON_KEY
  const url = `${baseUrl}/storage/v1/object/media/${path}`

  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest()
    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) {
        onProgress(Math.round((event.loaded / event.total) * 100))
      }
    })
    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve({ error: null })
      else {
        let message = 'Error subiendo archivo'
        try {
          const body = JSON.parse(xhr.responseText)
          message = body.message ?? body.error ?? message
        } catch { /* keep default */ }
        resolve({ error: { message } })
      }
    })
    xhr.addEventListener('error', () => resolve({ error: { message: 'Error de red al subir archivo' } }))

    xhr.open('POST', url)
    xhr.setRequestHeader('Authorization', `Bearer ${token}`)
    xhr.setRequestHeader('apikey', apiKey)
    xhr.setRequestHeader('x-upsert', 'false')

    const formData = new FormData()
    formData.append('cacheControl', '3600')
    formData.append('', file)
    xhr.send(formData)
  })
}
