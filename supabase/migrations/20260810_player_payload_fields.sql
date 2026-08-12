-- AMPLIAR get_player_payload CON LOS CAMPOS QUE USA EL PLAYER ANDROID
--
-- El payload de 20260810_player_rpcs se diseñó mirando ScreenStage.tsx, y el
-- player React usa menos campos que el Android. Faltan los que sostienen dos
-- funcionalidades que solo existen en el bundle Android:
--
--   · daily_frequency / is_unlimited  → tope de repeticiones al día, tanto de
--     un contenido suelto como de una sub-playlist completa
--   · schedule_days / schedule_start / schedule_end → programación horaria por
--     contenido (20260719_add_content_scheduling)
--
-- Sin ellos el APK reproduciría todo sin límite y sin respetar horarios, y no
-- daría ningún error: solo se comportaría mal.
--
-- También se añaden `name` y `sub_playlist_id` de media_content y `name` de
-- sub_playlists, que el player usa en su panel de diagnóstico.
--
-- La firma NO cambia, así que no hace falta DROP: CREATE OR REPLACE basta y no
-- se crea una sobrecarga. El player React ignora los campos de más.

CREATE OR REPLACE FUNCTION get_player_payload(
  p_token      text,
  p_session    text        DEFAULT NULL,
  p_had_claim  boolean     DEFAULT false,
  p_claimed_at timestamptz DEFAULT NULL
)
  RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public AS $$
DECLARE
  v_screen screens%ROWTYPE;
  v_stale  boolean;
BEGIN
  IF p_token IS NULL OR p_token !~
     '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN
    RETURN jsonb_build_object('status', 'invalid');
  END IF;

  SELECT * INTO v_screen FROM screens WHERE device_token = p_token::uuid;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'invalid');
  END IF;

  -- Liberación persistente: sobrevive a que el player se reiniciara.
  IF v_screen.released_at IS NOT NULL
     AND (p_claimed_at IS NULL OR p_claimed_at <= v_screen.released_at) THEN
    RETURN jsonb_build_object('status', 'released');
  END IF;

  IF p_session IS NOT NULL AND p_session <> '' THEN

    IF p_had_claim AND v_screen.device_fingerprint IS DISTINCT FROM p_session THEN
      IF v_screen.device_fingerprint IS NULL THEN
        RETURN jsonb_build_object('status', 'released');
      ELSE
        RETURN jsonb_build_object('status', 'taken');
      END IF;
    END IF;

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
    'zones', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', z.id, 'name', z.name,
          'x', z.x, 'y', z.y, 'width', z.width, 'height', z.height,
          'background_color', z.background_color, 'fit_mode', z.fit_mode,
          'sort_order', z.sort_order,
          'items', COALESCE((
            SELECT jsonb_agg(to_jsonb(m) ORDER BY m.sort_order)
              FROM (SELECT mc.id, mc.name, mc.type, mc.storage_path, mc.url,
                           mc.duration_seconds, mc.expires_at, mc.not_before,
                           mc.sort_order, mc.sub_playlist_id,
                           mc.daily_frequency, mc.is_unlimited,
                           mc.schedule_days, mc.schedule_start, mc.schedule_end
                      FROM media_content mc
                     WHERE mc.zone_id = z.id
                       AND mc.sub_playlist_id IS NULL
                       AND mc.archived_at IS NULL) m), '[]'::jsonb),
          'subs', COALESCE((
            SELECT jsonb_agg(
                     jsonb_build_object(
                       'id', sp.id, 'name', sp.name, 'sort_order', sp.sort_order,
                       'daily_frequency', sp.daily_frequency,
                       'is_unlimited', sp.is_unlimited,
                       'items', COALESCE((
                         SELECT jsonb_agg(to_jsonb(m2) ORDER BY m2.sort_order)
                           FROM (SELECT mc2.id, mc2.name, mc2.type,
                                        mc2.storage_path, mc2.url,
                                        mc2.duration_seconds, mc2.expires_at,
                                        mc2.not_before, mc2.sort_order,
                                        mc2.sub_playlist_id,
                                        mc2.daily_frequency, mc2.is_unlimited,
                                        mc2.schedule_days, mc2.schedule_start,
                                        mc2.schedule_end
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

REVOKE ALL ON FUNCTION get_player_payload(text, text, boolean, timestamptz) FROM public;
GRANT EXECUTE ON FUNCTION get_player_payload(text, text, boolean, timestamptz)
  TO anon, authenticated;
