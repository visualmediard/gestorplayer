-- CONTEOS DIARIOS POR CONTENIDO PARA EL PLAYER
--
-- El player Android limita cuántas veces se reproduce cada contenido al día
-- (dailyCounts / lastPlayedAt). Hoy lee la vista screen_content_counts
-- directamente, filtrando por screen_id que le pasa el cliente. Es la última
-- lectura directa que le quedaría al player anónimo tras migrar a las RPCs.
--
-- Esta función no existía entre las 6 de 20260810_player_rpcs porque el player
-- web de React no usa el tope diario: esa funcionalidad solo está en Android.
--
-- RETURNS SETOF screen_content_counts a propósito, en vez de declarar las
-- columnas una por una: así hereda el tipo exacto de la vista y no hay riesgo
-- de que un int/bigint mal declarado reviente en ejecución. El cliente ya
-- selecciona los campos que necesita (content_id, total_plays, last_played_at).
--
-- La vista está marcada security_invoker = on (20260720_security_hardening),
-- pero dentro de esta función corre como su dueño, así que ve los datos sin
-- que el rol anónimo necesite permiso sobre las tablas de debajo. El token es
-- lo único que decide qué pantalla se consulta.

CREATE OR REPLACE FUNCTION player_content_counts(p_token text)
  RETURNS SETOF screen_content_counts
  LANGUAGE sql SECURITY DEFINER STABLE
  SET search_path = public AS $$
  SELECT v.*
    FROM screen_content_counts v
   WHERE v.screen_id = (
     SELECT s.id FROM screens s WHERE s.device_token::text = p_token
   );
$$;

REVOKE ALL     ON FUNCTION player_content_counts(text) FROM public;
GRANT  EXECUTE ON FUNCTION player_content_counts(text) TO anon, authenticated;
