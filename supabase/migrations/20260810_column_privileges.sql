-- PRIVILEGIOS POR COLUMNA (raíz del agujero de escritura)
--
-- La policy "users update own org" autoriza el UPDATE de la fila COMPLETA, y
-- RLS no distingue columnas. Se ha parcheado tres veces con triggers
-- (is_superadmin, status, storage_limit_mb) y una cuarta apareció sola
-- (logo_url → SSRF). Los triggers funcionan pero dependen de que alguien
-- recuerde ampliarlos: el mecanismo correcto de Postgres son los privilegios
-- por columna, que son declarativos y se ven en el esquema.
--
-- OJO: `REVOKE UPDATE (columna)` NO sirve si existe un GRANT a nivel de tabla
-- —el permiso de tabla cubre todas las columnas—. Hay que revocar la tabla y
-- volver a conceder solo las columnas permitidas (lista blanca).
--
-- Esto NO afecta a:
--   · las funciones SECURITY DEFINER (set_org_status, set_org_storage_limit,
--     set_member_role, superadmin_delete_org...), que corren como su dueño
--   · service_role (Edge Functions), al que se le reafirma el permiso abajo
-- Los triggers guard_org_admin_columns se dejan como segunda barrera.

-- ── organizations ──────────────────────────────────────────────────────────
-- El cliente solo escribe name/address/phone/email (Settings.tsx). logo_url
-- sale de la lista a propósito: pasa a la RPC set_org_logo, que valida la URL.
-- Quedan protegidas: status, storage_limit_mb, logo_url, slug, id, created_at.
REVOKE UPDATE ON organizations FROM anon, authenticated;
GRANT  UPDATE (name, address, phone, email) ON organizations TO authenticated;
GRANT  UPDATE ON organizations TO service_role;

-- ── profiles ───────────────────────────────────────────────────────────────
-- Revoke total: hoy NINGÚN punto del frontend hace UPDATE sobre profiles. Los
-- cambios de rol van por set_member_role (SECURITY DEFINER) y la gestión de
-- usuarios por la Edge Function admin-manage-user (service_role). Si mañana
-- hiciera falta un "editar mi nombre" desde el cliente, la solución es un
-- GRANT UPDATE (full_name) explícito, no volver a abrir la tabla entera.
REVOKE UPDATE ON profiles FROM anon, authenticated;
GRANT  UPDATE ON profiles TO service_role;
