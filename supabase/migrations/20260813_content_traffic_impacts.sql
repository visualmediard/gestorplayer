-- IMPACTOS ESTIMADOS DE UN ANUNCIO INDIVIDUAL
--
-- Gemela de campaign_traffic_impacts, para el reporte de contenido. Hace falta
-- porque no todo lo que se reproduce pertenece a una campaña: hay anuncios
-- sueltos en la biblioteca, y su reporte merece la misma métrica.
--
-- El contenido se identifica por NOMBRE, igual que hace ContentReport: un
-- mismo archivo puede existir como varias filas de media_content (biblioteca,
-- y una copia por zona o campaña), y todas comparten el nombre.
--
-- Mismas dos reglas que la versión de campaña:
--   1. Las pantallas salen de playback_events, no de la asignación de programa
--   2. Solo cuentan los días con reproducción Y aforo importado
--
-- Los días se agrupan en hora local de RD: el aforo del proveedor viene en
-- fechas locales, y agrupar en UTC metería las reproducciones de la noche en
-- el día siguiente.
--
-- SECURITY INVOKER: el RLS del usuario acota a su organización, así que el
-- nombre no puede usarse para leer contenido ajeno.

CREATE OR REPLACE FUNCTION content_traffic_impacts(
  p_name text,
  p_from timestamptz,
  p_to   timestamptz
)
  RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER
  SET search_path = public AS $$
  WITH play_days AS (
    SELECT DISTINCT pe.zone_id, pe.screen_id,
           (pe.played_at AT TIME ZONE 'America/Santo_Domingo')::date AS day
      FROM playback_events pe
      JOIN media_content mc ON mc.id = pe.content_id
     WHERE mc.name = p_name
       AND pe.played_at >= p_from
       AND pe.played_at <  p_to
  ),
  plays AS (
    SELECT pe.zone_id,
           (pe.played_at AT TIME ZONE 'America/Santo_Domingo')::date AS day,
           SUM(COALESCE(pe.count, 1))::bigint AS plays
      FROM playback_events pe
      JOIN media_content mc ON mc.id = pe.content_id
     WHERE mc.name = p_name
       AND pe.played_at >= p_from
       AND pe.played_at <  p_to
     GROUP BY 1, 2
  ),
  matched AS (
    SELECT pd.zone_id, pd.screen_id, pd.day, tc.total_impacts,
           tc.pedestrians, tc.cars, tc.trucks, tc.buses, tc.bikes, tc.motorcycles,
           COALESCE(p.plays, 0) AS plays
      FROM play_days pd
      JOIN traffic_counts tc ON tc.zone_id = pd.zone_id AND tc.date = pd.day
      LEFT JOIN plays p ON p.zone_id = pd.zone_id AND p.day = pd.day
  ),
  by_zone AS (
    SELECT m.zone_id, z.name AS zone_name, s.name AS screen_name,
           COUNT(DISTINCT m.day)::int   AS days_counted,
           SUM(m.total_impacts)::bigint AS impacts,
           SUM(m.plays)::bigint         AS plays
      FROM matched m
           JOIN zones z   ON z.id = m.zone_id
           JOIN screens s ON s.id = m.screen_id
     GROUP BY m.zone_id, z.name, s.name
  )
  SELECT jsonb_build_object(
    'days_counted',    (SELECT COUNT(*)::int FROM (SELECT DISTINCT day FROM matched) d),
    'days_with_plays', (SELECT COUNT(*)::int FROM (SELECT DISTINCT day FROM play_days) d),
    'impacts',         COALESCE((SELECT SUM(total_impacts)::bigint FROM matched), 0),
    'plays',           COALESCE((SELECT SUM(plays)::bigint FROM matched), 0),
    'breakdown', jsonb_build_object(
      'pedestrians', COALESCE((SELECT SUM(pedestrians)::bigint FROM matched), 0),
      'cars',        COALESCE((SELECT SUM(cars)::bigint        FROM matched), 0),
      'trucks',      COALESCE((SELECT SUM(trucks)::bigint      FROM matched), 0),
      'buses',       COALESCE((SELECT SUM(buses)::bigint       FROM matched), 0),
      'bikes',       COALESCE((SELECT SUM(bikes)::bigint       FROM matched), 0),
      'motorcycles', COALESCE((SELECT SUM(motorcycles)::bigint FROM matched), 0)
    ),
    'by_screen', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'screen_name', screen_name || ' · ' || zone_name,
               'days', days_counted,
               'impacts', impacts, 'plays', plays) ORDER BY impacts DESC)
        FROM by_zone), '[]'::jsonb)
  );
$$;

REVOKE ALL     ON FUNCTION content_traffic_impacts(text, timestamptz, timestamptz) FROM public, anon;
GRANT  EXECUTE ON FUNCTION content_traffic_impacts(text, timestamptz, timestamptz) TO authenticated;
