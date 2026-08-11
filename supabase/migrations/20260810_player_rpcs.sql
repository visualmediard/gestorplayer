-- RPCs DEL PLAYER (fase 1 de P1)
--
-- Hoy el player anónimo lee y escribe las tablas directamente, y para que eso
-- funcione sin sesión se abrieron policies con USING (true):
--   · device_pairings  → SELECT/INSERT/DELETE abiertos (se filtran los tokens
--     de vinculación en curso)
--   · screens          → SELECT abierto (nombres, ubicaciones y device_token
--     de TODAS las organizaciones) y ADEMÁS UPDATE abierto: cualquiera puede
--     secuestrar el device_fingerprint de cualquier pantalla, forzar resets o
--     falsear heartbeats
--   · media_content    → SELECT abierto
--   · playback_events  → INSERT con screen_id/zone_id arbitrarios: se pueden
--     envenenar las estadísticas de cualquier organización
--
-- Estas funciones dan al player todo lo que necesita SIN acceso directo a las
-- tablas: reciben el device_token (que es su credencial) y devuelven o
-- escriben únicamente lo de esa pantalla.
--
-- ESTA MIGRACIÓN NO CIERRA NADA. Las policies USING (true) y el UPDATE abierto
-- de screens siguen intactos a propósito, porque el player Android es un bundle
-- CONGELADO dentro del APK (MainActivity carga file:///android_asset/index.html)
-- y dejaría de funcionar. El cierre es la fase 5, después de que todas las TVs
-- tengan el APK nuevo. La columna app_version de abajo existe para poder
-- comprobar cuándo se llega a ese punto.

-- ── Versión del bundle que corre cada pantalla ─────────────────────────────
ALTER TABLE screens ADD COLUMN IF NOT EXISTS app_version text;

-- ── 1. Lectura completa: pantalla + programa + zonas + media ───────────────
-- VOLATILE a propósito: además de leer, resuelve el bloqueo por sesión. En dos
-- llamadas habría una ventana entre decidir el bloqueo y entregar el contenido.
CREATE OR REPLACE FUNCTION get_player_payload(p_token text, p_session text DEFAULT NULL)
  RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public AS $$
DECLARE
  v_screen screens%ROWTYPE;
  v_stale  boolean;
BEGIN
  -- device_token es uuid: se valida la forma antes de castear, para devolver
  -- 'invalid' en vez de reventar con un error de tipo.
  IF p_token IS NULL OR p_token !~
     '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN
    RETURN jsonb_build_object('status', 'invalid');
  END IF;

  SELECT * INTO v_screen FROM screens WHERE device_token = p_token::uuid;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'invalid');
  END IF;

  -- ── Device locking, decidido en el servidor ──────────────────────────────
  -- Antes lo decidía el cliente sobre datos que cualquiera podía escribir.
  -- 90 s = el OWNER_STALE_MS que ya usaba Player.tsx.
  IF p_session IS NOT NULL AND p_session <> '' THEN
    v_stale := v_screen.last_seen_at IS NULL
               OR v_screen.last_seen_at < now() - interval '90 seconds';

    IF v_screen.device_fingerprint IS NULL
       OR v_screen.device_fingerprint = p_session
       OR v_stale THEN
      UPDATE screens
         SET device_fingerprint = p_session, last_seen_at = now()
       WHERE id = v_screen.id
      RETURNING * INTO v_screen;
    ELSE
      -- Otra sesión es la dueña: no se devuelve NADA de contenido.
      RETURN jsonb_build_object('status', 'locked');
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'status', CASE WHEN v_screen.current_program_id IS NULL
                   THEN 'no-program' ELSE 'playing' END,
    'screen', jsonb_build_object(
      'id',                 v_screen.id,
      'name',               v_screen.name,
      'current_program_id', v_screen.current_program_id,
      'operating_start',    v_screen.operating_start,
      'operating_end',      v_screen.operating_end,
      'operating_hours',    v_screen.operating_hours,
      'reset_requested_at', v_screen.reset_requested_at
    ),
    'program', (
      SELECT jsonb_build_object(
               'id', p.id, 'name', p.name, 'width', p.width, 'height', p.height,
               'published_at', p.published_at, 'updated_at', p.updated_at)
        FROM programs p WHERE p.id = v_screen.current_program_id
    ),
    -- El filtrado por expires_at / not_before se deja al cliente, igual que
    -- hoy: cambiar la lógica de reproducción dentro de una migración de
    -- seguridad mezclaría dos riesgos distintos.
    'zones', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', z.id, 'name', z.name,
          'x', z.x, 'y', z.y, 'width', z.width, 'height', z.height,
          'background_color', z.background_color, 'fit_mode', z.fit_mode,
          'sort_order', z.sort_order,
          'items', COALESCE((
            SELECT jsonb_agg(to_jsonb(m) ORDER BY m.sort_order)
              FROM (SELECT mc.id, mc.type, mc.storage_path, mc.url,
                           mc.duration_seconds, mc.expires_at, mc.not_before,
                           mc.sort_order
                      FROM media_content mc
                     WHERE mc.zone_id = z.id
                       AND mc.sub_playlist_id IS NULL
                       AND mc.archived_at IS NULL) m), '[]'::jsonb),
          'subs', COALESCE((
            SELECT jsonb_agg(
                     jsonb_build_object(
                       'id', sp.id, 'sort_order', sp.sort_order,
                       'items', COALESCE((
                         SELECT jsonb_agg(to_jsonb(m2) ORDER BY m2.sort_order)
                           FROM (SELECT mc2.id, mc2.type, mc2.storage_path,
                                        mc2.url, mc2.duration_seconds,
                                        mc2.expires_at, mc2.not_before,
                                        mc2.sort_order
                                   FROM media_content mc2
                                  WHERE mc2.sub_playlist_id = sp.id
                                    AND mc2.archived_at IS NULL) m2), '[]'::jsonb))
                     ORDER BY sp.sort_order)
              FROM sub_playlists sp
             WHERE sp.zone_id = z.id AND sp.archived_at IS NULL), '[]'::jsonb)
        ) ORDER BY z.sort_order)
        FROM zones z WHERE z.program_id = v_screen.current_program_id
    ), '[]'::jsonb)
  );
