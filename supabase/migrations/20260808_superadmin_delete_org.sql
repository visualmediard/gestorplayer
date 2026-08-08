-- ELIMINACIÓN DEFINITIVA DE UNA ORGANIZACIÓN
--
-- La acción más destructiva del sistema. Borra todo rastro de una organización
-- en la base de datos, en una sola transacción. Los archivos de R2 y las
-- cuentas de auth.users los borra la Edge Function superadmin-delete-org, que
-- es quien llama a esta función.
--
-- El borrado es EXPLÍCITO tabla por tabla, en orden hijos → padres, sin
-- confiar en ON DELETE CASCADE. Varias tablas se referencian entre sí
-- (media_content → zones/campaigns, screens → programs, playback_events →
-- screens/zones/media_content): si se dejara al cascade, el orden lo decidiría
-- Postgres y un DELETE intermedio podría fallar por una FK todavía viva. El
-- cascade queda como red de seguridad, no como mecanismo.

-- ── Auditoría ──────────────────────────────────────────────────────────────
-- A propósito SIN foreign keys: una FK hacia organizations o profiles haría
-- que el propio borrado que documenta se lleve por delante el registro.
CREATE TABLE IF NOT EXISTS deleted_organizations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL,
  name             text NOT NULL,
  slug             text,
  status           text,
  org_created_at   timestamptz,
  deleted_at       timestamptz NOT NULL DEFAULT now(),
  deleted_by       uuid,
  deleted_by_email text,
  -- Cuentas de auth que había que borrar. Si la Edge Function muere entre la
  -- transacción y el borrado en auth, esta lista es la única forma de saber
  -- qué cuentas quedaron huérfanas.
  user_ids         uuid[] NOT NULL DEFAULT '{}',
  counts           jsonb  NOT NULL DEFAULT '{}'::jsonb
);

ALTER TABLE deleted_organizations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "superadmin reads deletion log" ON deleted_organizations;
CREATE POLICY "superadmin reads deletion log"
  ON deleted_organizations FOR SELECT USING (is_superadmin());
-- Sin policy de INSERT: solo escribe la función de abajo (SECURITY DEFINER).

-- ── Borrado ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION superadmin_delete_org(p_org_id uuid, p_confirm_name text)
  RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public AS $$
DECLARE
  v_org      organizations%ROWTYPE;
  v_email    text;
  v_users    uuid[] := '{}';
  v_counts   jsonb  := '{}'::jsonb;
  n          integer;
