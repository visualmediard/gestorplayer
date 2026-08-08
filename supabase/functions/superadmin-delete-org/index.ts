// Edge Function: eliminación definitiva de una organización.
//
// Orquesta lo que el SQL no puede tocar (R2 y auth.users) alrededor de la RPC
// superadmin_delete_org, que hace el borrado atómico de la base de datos.
//
// ORDEN DELIBERADO: respaldo → R2 → base de datos → auth. Si la base de datos
// se borrara primero, un fallo posterior dejaría la organización fuera del
// panel y sus archivos huérfanos en R2 para siempre, sin UI desde donde
// reintentar. Con este orden, un fallo temprano aborta sin destruir nada, y un
// fallo en la RPC deja la organización todavía listada y el borrado
// reintentable.
//
// Las cuatro protecciones se revalidan aquí ANTES de tocar R2, aunque la RPC
// las repita: para cuando la RPC hablara, los archivos ya estarían borrados.

import { AwsClient } from 'https://esm.sh/aws4fetch@1.0.20'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4'

const R2_ACCOUNT_ID        = Deno.env.get('R2_ACCOUNT_ID') ?? ''
const R2_BUCKET_NAME       = Deno.env.get('R2_BUCKET_NAME') ?? ''
const R2_ACCESS_KEY_ID     = Deno.env.get('R2_ACCESS_KEY_ID') ?? ''
const R2_SECRET_ACCESS_KEY = Deno.env.get('R2_SECRET_ACCESS_KEY') ?? ''

const SUPABASE_URL      = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
const SERVICE_ROLE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

// Tope defensivo: por encima de esto el borrado no cabe con holgura en el
// límite de tiempo de la función y se cortaría a medias, dejando R2 a medio
// vaciar. Mejor abortar antes de tocar nada y pedir limpieza manual.
const MAX_R2_OBJECTS = 5000

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { ...cors, 'Content-Type': 'application/json' },
  })
}

// Lista todas las claves bajo un prefijo. ListObjectsV2 pagina de 1000 en 1000.
// Se parsea el XML con regex y no con DOMParser porque el runtime de Deno no
// trae DOMParser; la respuesta de S3 es plana y predecible.
async function listAllKeys(aws: AwsClient, prefix: string): Promise<string[]> {
  const keys: string[] = []
  let token: string | null = null

  do {
    const u = new URL(`https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${R2_BUCKET_NAME}`)
    u.searchParams.set('list-type', '2')
    u.searchParams.set('prefix', prefix)
    if (token) u.searchParams.set('continuation-token', token)

    const res = await aws.fetch(u.toString(), { method: 'GET' })
    if (!res.ok) throw new Error(`R2 rechazó el listado (${res.status})`)
    const xml = await res.text()

    for (const m of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) {
      keys.push(m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'))
    }

    // Cortocircuito: si ya se pasó del tope, no tiene sentido seguir paginando.
    if (keys.length > MAX_R2_OBJECTS) return keys

    const next = xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/)
    token = xml.includes('<IsTruncated>true</IsTruncated>') && next ? next[1] : null
  } while (token)

  return keys
}

// Borra una por una, de 20 en 20. DeleteObjects (el borrado en lote) exige
// cabecera Content-MD5, que obligaría a calcular MD5 del cuerpo XML; con la
// concurrencia el ahorro no compensa la complejidad para el volumen esperado.
async function deleteKeys(aws: AwsClient, keys: string[]): Promise<number> {
  const base = `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${R2_BUCKET_NAME}`
  let done = 0

  for (let i = 0; i < keys.length; i += 20) {
    const chunk = keys.slice(i, i + 20)
    const results = await Promise.all(chunk.map(async (k) => {
      const res = await aws.fetch(`${base}/${k.split('/').map(encodeURIComponent).join('/')}`,
                                  { method: 'DELETE' })
      return res.ok || res.status === 404   // 404 = ya no estaba: éxito idempotente
    }))
    const failed = results.filter(r => !r).length
    if (failed > 0) throw new Error(`R2 rechazó el borrado de ${failed} objeto(s)`)
    done += chunk.length
  }
  return done
}

