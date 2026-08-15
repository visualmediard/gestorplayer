-- Elimina el rol 'client'. Quedan tres: admin, operator y seller.
--
-- El acceso de clientes finales se diseñará cuando haya un cliente real que lo
-- pida, y tendrá que hacerse en RLS: hoy la RLS solo distingue 'admin' (vía
-- is_org_admin), así que operator, seller y client tienen exactamente los
-- mismos privilegios en la base. 'client' nunca fue un permiso, solo un filtro
-- de menú en el frontend.
--
-- Se aprietan los tres sitios donde vivía el valor, y no solo el frontend: un
-- perfil con role='client' que sobreviviera al cambio de UI se quedaría con el
-- menú VACÍO, porque Campañas y Estadísticas (sus dos únicos ítems) ya no lo
-- incluyen. La base es la red que impide volver a crear ese estado.
--
-- REQUISITO: no puede quedar NINGUNA fila con role='client' en profiles ni en
-- invitations, o los ALTER TABLE se rechazan. Ojo con invitations: el CHECK se
-- evalúa contra toda la tabla, así que las invitaciones ya ACEPTADAS cuentan
-- igual que las pendientes. Verificar antes, sin filtrar por accepted_at:
--   select email, role from profiles    where role = 'client';
--   select id, email, role, accepted_at from invitations where role = 'client';

-- ── 1. profiles.role ───────────────────────────────────────────────────────
ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_role_check;

ALTER TABLE profiles
  ADD CONSTRAINT profiles_role_check
  CHECK (role IN ('admin', 'operator', 'seller'));

-- ── 2. invitations.role ────────────────────────────────────────────────────
-- No se puede invitar a alguien como 'client'.
ALTER TABLE invitations DROP CONSTRAINT IF EXISTS invitations_role_check;

ALTER TABLE invitations
  ADD CONSTRAINT invitations_role_check
  CHECK (role IN ('admin', 'operator', 'seller'));

-- ── 3. set_member_role ─────────────────────────────────────────────────────
-- Idéntica a la versión de 20260726_user_management.sql salvo la lista de
-- roles válidos. Se reescribe entera porque el cuerpo no se puede parchear.
CREATE OR REPLACE FUNCTION set_member_role(p_user_id uuid, p_role text)
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public AS $$
DECLARE
  v_org    uuid;
  v_admins int;
BEGIN
  IF current_user_role() <> 'admin' THEN
    RAISE EXCEPTION 'Solo un administrador puede cambiar roles';
  END IF;
  IF p_role NOT IN ('admin','operator','seller') THEN
    RAISE EXCEPTION 'Rol inválido: %', p_role;
  END IF;

  v_org := current_org_id();

  -- El objetivo debe pertenecer a la organización del admin.
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = p_user_id AND organization_id = v_org
  ) THEN
    RAISE EXCEPTION 'El usuario no pertenece a tu organización';
  END IF;

  -- No dejar la organización sin ningún admin.
  IF p_role <> 'admin' THEN
    SELECT count(*) INTO v_admins FROM profiles
     WHERE organization_id = v_org AND role = 'admin' AND id <> p_user_id;
    IF v_admins = 0 THEN
      RAISE EXCEPTION 'La organización debe tener al menos un administrador';
    END IF;
  END IF;

  UPDATE profiles SET role = p_role WHERE id = p_user_id;
END $$;
