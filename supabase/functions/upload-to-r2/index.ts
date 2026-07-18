// Edge Function: sube un archivo (video/imagen) a Cloudflare R2.
//
// Las credenciales de R2 viven SOLO como secrets del servidor (Deno.env) y
// nunca se exponen al frontend. El frontend manda el archivo por multipart
// junto con el JWT del usuario; aquí se valida la sesión, se resuelve el
// organization_id del usuario desde la tabla profiles (no se confía en el
// cliente) y se sube a R2 firmando la petición S3 con aws4fetch.
//
// Respuesta: { url } — la URL pública de R2 que el frontend guarda en
// media_content.storage_path.

import { AwsClient } from 'https://esm.sh/aws4fetch@1.0.20'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4'

const R2_ACCOUNT_ID = Deno.env.get('R2_ACCOUNT_ID') ?? ''
const R2_BUCKET_NAME = Deno.env.get('R2_BUCKET_NAME') ?? ''
const R2_PUBLIC_URL = (Deno.env.get('R2_PUBLIC_URL') ?? '').replace(/\/+$/, '')
const R2_ACCESS_KEY_ID = Deno.env.get('R2_ACCESS_KEY_ID') ?? ''
const R2_SECRET_ACCESS_KEY = Deno.env.get('R2_SECRET_ACCESS_KEY') ?? ''

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? ''

const MAX_BYTES = 10 * 1024 * 1024 // 10 MB, igual que el límite del frontend

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

  // 3. Leer el archivo del multipart
  let form: FormData
  try {
    form = await req.formData()
  } catch {
    return json({ error: 'Cuerpo inválido (se esperaba multipart/form-data)' }, 400)
  }
  const file = form.get('file')
  if (!(file instanceof File)) return json({ error: 'Falta el archivo' }, 400)
  if (file.size > MAX_BYTES) {
    const mb = (file.size / (1024 * 1024)).toFixed(1)
    return json({ error: `El archivo pesa ${mb} MB. El máximo permitido es 10 MB.` }, 413)
  }

  const isVideo = (file.type || '').startsWith('video/')
  const kind = isVideo ? 'video' : 'image'
  const safeName = (file.name || 'archivo').replace(/[^\w.\-]+/g, '_')
  const key = `${orgFolder}/${kind}/${Date.now()}_${safeName}`

  // 4. Subir a R2 con firma S3 (SigV4)
  const aws = new AwsClient({
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
    service: 's3',
    region: 'auto',
  })
  const endpoint = `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${R2_BUCKET_NAME}/${key}`

  let put: Response
  try {
    put = await aws.fetch(endpoint, {
      method: 'PUT',
      body: await file.arrayBuffer(),
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
    })
  } catch (e) {
    return json({ error: 'Error de red al subir a R2: ' + (e as Error).message }, 502)
  }
  if (!put.ok) {
    const text = await put.text().catch(() => '')
    return json({ error: `R2 rechazó la subida (${put.status}). ${text}`.trim() }, 502)
  }

  // 5. Devolver la URL pública
  const url = `${R2_PUBLIC_URL}/${key}`
  return json({ url, key }, 200)
})
