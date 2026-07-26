-- Gestión de usuarios: un admin ve a los miembros de su organización y cambia
-- su rol. Se usan funciones SECURITY DEFINER para leer el propio org_id/rol sin
-- caer en la recursión de RLS (una policy sobre profiles no puede consultar
-- profiles directamente). Mismo patrón que register_organization.

-- ── Helpers: organización y rol del usuario actual ──────────────────────────
CREATE OR REPLACE FUNCTION current_org_id()
  RETURNS uuid LANGUAGE sql SECURITY DEFINER STABLE
  SET search_path = public AS $$
    SELECT organization_id FROM profiles WHERE id = auth.uid()
  $$;

CREATE OR REPLACE FUNCTION current_user_role()
  RETURNS text LANGUAGE sql SECURITY DEFINER STABLE
  SET search_path = public AS $$
    SELECT role FROM profiles WHERE id = auth.uid()
  $$;

-- ── Lectura: un admin ve todos los perfiles de su organización ──────────────
-- Aditiva: se combina con OR con las policies existentes (cada quien sigue
-- viendo su propio perfil). Sin recursión gracias a los helpers de arriba.
DROP POLICY IF EXISTS "admins read org members" ON profiles;
CREATE POLICY "admins read org members"
  ON profiles FOR SELECT
  USING (
    current_user_role() = 'admin'
    AND organization_id = current_org_id()
  );

-- ── Cambio de rol: solo vía esta RPC (cambia SOLO la columna role) ──────────
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
  IF p_role NOT IN ('admin','operator','seller','client') THEN
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
