-- Aceptar una invitación: liga al usuario autenticado a la organización y rol
-- de la invitación. SECURITY DEFINER porque el invitado aún no es miembro y la
-- RLS de invitations no le deja leer su propia invitación por token. El token
-- es la credencial: no se exige que el email registrado coincida con el de la
-- invitación. Hace UPSERT del perfil (no hay trigger que lo cree al registrarse).

CREATE OR REPLACE FUNCTION accept_invitation(p_token text)
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public AS $$
DECLARE
  v_uid   uuid := auth.uid();
  v_inv   invitations%ROWTYPE;
  v_email text;
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

  -- Crea o actualiza el perfil, ligándolo a la organización + rol.
  INSERT INTO profiles (id, email, organization_id, role)
    VALUES (v_uid, COALESCE(v_email, v_inv.email), v_inv.organization_id, v_inv.role)
  ON CONFLICT (id) DO UPDATE
    SET organization_id = EXCLUDED.organization_id,
        role            = EXCLUDED.role;

  UPDATE invitations SET accepted_at = now() WHERE id = v_inv.id;
END $$;
