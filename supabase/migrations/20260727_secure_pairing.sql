-- Emparejamiento seguro de pantallas.
--
-- Solo un admin de la organización dueña de la pantalla puede vincularla. El
-- flujo por código (player Android) escribía el token vía UPDATE directo a
-- device_pairings (policy "public_pairings" ALL true) — ahora ese UPDATE solo
-- ocurre dentro de esta RPC, que valida rol admin + pertenencia a la org.
--
-- current_user_role() y current_org_id() vienen de 20260726_user_management.

CREATE OR REPLACE FUNCTION pair_screen_by_code(p_code text, p_screen_id uuid)
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public AS $$
DECLARE
  v_token text;
BEGIN
  IF current_user_role() <> 'admin' THEN
    RAISE EXCEPTION 'Solo un administrador puede vincular pantallas';
  END IF;

  -- La pantalla debe existir y pertenecer a la organización del admin.
  SELECT device_token INTO v_token
  FROM screens
  WHERE id = p_screen_id AND organization_id = current_org_id();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'La pantalla no pertenece a tu organización';
  END IF;
  IF v_token IS NULL THEN
    RAISE EXCEPTION 'La pantalla no tiene token de dispositivo';
  END IF;

  UPDATE device_pairings SET token = v_token WHERE code = p_code;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'El código de vinculación no existe o expiró';
  END IF;
END $$;

GRANT EXECUTE ON FUNCTION pair_screen_by_code(text, uuid) TO authenticated;

-- Cierra el UPDATE directo: el token de una vinculación solo se escribe vía la
-- RPC de arriba (SECURITY DEFINER). El player (anon) sigue creando, leyendo y
-- borrando su propio código de vinculación (INSERT / SELECT / DELETE).
REVOKE UPDATE ON device_pairings FROM anon, authenticated;
