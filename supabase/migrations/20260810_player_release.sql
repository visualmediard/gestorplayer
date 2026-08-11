-- LIBERAR PANTALLA: QUE EL PLAYER SE ENTERE
--
-- Al mover el device locking al servidor (20260810_player_rpcs) se perdió la
-- detección de "me liberaron". El servidor no recuerda quién era el dueño, así
-- que al ver device_fingerprint = NULL lo interpreta como "libre" y RE-RECLAMA
-- la pantalla para la misma sesión: el player nunca se entera y sigue
-- reproduciendo.
--
-- Se arregla por dos vías complementarias:
--
--   1. p_had_claim: el cliente afirma que él era el dueño. Permite distinguir
--      "me liberaron del panel" (fingerprint NULL) de "otra sesión me superó"
--      (fingerprint distinto). Solo funciona con el TV encendido.
--
--   2. released_at: marca en la propia pantalla. Sobrevive a que el TV esté
--      apagado durante la liberación, que es el caso real —liberar para mover
--      la pantalla a otro local, apagándola antes de moverla—. Sin esto, al
--      encenderla en el sitio nuevo se re-reclamaría sola con el token viejo.
--
-- p_had_claim y p_claimed_at los manda el cliente, pero mentir no da nada:
-- decir que no eras dueño equivale a reclamar normalmente, y decir que sí lo
-- eras solo consigue que ese mismo cliente se detenga.

-- ── 1. Marca de liberación ─────────────────────────────────────────────────
ALTER TABLE screens ADD COLUMN IF NOT EXISTS released_at timestamptz;

-- ── 2. Liberar deja constancia ─────────────────────────────────────────────
-- Mismo guard de organización que traía de 20260720_security_hardening.
CREATE OR REPLACE FUNCTION release_screen_device(p_screen_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$
BEGIN
  UPDATE screens s
     SET device_fingerprint = NULL,
         last_seen_at        = NULL,
         released_at         = now()
   WHERE s.id = p_screen_id
     AND s.organization_id = (
       SELECT p.organization_id FROM profiles p WHERE p.id = auth.uid()
     );
END $$;

REVOKE ALL     ON FUNCTION release_screen_device(uuid) FROM public, anon;
GRANT  EXECUTE ON FUNCTION release_screen_device(uuid) TO authenticated;

-- ── 3. Vincular limpia la marca ────────────────────────────────────────────
-- Imprescindible: si no, el dispositivo NUEVO al que se asigne la pantalla
-- recibiría 'released' indefinidamente (nunca reclamó, así que su claim es
-- "anterior" a la liberación) y no podría arrancar nunca.
CREATE OR REPLACE FUNCTION pair_screen_by_code(p_code text, p_screen_id uuid)
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public AS $$
DECLARE
  v_token text;
BEGIN
  IF current_user_role() <> 'admin' THEN
    RAISE EXCEPTION 'Solo un administrador puede vincular pantallas';
  END IF;

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

  -- La pantalla vuelve a estar asignada: se levanta la marca de liberación.
  UPDATE screens SET released_at = NULL WHERE id = p_screen_id;
END $$;

GRANT EXECUTE ON FUNCTION pair_screen_by_code(text, uuid) TO authenticated;

-- ── 4. get_player_payload con detección de liberación ──────────────────────
-- Añadir parámetros CREA UNA SOBRECARGA en vez de reemplazar: hay que borrar
-- la firma vieja o PostgREST vería dos funciones con el mismo nombre.
DROP FUNCTION IF EXISTS get_player_payload(text, text);

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

  -- ── Liberación persistente (vía 2) ───────────────────────────────────────
  -- Va ANTES que cualquier lógica de claim: es la única comprobación que
  -- sobrevive a que el player se haya reiniciado y perdido su memoria.
  IF v_screen.released_at IS NOT NULL
     AND (p_claimed_at IS NULL OR p_claimed_at <= v_screen.released_at) THEN
    RETURN jsonb_build_object('status', 'released');
  END IF;

  IF p_session IS NOT NULL AND p_session <> '' THEN

    -- ── Perdí la propiedad estando encendido (vía 1) ───────────────────────
    IF p_had_claim AND v_screen.device_fingerprint IS DISTINCT FROM p_session THEN
      IF v_screen.device_fingerprint IS NULL THEN
        -- Liberada desde el panel: el player borra su token y vuelve al QR.
        RETURN jsonb_build_object('status', 'released');
      ELSE
        -- Otra sesión se quedó con la pantalla (p. ej. este equipo estuvo
        -- suspendido más de 90 s). Se detiene, pero CONSERVA el token: si no,
        -- un portátil que duerme un rato perdería su emparejamiento.
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

REVOKE ALL ON FUNCTION get_player_payload(text, text, boolean, timestamptz) FROM public;
GRANT EXECUTE ON FUNCTION get_player_payload(text, text, boolean, timestamptz)
  TO anon, authenticated;
