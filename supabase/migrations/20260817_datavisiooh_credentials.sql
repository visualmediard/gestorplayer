-- FASE A — CREDENCIALES DE DATAVISIOOH POR ORGANIZACIÓN
--
-- Cada organización guarda su propio token de DataVisiooh (la empresa de
-- conteo vehicular). El token es un SECRETO: no puede viajar al frontend ni
-- con la anon key ni como authenticated.
--
-- Decisiones de diseño:
--   - La URL de la API NO se guarda: vive fija en el código del conector. Un
--     campo editable por el admin sería un SSRF servido en bandeja, la misma
--     forma del bug que arreglamos en get-org-logo.
--   - El `hash` de cliente NO lo escribe el admin: lo descubre el conector
--     llamando a /clients con el token, y lo guarda con service_role. Es un
--     identificador, no una credencial, así que se puede leer desde el panel.
--   - El proveedor es fijo ('datavisiooh'). Si algún día hay otro, se añade
--     una fila por proveedor y el PK pasa a (organization_id, provider).
--
-- El token se separa en OTRA tabla, sin privilegios para anon ni authenticated.
-- Que esté en otra tabla no es cosmético: significa que traffic_providers se
-- puede leer con SELECT * sin riesgo, hoy y cuando alguien le añada columnas.

-- ── 1. Configuración legible ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS traffic_providers (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  provider        text NOT NULL DEFAULT 'datavisiooh'
                    CHECK (provider IN ('datavisiooh')),
  -- Hash de cliente de DataVisiooh. Lo rellena el conector (service_role)
  -- tras llamar a /clients; NULL mientras no se haya validado el token.
  hash            text,
  -- Solo para la UI: "Token configurado ✓ · ••••7f3a". Fuga deliberada de 4
  -- caracteres, el estándar de la industria (Stripe hace lo mismo).
  token_last4     text,
  token_set_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- ── 2. El secreto, aparte y cerrado ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS traffic_provider_secrets (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  token           text NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- ── 3. Privilegios ────────────────────────────────────────────────────────
-- Sobre la tabla legible: SELECT para authenticated (la RLS de abajo lo acota
-- a su organización y a admin). Las escrituras van por RPC, así que se
-- retiran, igual que se hizo en 20260810_column_privileges.
REVOKE ALL    ON traffic_providers FROM PUBLIC, anon, authenticated;
GRANT  SELECT ON traffic_providers TO authenticated;
GRANT  ALL    ON traffic_providers TO service_role;

-- Sobre el secreto: NADA para anon ni authenticated. Esta es la barrera
-- principal — PostgREST se conecta con esos roles, y sin privilegio de tabla
-- la consulta se rechaza antes de que la RLS entre siquiera en juego.
REVOKE ALL ON traffic_provider_secrets FROM PUBLIC, anon, authenticated;
GRANT  ALL ON traffic_provider_secrets TO service_role;

-- ── 4. RLS ────────────────────────────────────────────────────────────────
ALTER TABLE traffic_providers        ENABLE ROW LEVEL SECURITY;
ALTER TABLE traffic_provider_secrets ENABLE ROW LEVEL SECURITY;

-- Lectura de la configuración: solo el admin de ESA organización. Sin
-- USING (true) en ninguna parte.
DROP POLICY IF EXISTS "org admin reads traffic provider" ON traffic_providers;
CREATE POLICY "org admin reads traffic provider"
  ON traffic_providers FOR SELECT TO authenticated
  USING (organization_id = current_org_id() AND current_user_role() = 'admin');

-- traffic_provider_secrets se queda con RLS activada y CERO políticas: en
-- Postgres eso significa denegar todo. Segunda cerradura, independiente de los
-- privilegios de arriba. service_role las salta por ser BYPASSRLS.

-- ── 5. Escritura del token: entra, no sale ────────────────────────────────
-- SECURITY DEFINER para poder escribir en una tabla que el llamante no puede
-- ni ver. RETURNS void: no hay ninguna ruta por la que el token vuelva.
CREATE OR REPLACE FUNCTION set_datavisiooh_token(p_token text)
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public AS $$
DECLARE
  v_org   uuid;
  v_token text := trim(p_token);
BEGIN
  IF current_user_role() <> 'admin' THEN
    RAISE EXCEPTION 'Solo un administrador puede configurar el conteo vehicular';
  END IF;

  v_org := current_org_id();
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'El usuario no tiene organización';
  END IF;

  -- Cotas de cordura, no de formato: el proveedor podría cambiar la longitud
  -- de sus tokens (el actual tiene 32 caracteres) y no queremos romper por eso.
  IF v_token IS NULL OR length(v_token) < 8 THEN
    RAISE EXCEPTION 'El token es demasiado corto';
  END IF;
  IF length(v_token) > 512 THEN
    RAISE EXCEPTION 'El token es demasiado largo';
  END IF;

  INSERT INTO traffic_provider_secrets (organization_id, token, updated_at)
    VALUES (v_org, v_token, now())
  ON CONFLICT (organization_id) DO UPDATE
    SET token = EXCLUDED.token, updated_at = now();

  -- El hash se pone a NULL a propósito: un token nuevo puede ser de otra
  -- cuenta, y arrastrar el hash anterior pediría datos del cliente equivocado.
  -- El conector lo vuelve a resolver contra /clients.
  INSERT INTO traffic_providers (organization_id, provider, hash, token_last4, token_set_at, updated_at)
    VALUES (v_org, 'datavisiooh', NULL, right(v_token, 4), now(), now())
  ON CONFLICT (organization_id) DO UPDATE
    SET hash         = NULL,
        token_last4  = EXCLUDED.token_last4,
        token_set_at = EXCLUDED.token_set_at,
        updated_at   = now();
END $$;

CREATE OR REPLACE FUNCTION clear_datavisiooh_token()
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public AS $$
DECLARE
  v_org uuid;
BEGIN
  IF current_user_role() <> 'admin' THEN
    RAISE EXCEPTION 'Solo un administrador puede configurar el conteo vehicular';
  END IF;

  v_org := current_org_id();
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'El usuario no tiene organización';
  END IF;

  DELETE FROM traffic_provider_secrets WHERE organization_id = v_org;

  UPDATE traffic_providers
     SET hash = NULL, token_last4 = NULL, token_set_at = NULL, updated_at = now()
   WHERE organization_id = v_org;
END $$;

-- anon jamás: el player no tiene nada que hacer aquí.
REVOKE ALL     ON FUNCTION set_datavisiooh_token(text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION set_datavisiooh_token(text) TO authenticated;

REVOKE ALL     ON FUNCTION clear_datavisiooh_token() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION clear_datavisiooh_token() TO authenticated;

-- NO existe ninguna función que devuelva el token. Es intencional: la única
-- lectura es desde la Edge Function del conector, con service_role.

-- ── Comprobación ─────────────────────────────────────────────────────────
-- Que la tabla del secreto es inalcanzable para el frontend:
--   SELECT grantee, privilege_type FROM information_schema.role_table_grants
--    WHERE table_name = 'traffic_provider_secrets';
--   -- debe listar solo service_role (y el dueño)
--
-- Que no hay ninguna función que lo devuelva:
--   SELECT proname FROM pg_proc WHERE prosrc LIKE '%traffic_provider_secrets%';
--   -- solo set_datavisiooh_token y clear_datavisiooh_token, ambas RETURNS void