END $$;

-- ── 2. Heartbeat (+ versión del bundle) ────────────────────────────────────
CREATE OR REPLACE FUNCTION player_heartbeat(p_token text, p_app_version text DEFAULT NULL)
  RETURNS void LANGUAGE sql SECURITY DEFINER
  SET search_path = public AS $$
  UPDATE screens
     SET last_heartbeat = now(),
         app_version    = COALESCE(p_app_version, app_version)
   WHERE device_token::text = p_token;
$$;

-- ── 3. Acuse del reset remoto ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION player_ack_reset(p_token text)
  RETURNS void LANGUAGE sql SECURITY DEFINER
  SET search_path = public AS $$
  UPDATE screens SET reset_requested_at = NULL
   WHERE device_token::text = p_token;
$$;

-- ── 4. Eventos de reproducción ─────────────────────────────────────────────
-- Hoy cualquier anónimo puede insertar eventos con el screen_id de OTRA
-- organización y falsear sus estadísticas. Aquí el token acota a qué
-- organización se puede escribir.
--
-- No se fuerza screen_id = la pantalla del token: el lote se persiste en
-- localStorage y cada fila lleva su propio screen_id justamente para que un
-- lote pendiente sobreviva a un cambio de token (ver restorePendingBatch en
-- Player.tsx). Se conserva ese comportamiento y se valida que la pantalla
-- pertenezca a la MISMA organización que el token, que es el límite que
-- importa. `count` viaja en la fila: el player agrega repeticiones en memoria.
CREATE OR REPLACE FUNCTION player_log_events(p_token text, p_events jsonb)
  RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public AS $$
DECLARE
  v_screen screens%ROWTYPE;
  n integer;
