-- EL HEARTBEAT REFRESCA last_seen_at, Y SOLO SI QUIEN LATE ES EL DUEÑO
--
-- Hasta ahora last_seen_at lo refrescaba startDeviceSeenWatch con un UPDATE
-- directo cada 5 min. Al cerrar las tablas al rol anónimo (fase 5) ese UPDATE
-- dejará de funcionar, y last_seen_at solo se tocaría en startPlayer y en
-- softResync: pasados 90 s el servidor daría al dueño por muerto y otra sesión
-- podría quedarse con la pantalla estando esta perfectamente viva.
--
-- La condición del CASE no es cosmética. Si una sesión que NO es la dueña
-- pudiera refrescar last_seen_at, un equipo muerto no quedaría obsoleto nunca
-- y retendría la pantalla indefinidamente: ningún relevo legítimo podría
-- tomarla. El refresco significa "el dueño sigue vivo", no "llegó un heartbeat".
--
-- En un UPDATE, device_fingerprint a la derecha del SET es el valor ANTERIOR,
-- que es justo con el que hay que comparar.
--
-- Firma y tipo de retorno no cambian: CREATE OR REPLACE basta, sin DROP.

CREATE OR REPLACE FUNCTION player_heartbeat(
  p_token       text,
  p_app_version text DEFAULT NULL,
  p_session     text DEFAULT NULL
)
  RETURNS jsonb LANGUAGE sql SECURITY DEFINER
  SET search_path = public AS $$
  UPDATE screens
     SET last_heartbeat = now(),
         app_version    = COALESCE(p_app_version, app_version),
         last_seen_at   = CASE
           WHEN p_session IS NOT NULL
                AND device_fingerprint IS NOT DISTINCT FROM p_session
           THEN now()
           ELSE last_seen_at
         END
   WHERE device_token::text = p_token
  RETURNING jsonb_build_object(
    'owner',     (p_session IS NOT NULL AND device_fingerprint IS NOT DISTINCT FROM p_session),
    'has_owner', (device_fingerprint IS NOT NULL)
  );
$$;

REVOKE ALL     ON FUNCTION player_heartbeat(text, text, text) FROM public;
GRANT  EXECUTE ON FUNCTION player_heartbeat(text, text, text) TO anon, authenticated;
