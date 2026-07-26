-- Aceptar una invitación: liga al usuario autenticado a la organización y rol
-- de la invitación. SECURITY DEFINER porque el invitado aún no es miembro y la
-- RLS de invitations no le deja leer su propia invitación por token. El token
-- es la credencial: no se exige que el email registrado coincida con el de la
-- invitación. Hace UPSERT del perfil (no hay trigger que lo cree al registrarse)
-- e incluye el nombre que el invitado escribió en el registro (p_full_name).

-- Se elimina la versión anterior de un solo argumento para evitar ambigüedad
-- de sobrecarga al añadir el parámetro opcional p_full_name.
DROP FUNCTION IF EXISTS accept_invitation(text);

CREATE OR REPLACE FUNCTION accept_invitation(p_token text, p_full_name text DEFAULT NULL)
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public AS $$
DECLARE
  v_uid   uuid := auth.uid();
  v_inv   invitations%ROWTYPE;
  v_email text;
  v_name  text := NULLIF(trim(p_full_name), '');
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Debes iniciar sesión para aceptar la invitación';
  END IF;

  SELECT * INTO v_inv FROM invitations WHERE token = p_token;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'La invitación no existe o el enlace es inválido';
  END IF;
  IF v_inv.accepted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Esta invitación ya fue utilizada';
  END IF;
  IF v_inv.expires_at IS NOT NULL AND v_inv.expires_at < now() THEN
    RAISE EXCEPTION 'La invitación ha vencido';
  END IF;

  -- Email del usuario autenticado (columna NOT NULL en profiles). Si por algún
  -- motivo no estuviera, se cae al email de la invitación.
  SELECT email INTO v_email FROM auth.users WHERE id = v_uid;

  -- Crea o actualiza el perfil, ligándolo a la organización + rol y guardando
  -- el nombre. En conflicto, conserva el nombre existente si no se envió uno.
  INSERT INTO profiles (id, email, organization_id, role, full_name)
    VALUES (v_uid, COALESCE(v_email, v_inv.email), v_inv.organization_id, v_inv.role, v_name)
  ON CONFLICT (id) DO UPDATE
    SET organization_id = EXCLUDED.organization_id,
        role            = EXCLUDED.role,
        full_name       = COALESCE(EXCLUDED.full_name, profiles.full_name);

  UPDATE invitations SET accepted_at = now() WHERE id = v_inv.id;
END $$;
