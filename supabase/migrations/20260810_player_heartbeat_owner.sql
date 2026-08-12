-- HEARTBEAT QUE DEVUELVE EL ESTADO DE PROPIEDAD
--
-- El player Android detecta que dejó de ser dueño de la pantalla aprovechando
-- el heartbeat: el UPDATE lleva Prefer: return=representation, así que la fila
-- vuelve y leer device_fingerprint cuesta CERO peticiones extra. Con
-- player_heartbeat devolviendo void, esa detección se perdía y habría que
-- esperar al siguiente ciclo de get_player_payload.
--
-- Se devuelve un booleano calculado en el servidor y NO la huella: quien tiene
-- el token está autorizado sobre esa pantalla, pero no necesita conocer el
-- identificador del dispositivo que se la quedó.
--
-- Cambiar el tipo de retorno obliga a DROP: CREATE OR REPLACE falla con
-- "cannot change return type of existing function". Y al añadir p_session la
-- firma cambia igualmente, así que el DROP es necesario por partida doble.

DROP FUNCTION IF EXISTS player_heartbeat(text, text);

CREATE OR REPLACE FUNCTION player_heartbeat(
  p_token       text,
  p_app_version text DEFAULT NULL,
  p_session     text DEFAULT NULL
)
  RETURNS jsonb LANGUAGE sql SECURITY DEFINER
  SET search_path = public AS $$
  UPDATE screens
     SET last_heartbeat = now(),
         app_version    = COALESCE(p_app_version, app_version)
   WHERE device_token::text = p_token
  RETURNING jsonb_build_object(
    -- owner solo tiene sentido si el cliente manda su sesión; el player web de
    -- React no la manda y tampoco lee la respuesta.
    'owner',     (p_session IS NOT NULL AND device_fingerprint IS NOT DISTINCT FROM p_session),
    'has_owner', (device_fingerprint IS NOT NULL)
  );
$$;

REVOKE ALL     ON FUNCTION player_heartbeat(text, text, text) FROM public;
GRANT  EXECUTE ON FUNCTION player_heartbeat(text, text, text) TO anon, authenticated;
