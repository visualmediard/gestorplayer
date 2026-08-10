-- LOGO DE LA ORGANIZACIÓN: ESCRITURA VALIDADA (corrige el SSRF)
--
-- `organizations.logo_url` era texto libre escrito por el cliente
-- (Settings.tsx). La Edge Function get-org-logo hace fetch() de ese valor
-- DESDE EL SERVIDOR y devuelve el cuerpo en base64, así que un admin podía
-- apuntar a cualquier host —incluido el metadata del proveedor o un servicio
-- interno— y leer la respuesta. SSRF con lectura.
--
-- Dos barreras, en dos capas distintas:
--   1. get-org-logo exige que la URL empiece por R2_PUBLIC_URL (control
--      principal: es la única capa que conoce el dominio real de R2)
--   2. esta RPC, que impide de entrada guardar una URL arbitraria
--
-- El GRANT de UPDATE sobre logo_url se retira en 20260810_column_privileges.

CREATE OR REPLACE FUNCTION set_org_logo(p_url text)
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public AS $$
DECLARE
  v_org uuid;
BEGIN
  IF current_user_role() <> 'admin' THEN
    RAISE EXCEPTION 'Solo un administrador puede cambiar el logo';
  END IF;

  v_org := current_org_id();
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'El usuario no tiene organización';
  END IF;

  -- Quitar el logo es válido.
  IF p_url IS NULL OR p_url = '' THEN
    UPDATE organizations SET logo_url = NULL WHERE id = v_org;
    RETURN;
  END IF;

  IF length(p_url) > 500 THEN
    RAISE EXCEPTION 'La URL del logo es demasiado larga';
  END IF;

  -- Solo https y un host limpio. La clase de caracteres excluye '@', así que
  -- también rechaza el truco de userinfo (https://dominio-bueno@10.0.0.1/...).
  IF p_url !~ '^https://[A-Za-z0-9.-]+/' THEN
    RAISE EXCEPTION 'La URL del logo no es válida';
  END IF;

  -- La ruta debe caer dentro de la carpeta de R2 de la propia organización.
  -- Aquí no se conoce el dominio de R2 (es un secret del servidor), así que
  -- esta comprobación acota la ruta; el dominio lo valida get-org-logo.
  IF position('/' || v_org::text || '/' IN p_url) = 0 THEN
    RAISE EXCEPTION 'El logo debe estar en la carpeta de tu organización';
  END IF;

  UPDATE organizations SET logo_url = p_url WHERE id = v_org;
END $$;

REVOKE ALL     ON FUNCTION set_org_logo(text) FROM public, anon;
GRANT  EXECUTE ON FUNCTION set_org_logo(text) TO authenticated;