// Volcado de lo que había en la organización. La tabla de auditoría registra
// QUE pasó; esto guarda QUÉ había. Se genera antes de tocar nada: si falla, se
// aborta sin haber destruido ni un archivo.
async function buildBackup(admin: ReturnType<typeof createClient>, orgId: string, org: unknown) {
  const [screens, programs, campaigns, users, media] = await Promise.all([
    admin.from('screens').select('*').eq('organization_id', orgId),
    admin.from('programs').select('*').eq('organization_id', orgId),
    admin.from('campaigns').select('*').eq('organization_id', orgId),
    // De profiles solo lo justo: el respaldo no necesita más datos personales.
    admin.from('profiles').select('id, email, full_name, role, created_at')
         .eq('organization_id', orgId),
    // Inventario de archivos, no metadata: deja constancia de QUÉ había en R2
    // cuando ya no se pueda recuperar.
    admin.from('media_content')
         .select('id, name, storage_path, type, file_size_bytes')
         .eq('organization_id', orgId),
  ])

  const firstError = [screens, programs, campaigns, users, media].find(r => r.error)
  if (firstError?.error) {
    throw new Error('No se pudo generar el respaldo: ' + firstError.error.message)
  }

  return {
    exported_at: new Date().toISOString(),
    organization: org,
    screens: screens.data ?? [],
    programs: programs.data ?? [],
    campaigns: campaigns.data ?? [],
    users: users.data ?? [],
    media_content: media.data ?? [],
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Método no permitido' }, 405)

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SERVICE_ROLE_KEY) {
    return json({ error: 'Función no configurada en el servidor' }, 500)
  }
  if (!R2_ACCOUNT_ID || !R2_BUCKET_NAME || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
    return json({ error: 'R2 no está configurado en el servidor' }, 500)
  }

  // 1. Identificar a quien llama con su JWT
  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return json({ error: 'No autorizado' }, 401)

  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  })
  const { data: { user }, error: authError } = await userClient.auth.getUser()
  if (authError || !user) return json({ error: 'Sesión inválida' }, 401)

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  // 2. Protección 1 — quien llama debe ser superadmin (leído del servidor)
  const { data: caller } = await admin
    .from('profiles').select('is_superadmin, organization_id').eq('id', user.id).single()
  if (!caller?.is_superadmin) {
    return json({ error: 'Solo el superadmin puede eliminar organizaciones' }, 403)
  }

  // 3. Cuerpo
  let body: { orgId?: string; confirmName?: string }
  try { body = await req.json() }
  catch { return json({ error: 'Cuerpo inválido (se esperaba JSON)' }, 400) }

  const orgId = typeof body.orgId === 'string' ? body.orgId : ''
  const confirmName = typeof body.confirmName === 'string' ? body.confirmName : ''
  if (!orgId || !confirmName) return json({ error: 'Faltan parámetros' }, 400)

  // 4. Protección 2 — nunca la propia organización
  if (orgId === caller.organization_id) {
    return json({ error: 'No puedes eliminar tu propia organización' }, 400)
  }

  const { data: org } = await admin
    .from('organizations').select('*').eq('id', orgId).single()
  if (!org) return json({ error: 'La organización no existe' }, 404)

  // 5. Protección 3 — nombre exacto
  if (confirmName !== org.name) {
    return json({ error: 'El nombre de confirmación no coincide' }, 400)
  }

  // 6. Protección 4 — solo organizaciones ya dadas de baja
  if (org.status !== 'suspended' && org.status !== 'cancelled') {
    return json({ error: 'Suspende la organización antes de eliminarla' }, 400)
  }

  // 7. Respaldo, antes de destruir nada
  let backup: unknown
  try {
    backup = await buildBackup(admin, orgId, org)
  } catch (e) {
    return json({ error: (e as Error).message }, 500)
  }

  // 8. R2: toda la carpeta {orgId}/ — incluye branding y archivos huérfanos
  //    que ya no estén referenciados en media_content.
  const aws = new AwsClient({
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
    service: 's3',
    region: 'auto',
  })

  let filesDeleted = 0
  try {
    const keys = await listAllKeys(aws, `${orgId}/`)
    if (keys.length > MAX_R2_OBJECTS) {
      return json({
        error: `La organización tiene más de ${MAX_R2_OBJECTS} archivos en R2 ` +
               `(${keys.length}+). El borrado automático no es seguro a este ` +
               `volumen: vacía la carpeta "${orgId}/" desde el panel de ` +
               `Cloudflare R2 y vuelve a intentarlo. No se ha borrado nada.`,
      }, 413)
    }
    filesDeleted = await deleteKeys(aws, keys)
  } catch (e) {
    // Se aborta sin tocar la base de datos: la organización queda intacta y
    // el borrado se puede reintentar entero.
    return json({ error: 'Error borrando archivos en R2: ' + (e as Error).message }, 502)
  }

  // 9. Base de datos, atómico.
  //    Con userClient y NO con admin: las protecciones de la RPC se apoyan en
  //    auth.uid() (is_superadmin, current_org_id, el deleted_by de la
  //    auditoría), y con service_role no hay usuario en sesión — auth.uid()
  //    sería NULL y la función rechazaría su propia llamada. La RPC es
  //    SECURITY DEFINER, así que los privilegios para borrar los pone ella;
  //    del que llama solo necesita la identidad.
  const { data: rpc, error: rpcError } = await userClient
    .rpc('superadmin_delete_org', { p_org_id: orgId, p_confirm_name: confirmName })
  if (rpcError) {
    return json({
      error: 'Archivos borrados pero la base de datos no: ' + rpcError.message,
      filesDeleted, backup,
    }, 500)
  }

  // 10. Cuentas de auth. Es el único paso que puede quedar a medias sin
  //     remedio automático: las que fallen se devuelven y quedan registradas
  //     en deleted_organizations.user_ids para limpiarlas a mano.
  const userIds: string[] = (rpc?.user_ids ?? []) as string[]
  const failedUsers: string[] = []
  for (const id of userIds) {
    const { error } = await admin.auth.admin.deleteUser(id)
    if (error) failedUsers.push(id)
  }

  return json({
    ok: true,
    name: org.name,
    filesDeleted,
    counts: rpc?.counts ?? {},
    usersDeleted: userIds.length - failedUsers.length,
    failedUsers,
    backup,
  }, 200)
})