BEGIN
  -- ── Protección 1: solo superadmin ────────────────────────────────────────
  IF NOT is_superadmin() THEN
    RAISE EXCEPTION 'Solo el superadmin puede eliminar organizaciones';
  END IF;

  SELECT * INTO v_org FROM organizations WHERE id = p_org_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'La organización no existe';
  END IF;

  -- ── Protección 2: nunca la propia (guard contra autodestrucción) ─────────
  IF p_org_id = current_org_id() THEN
    RAISE EXCEPTION 'No puedes eliminar tu propia organización';
  END IF;

  -- ── Protección 3: confirmación por nombre exacto ─────────────────────────
  -- Se valida aquí y no solo en el cliente: un botón deshabilitado no es una
  -- barrera, cualquiera puede llamar la RPC directamente.
  IF p_confirm_name IS DISTINCT FROM v_org.name THEN
    RAISE EXCEPTION 'El nombre de confirmación no coincide';
  END IF;

  -- ── Protección 4: solo organizaciones ya dadas de baja ───────────────────
  IF v_org.status NOT IN ('suspended', 'cancelled') THEN
    RAISE EXCEPTION 'Suspende la organización antes de eliminarla';
  END IF;

  SELECT email INTO v_email FROM profiles WHERE id = auth.uid();

  -- ── 1. playback_events ───────────────────────────────────────────────────
  -- No tiene organization_id: cuelga por screen_id, zone_id y content_id. Se
  -- cubren los tres porque una fila puede tener unos nulos y otros no.
  DELETE FROM playback_events pe
   WHERE pe.screen_id IN (
           SELECT id FROM screens WHERE organization_id = p_org_id)
      OR pe.zone_id IN (
           SELECT z.id FROM zones z
             JOIN programs p ON p.id = z.program_id
            WHERE p.organization_id = p_org_id)
      OR pe.content_id IN (
           SELECT id FROM media_content WHERE organization_id = p_org_id);
  GET DIAGNOSTICS n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('playback_events', n);

  -- ── 2. sub_playlists ─────────────────────────────────────────────────────
  DELETE FROM sub_playlists sp
   WHERE sp.zone_id IN (
           SELECT z.id FROM zones z
             JOIN programs p ON p.id = z.program_id
            WHERE p.organization_id = p_org_id)
      OR sp.campaign_id IN (
           SELECT id FROM campaigns WHERE organization_id = p_org_id);
  GET DIAGNOSTICS n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('sub_playlists', n);

  -- ── 3. media_content (antes que zones y campaigns: las referencia) ───────
  DELETE FROM media_content WHERE organization_id = p_org_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('media_content', n);

  -- ── 4. device_pairings (antes que screens: cuelga de screens.device_token)
  -- Cast explícito a text en ambos lados: device_pairings.token es text y
  -- screens.device_token es uuid, y Postgres no compara los dos tipos solo
  -- (en pair_screen_by_code sí funciona sin cast porque ahí es una asignación
  -- a variable, no una comparación).
  DELETE FROM device_pairings dp
   WHERE dp.token::text IN (
     SELECT s.device_token::text FROM screens s
      WHERE s.organization_id = p_org_id AND s.device_token IS NOT NULL);
  GET DIAGNOSTICS n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('device_pairings', n);

  -- ── 5. screens (antes que programs: screens.current_program_id) ──────────
  DELETE FROM screens WHERE organization_id = p_org_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('screens', n);

  -- ── 6. zones ─────────────────────────────────────────────────────────────
  DELETE FROM zones z
   WHERE z.program_id IN (SELECT id FROM programs WHERE organization_id = p_org_id);
  GET DIAGNOSTICS n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('zones', n);

  -- ── 7-10. campaigns, programs, media_tags, invitations ───────────────────
  DELETE FROM campaigns WHERE organization_id = p_org_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('campaigns', n);

  DELETE FROM programs WHERE organization_id = p_org_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('programs', n);

  DELETE FROM media_tags WHERE organization_id = p_org_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('media_tags', n);

  DELETE FROM invitations WHERE organization_id = p_org_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('invitations', n);

  -- ── 11. profiles — se guardan los ids para borrar sus cuentas de auth ────
  WITH del AS (
    DELETE FROM profiles WHERE organization_id = p_org_id RETURNING id
  )
  SELECT COALESCE(array_agg(id), '{}') INTO v_users FROM del;
  v_counts := v_counts || jsonb_build_object('profiles', COALESCE(array_length(v_users, 1), 0));

  -- ── 12. Auditoría (antes del DELETE final, con la org todavía viva) ──────
  INSERT INTO deleted_organizations (
    organization_id, name, slug, status, org_created_at,
    deleted_by, deleted_by_email, user_ids, counts
  ) VALUES (
    v_org.id, v_org.name, v_org.slug, v_org.status, v_org.created_at,
    auth.uid(), v_email, v_users, v_counts
  );

  -- ── 13. La organización ──────────────────────────────────────────────────
  DELETE FROM organizations WHERE id = p_org_id;

  RETURN jsonb_build_object(
    'ok', true, 'name', v_org.name, 'user_ids', to_jsonb(v_users), 'counts', v_counts
  );
END $$;

REVOKE ALL     ON FUNCTION superadmin_delete_org(uuid, text) FROM public, anon;
GRANT  EXECUTE ON FUNCTION superadmin_delete_org(uuid, text) TO authenticated;
