// Edge Function: elimina un archivo de Cloudflare R2.
//
// Espejo de upload-to-r2: mismas credenciales (secrets del servidor, nunca en
// el frontend) y mismo patrón de autenticación.
//
// Seguridad multi-tenant ESTRUCTURAL: upload-to-r2 crea las claves como
// "{organization_id}/{kind}/{timestamp}_{archivo}", así que aquí solo se
// permite borrar claves cuyo prefijo sea el organization_id del usuario
// autenticado (resuelto desde profiles, sin confiar en el cliente). Un
// usuario no puede borrar archivos de otra empresa ni construyendo la URL
// a mano.
//
// Guard adicional: si alguna fila ACTIVA de media_content aún referencia la
// URL (p. ej. una copia de campaña), se rechaza con 409 para no romper
// reproducciones en curso.

import { AwsClient } from 'https://esm.sh/aws4fetch@1.0.20'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4'

const R2_ACCOUNT_ID = Deno.env.get('R2_ACCOUNT_ID') ?? ''
const R2_BUCKET_NAME = Deno.env.get('R2_BUCKET_NAME') ?? ''
const R2_PUBLIC_URL = (Deno.env.get('R2_PUBLIC_URL') ?? '').replace(/\/+$/, '')
const R2_ACCESS_KEY_ID = Deno.env.get('R2_ACCESS_KEY_ID') ?? ''
const R2_SECRET_ACCESS_KEY = Deno.env.get('R2_SECRET_ACCESS_KEY') ?? ''

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? ''

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
  const orgId = profile?.organization_id
  if (!orgId) return json({ error: 'El usuario no tiene organización' }, 403)

  // 3. Leer y validar la URL a borrar
  let body: { url?: unknown }
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Cuerpo inválido (se esperaba JSON)' }, 400)
  }
  const url = typeof body.url === 'string' ? body.url : ''
  if (!url.startsWith(R2_PUBLIC_URL + '/')) {
    return json({ error: 'La URL no pertenece al almacenamiento R2 de la plataforma' }, 400)
  }
  const key = url.slice(R2_PUBLIC_URL.length + 1)
  if (!key || key.includes('..')) return json({ error: 'Clave inválida' }, 400)

  // 4. Verificación multi-tenant: la clave debe pertenecer a la organización
  //    del usuario ({orgId}/video/... o {orgId}/image/...)
  if (!key.startsWith(`${orgId}/`)) {
    return json({ error: 'Este archivo no pertenece a tu organización' }, 403)
  }

  // 5. Guard de uso: ninguna fila ACTIVA puede seguir referenciando la URL.
  //    (Consulta bajo el RLS del usuario: solo ve filas de su organización.)
  const { count } = await supabase
    .from('media_content')
    .select('id', { count: 'exact', head: true })
    .eq('storage_path', url)
    .is('archived_at', null)
  if ((count ?? 0) > 0) {
    return json({ error: `El archivo aún está en uso por ${count} elemento(s) activo(s)` }, 409)
  }

  // 6. Borrar el objeto de R2 con firma S3 (SigV4)
  const aws = new AwsClient({
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
    service: 's3',
    region: 'auto',
  })
  const endpoint = `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${R2_BUCKET_NAME}/${key}`

  let res: Response
  try {
    res = await aws.fetch(endpoint, { method: 'DELETE' })
  } catch (e) {
    return json({ error: 'Error de red al borrar en R2: ' + (e as Error).message }, 502)
  }
  // 204 = borrado; 404 = ya no existía (tratamos como éxito idempotente)
  if (!res.ok && res.status !== 404) {
    const text = await res.text().catch(() => '')
    return json({ error: `R2 rechazó el borrado (${res.status}). ${text}`.trim() }, 502)
  }

  return json({ ok: true, key }, 200)
})
