-- IMPACTOS ESTIMADOS DE UNA CAMPAÑA
--
-- Cruza las reproducciones reales con el aforo del emplazamiento. Es la
-- métrica que se le vende al anunciante: no "salió 1.240 veces", sino "alcanzó
-- a 287.412 personas".
--
-- Dos reglas que definen el número, y ambas son deliberadas:
--
--   1. Las pantallas salen de playback_events, NO de la asignación de programa.
--      Los impactos solo cuentan donde el anuncio salió de verdad.
--
--   2. Solo cuentan los días que tienen AMBAS cosas: reproducción de esta
--      campaña Y aforo importado. Si la campaña corrió 20 días y el conteo
--      llega al 12, se reportan 12. Devolver el total del archivo daría a
--      entender una cobertura que no existe, y es justo lo que un cliente
--      puede desmontar.
--
-- El desglose por tipo de vehículo suma esos mismos días contados, para que
-- cuadre con el titular. No coincidirá con el Excel original si la campaña no
-- cubre todo el periodo importado: es correcto y es lo coherente.
--
-- total_impacts nunca se recalcula: viene del proveedor de conteo y ahí está
-- su valor probatorio.

CREATE OR REPLACE FUNCTION campaign_traffic_impacts(
  p_campaign_id uuid,
  p_from        timestamptz,
  p_to          timestamptz
)
  RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER
  SET search_path = public AS $$
  -- Los días se calculan en hora local de RD, no en la del servidor: el aforo
  -- del proveedor viene en fechas locales, así que agrupar en UTC metería las
  -- reproducciones de la noche en el día siguiente y el cruce fallaría por un
  -- día. AT TIME ZONE convierte explícitamente, sin depender de cómo esté
  -- configurado el servidor.
  WITH play_days AS (
    -- Días en que ESTA campaña se reprodujo, por pantalla.
    -- SECURITY INVOKER: el RLS del usuario ya acota a su organización.
    SELECT DISTINCT pe.screen_id, (pe.played_at AT TIME ZONE 'America/Santo_Domingo')::date AS day
      FROM playback_events pe
      JOIN media_content mc ON mc.id = pe.content_id
     WHERE mc.campaign_id = p_campaign_id
       AND pe.played_at >= p_from
       AND pe.played_at <  p_to
  ),
  plays AS (
    SELECT pe.screen_id, (pe.played_at AT TIME ZONE 'America/Santo_Domingo')::date AS day, SUM(COALESCE(pe.count, 1))::bigint AS plays
      FROM playback_events pe
      JOIN media_content mc ON mc.id = pe.content_id
     WHERE mc.campaign_id = p_campaign_id
       AND pe.played_at >= p_from
       AND pe.played_at <  p_to
     GROUP BY 1, 2
  ),
  -- La intersección: día con reproducción Y con aforo.
  matched AS (
    SELECT pd.screen_id, pd.day, tc.total_impacts, tc.total_count,
           tc.pedestrians, tc.cars, tc.trucks, tc.buses, tc.bikes, tc.motorcycles,
           COALESCE(p.plays, 0) AS plays
      FROM play_days pd
      JOIN traffic_counts tc ON tc.screen_id = pd.screen_id AND tc.date = pd.day
      LEFT JOIN plays p ON p.screen_id = pd.screen_id AND p.day = pd.day
  ),
  by_screen AS (
    SELECT m.screen_id, s.name AS screen_name,
           COUNT(*)::int              AS days_counted,
           SUM(m.total_impacts)::bigint AS impacts,
           SUM(m.plays)::bigint         AS plays
      FROM matched m JOIN screens s ON s.id = m.screen_id
     GROUP BY m.screen_id, s.name
  )
  SELECT jsonb_build_object(
    -- Cobertura: días contados frente a días en que el anuncio salió. Se
    -- muestra SIEMPRE, también cuando es total: cuando cubre todo es argumento
    -- de venta, y estar siempre evita que el cliente desconfíe al verlo.
    'days_counted',   (SELECT COUNT(*)::int FROM (SELECT DISTINCT day FROM matched) d),
    'days_with_plays',(SELECT COUNT(*)::int FROM (SELECT DISTINCT day FROM play_days) d),
    'impacts',        COALESCE((SELECT SUM(total_impacts)::bigint FROM matched), 0),
    'plays',          COALESCE((SELECT SUM(plays)::bigint FROM matched), 0),
    'breakdown', jsonb_build_object(
      'pedestrians', COALESCE((SELECT SUM(pedestrians)::bigint  FROM matched), 0),
      'cars',        COALESCE((SELECT SUM(cars)::bigint         FROM matched), 0),
      'trucks',      COALESCE((SELECT SUM(trucks)::bigint       FROM matched), 0),
      'buses',       COALESCE((SELECT SUM(buses)::bigint        FROM matched), 0),
      'bikes',       COALESCE((SELECT SUM(bikes)::bigint        FROM matched), 0),
      'motorcycles', COALESCE((SELECT SUM(motorcycles)::bigint  FROM matched), 0)
    ),
    'by_screen', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'screen_name', screen_name, 'days', days_counted,
               'impacts', impacts, 'plays', plays) ORDER BY impacts DESC)
        FROM by_screen), '[]'::jsonb)
  );
$$;

REVOKE ALL     ON FUNCTION campaign_traffic_impacts(uuid, timestamptz, timestamptz) FROM public, anon;
GRANT  EXECUTE ON FUNCTION campaign_traffic_impacts(uuid, timestamptz, timestamptz) TO authenticated;
