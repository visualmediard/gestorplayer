import { supabase } from './supabase'
import { isRemoteUrl } from './mediaUrl'

const FUNCTIONS_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/delete-from-r2`
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY

/**
 * Elimina el archivo FÍSICO de un storage_path, solo si ya ninguna fila
 * ACTIVA de media_content lo referencia (protege copias de campañas y otras
 * colocaciones que compartan el mismo archivo).
 *
 * - URL de R2 → Edge Function `delete-from-r2` (las credenciales de R2 viven
 *   solo en el servidor; aquí únicamente viaja el JWT del usuario).
 * - Ruta legacy de Supabase Storage → storage.remove, como siempre.
 *
 * Best-effort: nunca lanza. Si el borrado físico falla (red, función no
 * desplegada, etc.), el archivo queda huérfano —aceptable— y el flujo de la
 * UI continúa sin bloquearse.
 */
export async function deleteMediaFileIfUnused(storagePath: string | null | undefined): Promise<void> {
  if (!storagePath) return
  try {
    const { count } = await supabase
      .from('media_content')
      .select('id', { count: 'exact', head: true })
      .eq('storage_path', storagePath)
      .is('archived_at', null)
    if ((count ?? 0) > 0) return   // aún en uso → no tocar el archivo

    if (isRemoteUrl(storagePath)) {
      const { data: s } = await supabase.auth.getSession()
      const token = s.session?.access_token
      if (!token) return
      await fetch(FUNCTIONS_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          apikey: SUPABASE_ANON_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ url: storagePath }),
      })
    } else {
      await supabase.storage.from('media').remove([storagePath])
    }
  } catch { /* best-effort: no bloquear la UI por un huérfano */ }
}
