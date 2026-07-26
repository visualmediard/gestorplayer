// Edge Function: gestión de usuarios por un administrador de la organización.
//
// Acciones:
//   - update: cambia full_name (en profiles) y/o email (en auth.users + profiles)
//   - delete: borra el perfil y la cuenta de auth por completo
//
// Requiere service_role porque editar el email y borrar la cuenta tocan
// auth.users, que no es accesible desde el frontend. La autorización NO se
// confía al cliente: se valida con el JWT del que llama que sea admin de la
// organización, y que el usuario objetivo pertenezca a la MISMA organización.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

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

  // 1. Identificar a quien llama con su JWT
  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return json({ error: 'No autorizado' }, 401)

  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  })
  const { data: { user }, error: authError } = await userClient.auth.getUser()
  if (authError || !user) return json({ error: 'Sesión inválida' }, 401)

  // Cliente admin (service_role) para operaciones sobre auth y profiles.
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  // 2. Quien llama debe ser admin; se toma su organización del servidor.
  const { data: caller } = await admin
    .from('profiles').select('role, organization_id').eq('id', user.id).single()
  if (!caller || caller.role !== 'admin') {
    return json({ error: 'Solo un administrador puede gestionar usuarios' }, 403)
  }

  // 3. Leer el cuerpo
  let body: { action?: string; userId?: string; fullName?: string; email?: string }
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Cuerpo inválido (se esperaba JSON)' }, 400)
  }
  const { action, userId, fullName, email } = body
  if (!action || !userId) return json({ error: 'Faltan parámetros' }, 400)

  // 4. El usuario objetivo debe pertenecer a la MISMA organización.
  const { data: target } = await admin
    .from('profiles').select('id, role, organization_id, email').eq('id', userId).single()
  if (!target || target.organization_id !== caller.organization_id) {
    return json({ error: 'El usuario no pertenece a tu organización' }, 403)
  }

  // ── UPDATE ────────────────────────────────────────────────────────────────
  if (action === 'update') {
    if (typeof fullName === 'string') {
      const { error: e } = await admin.from('profiles')
        .update({ full_name: fullName.trim() || null }).eq('id', userId)
      if (e) return json({ error: 'Error al guardar el nombre: ' + e.message }, 500)
    }

    if (typeof email === 'string' && email.trim()) {
      const newEmail = email.trim().toLowerCase()
      if (newEmail !== (target.email ?? '').toLowerCase()) {
        // 1) actualiza en auth (fuente de verdad del login)
        const { error: eAuth } = await admin.auth.admin.updateUserById(userId, { email: newEmail })
        if (eAuth) return json({ error: 'Error al cambiar el correo: ' + eAuth.message }, 400)
        // 2) refleja en profiles
        const { error: eProf } = await admin.from('profiles')
          .update({ email: newEmail }).eq('id', userId)
        if (eProf) return json({ error: 'Correo cambiado en login pero no en perfil: ' + eProf.message }, 500)
      }
    }

    return json({ ok: true }, 200)
  }

  // ── DELETE ──────────────────────────────────────────────────────────────
  if (action === 'delete') {
    if (userId === user.id) {
      return json({ error: 'No puedes eliminar tu propia cuenta desde aquí' }, 400)
    }

    // No dejar la organización sin ningún administrador.
    if (target.role === 'admin') {
      const { count } = await admin
        .from('profiles')
        .select('id', { count: 'exact', head: true })
        .eq('organization_id', caller.organization_id)
        .eq('role', 'admin')
        .neq('id', userId)
      if (!count || count < 1) {
        return json({ error: 'La organización debe tener al menos un administrador' }, 400)
      }
    }

    // Borra primero el perfil (quita de la org), luego la cuenta de auth.
    const { error: eProf } = await admin.from('profiles').delete().eq('id', userId)
    if (eProf) return json({ error: 'Error al borrar el perfil: ' + eProf.message }, 500)

    const { error: eAuth } = await admin.auth.admin.deleteUser(userId)
    if (eAuth) return json({ error: 'Perfil borrado pero la cuenta de login persiste: ' + eAuth.message }, 500)

    return json({ ok: true }, 200)
  }

  return json({ error: 'Acción no reconocida' }, 400)
})
