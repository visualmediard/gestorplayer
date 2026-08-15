-- Endurece accept_invitation. Hasta aquí el token era una credencial "al
-- portador": quien abriera el enlace, con la sesión que tuviera abierta, se
-- llevaba la organización y el rol de la invitación a SU propio perfil (el
-- ON CONFLICT DO UPDATE pisa organization_id y role). Eso degradó la cuenta de
-- superadmin a 'client' al abrir el enlace de un invitado, y de paso quemó la
-- invitación del destinatario real.
--
-- Tres guardas, todas ANTES de tocar nada:
--   (a) El email de la invitación debe coincidir con el del usuario logueado.
--   (b) Un superadmin no puede aceptar invitaciones (nunca se auto-degrada).
--   (c) Un usuario que ya pertenece a otra organización no se muda en silencio.
--
-- Importante que aborten antes del UPDATE de invitations: si se aceptara "sin
-- efecto" se marcaría accepted_at igual y el invitado se quedaría sin enlace.
--
-- Cambio de flujo consciente: con (a), quien se registre con un email distinto
-- al invitado ya NO puede aceptar. El admin debe reenviar la invitación al
-- email correcto.

CREATE OR REPLACE FUNCTION accept_invitation(p_token text, p_full_name text DEFAULT NULL)
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public AS $$
DECLARE
  v_uid     uuid := auth.uid();
  v_inv     invitations%ROWTYPE;
  v_email   text;
  v_name    text := NULLIF(trim(p_full_name), '');
  v_cur_org uuid;
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

  -- Email del usuario autenticado. Se prefiere el del JWT; si no viniera, se
  -- cae a auth.users. Sin email no se puede validar (a), así que se aborta.
  v_email := COALESCE(
    NULLIF(auth.jwt() ->> 'email', ''),
    (SELECT u.email FROM auth.users u WHERE u.id = v_uid)
  );
  IF v_email IS NULL THEN
    RAISE EXCEPTION 'No se pudo determinar el email de tu cuenta';
  END IF;

  -- (b) Superadmin: es el dueño de la plataforma, no un miembro de una
  -- organización. Aceptar una invitación solo puede ser un error.
  IF COALESCE((SELECT p.is_superadmin FROM profiles p WHERE p.id = v_uid), false) THEN
    RAISE EXCEPTION
      'Tu cuenta es superadmin de la plataforma: no puede aceptar invitaciones. '
      'Cierra sesión y abre el enlace con la cuenta invitada.';
  END IF;

  -- (a) El token deja de ser credencial suficiente: debe coincidir el email.
  IF lower(trim(v_email)) <> lower(trim(v_inv.email)) THEN
    RAISE EXCEPTION
      'Esta invitación es para % y tu sesión es de %. '
      'Inicia sesión con la cuenta invitada.', v_inv.email, v_email;
  END IF;

  -- (c) Mudanza silenciosa entre organizaciones. Un perfil nuevo (sin org) o
  -- una re-invitación a la MISMA organización pasan sin problema; cambiar de
  -- organización exige que un admin lo saque antes de la actual.
  SELECT p.organization_id INTO v_cur_org FROM profiles p WHERE p.id = v_uid;
  IF v_cur_org IS NOT NULL AND v_cur_org <> v_inv.organization_id THEN
    RAISE EXCEPTION
      'Tu cuenta ya pertenece a otra organización. '
      'Pide a un administrador que te dé de baja antes de aceptar esta invitación.';
  END IF;

  -- Crea o actualiza el perfil, ligándolo a la organización + rol y guardando
  -- el nombre. En conflicto, conserva el nombre existente si no se envió uno.
  -- is_superadmin no aparece aquí a propósito: no se toca nunca.
  INSERT INTO profiles (id, email, organization_id, role, full_name)
    VALUES (v_uid, v_email, v_inv.organization_id, v_inv.role, v_name)
  ON CONFLICT (id) DO UPDATE
    SET organization_id = EXCLUDED.organization_id,
        role            = EXCLUDED.role,
        full_name       = COALESCE(EXCLUDED.full_name, profiles.full_name);

  UPDATE invitations SET accepted_at = now() WHERE id = v_inv.id;
END $$;
