// Edge Function: genera una URL PUT prefirmada para subir DIRECTO a Cloudflare
// R2 desde el navegador, sin pasar el archivo por la función (evita el límite
// de body y el doble ancho de banda del passthrough).
//
// Flujo: el frontend manda { fileName, contentType, size, folder? }; aquí se
// valida la sesión, se resuelve el organization_id (no se confía en el
// cliente), se chequea el cupo de almacenamiento de la org con el `size`
// declarado, y se devuelve { uploadUrl, publicUrl, key }. El navegador hace
// PUT del archivo a `uploadUrl` y luego guarda `publicUrl` en storage_path.
//
// Requiere CORS en el bucket R2 (PUT desde el origen de la app).

import { AwsClient } from 'https://esm.sh/aws4fetch@1.0.20'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4'

const R2_ACCOUNT_ID = Deno.env.get('R2_ACCOUNT_ID') ?? ''
const R2_BUCKET_NAME = Deno.env.get('R2_BUCKET_NAME') ?? ''
const R2_PUBLIC_URL = (Deno.env.get('R2_PUBLIC_URL') ?? '').replace(/\/+$/, '')
const R2_ACCESS_KEY_ID = Deno.env.get('R2_ACCESS_KEY_ID') ?? ''
const R2_SECRET_ACCESS_KEY = Deno.env.get('R2_SECRET_ACCESS_KEY') ?? ''

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? ''

const URL_EXPIRY_SECONDS = 3600 // la URL firmada vale 1 hora (subidas grandes)

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Método no permitido' }, 405)

  if (!R2_ACCOUNT_ID || !R2_BUCKET_NAME || !R2_PUBLIC_URL || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
    return json({ error: 'R2 no está configurado en el servidor' }, 500)
  }

  // 1. Autenticar al usuario con su JWT
  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return json({ error: 'No autorizado' }, 401)

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  })
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) return json({ error: 'Sesión inválida' }, 401)

  // 2. Resolver organization_id del usuario (no se confía en el cliente)
  const { data: profile } = await supabase
    .from('profiles').select('organization_id').eq('id', user.id).single()
  const orgFolder = profile?.organization_id || 'shared'

  // 3. Leer los datos del archivo (el archivo NO viaja aquí, solo su metadata)
  let body: { fileName?: string; contentType?: string; size?: number; folder?: string }
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Cuerpo inválido (se esperaba JSON)' }, 400)
  }
  const size = Number(body.size) || 0
  if (!body.fileName || size <= 0) return json({ error: 'Faltan datos del archivo' }, 400)

  // 3.5 Barrera de almacenamiento (no saltable desde el frontend): el archivo
  // debe caber en el espacio disponible de la organización. Fail-open ante
  // errores transitorios del RPC. Nota: con subidas simultáneas el chequeo es
  // por-archivo; el cliente además pre-valida el lote completo antes de arrancar.
  try {
    const { data: usage, error: usageErr } = await supabase.rpc('org_storage_usage')
    if (!usageErr && usage && usage.length > 0) {
      const used  = Number(usage[0].used_bytes) || 0
      const limit = (Number(usage[0].limit_mb) || 2048) * 1024 * 1024
      if (used + size > limit) {
        const limitGb = (limit / (1024 * 1024 * 1024)).toFixed(limit % (1024 ** 3) === 0 ? 0 : 1)
        return json({
          error: `Has alcanzado tu límite de almacenamiento (${limitGb} GB). ` +
                 `Elimina videos que ya no estén corriendo en pantalla, o contacta a tu proveedor para ampliar tu espacio.`,
          code: 'STORAGE_LIMIT',
        }, 413)
      }
    }
  } catch (_e) { /* fail-open */ }

  // 4. Construir la key en R2 (misma convención que upload-to-r2)
  const isVideo = (body.contentType || '').startsWith('video/')
  const kind = isVideo ? 'video' : 'image'
  const safeName = (body.fileName || 'archivo').replace(/[^\w.\-]+/g, '_')
  const folderRaw = typeof body.folder === 'string' ? body.folder.replace(/[^\w\-]+/g, '_').replace(/^_+|_+$/g, '') : ''
  const subfolder = folderRaw || kind
  const key = `${orgFolder}/${subfolder}/${Date.now()}_${safeName}`

  // 5. Firmar una URL PUT (solo se firma host → el cliente puede mandar el
  //    Content-Type libremente sin romper la firma). Vale 1 hora.
  const aws = new AwsClient({
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
    service: 's3',
    region: 'auto',
  })
  const endpoint = new URL(`https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${R2_BUCKET_NAME}/${key}`)
  endpoint.searchParams.set('X-Amz-Expires', String(URL_EXPIRY_SECONDS))

  let signed: Request
  try {
    signed = await aws.sign(endpoint.toString(), { method: 'PUT', aws: { signQuery: true } })
  } catch (e) {
    return json({ error: 'No se pudo firmar la subida: ' + (e as Error).message }, 502)
  }

  return json({
    uploadUrl: signed.url,
    publicUrl: `${R2_PUBLIC_URL}/${key}`,
    key,
  }, 200)
})