BEGIN
  SELECT * INTO v_screen FROM screens WHERE device_token::text = p_token;
  IF NOT FOUND THEN RETURN 0; END IF;

  IF jsonb_typeof(p_events) <> 'array' OR jsonb_array_length(p_events) > 500 THEN
    RAISE EXCEPTION 'Lote de eventos inválido';
  END IF;

  INSERT INTO playback_events (screen_id, zone_id, content_id, played_at, count)
  SELECT (e->>'screen_id')::uuid,
         (e->>'zone_id')::uuid,
         (e->>'content_id')::uuid,
         COALESCE((e->>'played_at')::timestamptz, now()),
         GREATEST(COALESCE((e->>'count')::int, 1), 1)
    FROM jsonb_array_elements(p_events) e
   WHERE EXISTS (
     SELECT 1 FROM screens s2
      WHERE s2.id = (e->>'screen_id')::uuid
        AND s2.organization_id = v_screen.organization_id);

  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- ── 5. Alta de código de vinculación ───────────────────────────────────────
-- El código se genera en el SERVIDOR con gen_random_bytes. Antes venía de
-- Math.random() en el cliente, que no es criptográficamente seguro y cuyo
-- substring podía devolver menos de 6 caracteres.
-- Alfabeto de 32 caracteres sin O/0 ni I/1 (se lee desde una TV). 256 % 32 = 0,
-- así que el módulo no introduce sesgo. 8 caracteres ≈ 10^12 combinaciones.
CREATE OR REPLACE FUNCTION create_pairing_code()
  RETURNS text LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public AS $$
DECLARE
  v_alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_code text;
  i int;
BEGIN
  FOR attempt IN 1..5 LOOP
    v_code := '';
    FOR i IN 1..8 LOOP
      v_code := v_code || substr(v_alphabet, 1 + (get_byte(gen_random_bytes(1), 0) % 32), 1);
    END LOOP;
    BEGIN
      INSERT INTO device_pairings (code, token) VALUES (v_code, NULL);
      RETURN v_code;
    EXCEPTION WHEN unique_violation THEN
      NULL;  -- colisión improbable: reintenta
    END;
  END LOOP;
  RAISE EXCEPTION 'No se pudo generar un código de vinculación';
END $$;

-- ── 6. Reclamar el token de una vinculación ────────────────────────────────
-- Devuelve el token Y borra la fila en la misma transacción: sin ventana en la
-- que el token esté visible en la tabla. Si aún no se ha vinculado (token
-- NULL) no borra nada y devuelve NULL, para que el player siga esperando.
CREATE OR REPLACE FUNCTION claim_pairing_token(p_code text)
  RETURNS text LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public AS $$
DECLARE v_token text;
BEGIN
  DELETE FROM device_pairings
   WHERE code = upper(p_code) AND token IS NOT NULL
  RETURNING token INTO v_token;
  RETURN v_token;
END $$;

-- ── Permisos ───────────────────────────────────────────────────────────────
-- El player no tiene sesión: estas funciones son su única puerta.
REVOKE ALL ON FUNCTION get_player_payload(text, text)      FROM public;
REVOKE ALL ON FUNCTION player_heartbeat(text, text)        FROM public;
REVOKE ALL ON FUNCTION player_ack_reset(text)              FROM public;
REVOKE ALL ON FUNCTION player_log_events(text, jsonb)      FROM public;
REVOKE ALL ON FUNCTION create_pairing_code()               FROM public;
REVOKE ALL ON FUNCTION claim_pairing_token(text)           FROM public;

GRANT EXECUTE ON FUNCTION get_player_payload(text, text)   TO anon, authenticated;
GRANT EXECUTE ON FUNCTION player_heartbeat(text, text)     TO anon, authenticated;
GRANT EXECUTE ON FUNCTION player_ack_reset(text)           TO anon, authenticated;
GRANT EXECUTE ON FUNCTION player_log_events(text, jsonb)   TO anon, authenticated;
GRANT EXECUTE ON FUNCTION create_pairing_code()            TO anon, authenticated;
GRANT EXECUTE ON FUNCTION claim_pairing_token(text)        TO anon, authenticated;
