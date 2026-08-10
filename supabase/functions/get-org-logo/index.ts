// Edge Function: devuelve el logo de la organización del usuario como data URL
// (base64). Necesaria porque el dominio público de R2 (pub-*.r2.dev) no envía
// headers CORS, así que el navegador no puede leer los bytes del logo para
// incrustarlo en el PDF. Aquí se descarga en el servidor (sin CORS) y se
// devuelve en base64. La organización se resuelve desde el JWT (no del cliente).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const R2_PUBLIC_URL = (Deno.env.get('R2_PUBLIC_URL') ?? '').replace(/\/+$/, '')

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
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SERVICE_ROLE_KEY) {
    return json({ error: 'Función no configurada en el servidor' }, 500)
  }

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return json({ error: 'No autorizado' }, 401)

  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  })
  const { data: { user }, error: authErr } = await userClient.auth.getUser()
  if (authErr || !user) return json({ error: 'Sesión inválida' }, 401)

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  // Organización del usuario → logo_url.
  const { data: prof } = await admin
    .from('profiles').select('organization_id').eq('id', user.id).single()
  if (!prof?.organization_id) return json({ dataUrl: null })

  const { data: org } = await admin
    .from('organizations').select('logo_url').eq('id', prof.organization_id).single()
  const logoUrl = org?.logo_url
  if (!logoUrl) return json({ dataUrl: null })

  // Control principal contra SSRF: logo_url es una columna que el cliente pudo
  // escribir, y aquí se hace fetch() DESDE EL SERVIDOR devolviendo el cuerpo al
  // que llama. Sin esta comprobación, cualquier admin podía apuntar al metadata
  // del proveedor o a un servicio interno y leer la respuesta en base64.
  // Mismo patrón que delete-from-r2, que ya validaba el prefijo.
  if (!R2_PUBLIC_URL || !logoUrl.startsWith(R2_PUBLIC_URL + '/')) {
    return json({ dataUrl: null })
  }

  // Descarga del logo en el servidor (sin restricción CORS del navegador).
  let res: Response
  try {
    res = await fetch(logoUrl)
  } catch (e) {
    return json({ error: 'No se pudo descargar el logo: ' + (e as Error).message }, 502)
  }
  if (!res.ok) return json({ error: `El logo no está disponible (${res.status})` }, 502)

  const contentType = res.headers.get('content-type') || 'image/png'
  const bytes = new Uint8Array(await res.arrayBuffer())

  // base64 por bloques para no desbordar la pila con imágenes grandes.
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  const b64 = btoa(binary)

  return json({ dataUrl: `data:${contentType};base64,${b64}` })
})
