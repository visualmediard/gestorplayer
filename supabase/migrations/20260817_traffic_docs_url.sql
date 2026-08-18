-- Enlace a la documentación de la API del proveedor de conteo, por organización.
--
-- Es un dato de conveniencia: cada empresa de conteo publica su documentación
-- en otro sitio, y el admin quiere tenerlo a mano sin buscarlo en su correo.
--
-- IMPORTANTE, y es lo que hace que este campo sea seguro siendo editable: el
-- SERVIDOR NUNCA HACE fetch() DE ESTA URL. Solo se muestra como enlace en el
-- panel, para que la abra el navegador del admin. La URL que el conector sí
-- consume (la de la API) sigue siendo una constante dentro de la Edge Function,
-- precisamente para que un admin no pueda dirigir nuestras peticiones a donde
-- quiera — el SSRF que se corrigió en get-org-logo.
--
-- La validación de abajo no es contra el SSRF entonces, sino contra el XSS:
-- sin ella se podría guardar 'javascript:...' y el panel lo pintaría como un
-- enlace pulsable.

ALTER TABLE traffic_providers ADD COLUMN IF NOT EXISTS docs_url text;

CREATE OR REPLACE FUNCTION set_traffic_docs_url(p_url text)
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public AS $$
DECLARE
  v_org uuid;
  v_url text := NULLIF(trim(p_url), '');
BEGIN
  IF current_user_role() <> 'admin' THEN
    RAISE EXCEPTION 'Solo un administrador puede configurar el conteo vehicular';
  END IF;

  v_org := current_org_id();
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'El usuario no tiene organización';
  END IF;

  IF v_url IS NOT NULL THEN
    IF length(v_url) > 500 THEN
      RAISE EXCEPTION 'El enlace es demasiado largo';
    END IF;
    -- Solo https y un host limpio, igual que set_org_logo. La clase de
    -- caracteres excluye '@', así que también rechaza el truco de userinfo.
    IF v_url !~ '^https://[A-Za-z0-9.-]+(/|$)' THEN
      RAISE EXCEPTION 'El enlace debe empezar por https:// y ser una dirección válida';
    END IF;
  END IF;

  -- La fila puede no existir todavía: el enlace se puede guardar antes que el
  -- token, y no hay motivo para obligar a un orden.
  INSERT INTO traffic_providers (organization_id, provider, docs_url, updated_at)
    VALUES (v_org, 'datavisiooh', v_url, now())
  ON CONFLICT (organization_id) DO UPDATE
    SET docs_url = EXCLUDED.docs_url, updated_at = now();
END $$;

REVOKE ALL     ON FUNCTION set_traffic_docs_url(text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION set_traffic_docs_url(text) TO authenticated;
