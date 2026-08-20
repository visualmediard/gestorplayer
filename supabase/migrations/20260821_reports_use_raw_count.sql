-- EL REPORTE PASA A MOSTRAR EL CONTEO REAL, NO LOS IMPACTOS DEL PROVEEDOR
--
-- Hasta aquí el titular sumaba total_impacts: el conteo ya multiplicado por el
-- factor de ocupación de DataVisiooh (auto ×3, autobús ×30, camión ×2). Ahora
-- suma el conteo bruto: los vehículos y peatones que pasaron de verdad.
--
-- Efecto secundario bueno: el reporte deja de ser incoherente en unidades. Las
-- barras del desglose YA mostraban conteo bruto, así que el titular era ~4×
-- mayor que la suma de las barras que tenía debajo. Ahora el total es
-- exactamente esa suma.
--
-- Se usa COALESCE(total_count, <suma de las columnas de tipo>) y no total_count
-- a secas porque la columna es nullable: hoy todas las filas la traen (las
-- escribe la sincronización), pero una importación de Excel antigua podría
-- dejarla vacía y entonces ese día restaría cero al total en silencio. La suma
-- de columnas es la misma cifra, calculada de otra forma, como red.
--
-- Cambian los CUATRO sitios --dos por función-- porque el total y el desglose
-- por emplazamiento tienen que hablar de lo mismo.
--
-- NOTA: la clave del JSON sigue llamándose 'impacts' a propósito. Renombrarla
-- obligaría a tocar los dos reportes y sus tipos en el mismo movimiento, y el
-- nombre no se muestra a nadie. Lo que ve el cliente es la etiqueta del
-- frontend, que pasa a "Público alcanzado".

-- ── Campaña ───────────────────────────────────────────────────────────────
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
    SELECT DISTINCT pe.zone_id, pe.screen_id,
           (pe.played_at AT TIME ZONE 'America/Santo_Domingo')::date AS day
      FROM playback_events pe
      JOIN media_content mc ON mc.id = pe.content_id
     WHERE mc.campaign_id = p_campaign_id
       AND pe.played_at >= p_from
       AND pe.played_at <  p_to
  ),
  plays AS (
    SELECT pe.zone_id,
           (pe.played_at AT TIME ZONE 'America/Santo_Domingo')::date AS day,
           SUM(COALESCE(pe.count, 1))::bigint AS plays
      FROM playback_events pe
      JOIN media_content mc ON mc.id = pe.content_id
     WHERE mc.campaign_id = p_campaign_id
       AND pe.played_at >= p_from
       AND pe.played_at <  p_to
     GROUP BY 1, 2
  ),
  -- La intersección: día con reproducción Y con aforo.
  matched AS (
    SELECT pd.zone_id, pd.screen_id, pd.day,
           -- El conteo real del día. Sustituye a tc.total_impacts.
           COALESCE(tc.total_count,
                    COALESCE(tc.pedestrians,0) + COALESCE(tc.cars,0) +
                    COALESCE(tc.trucks,0)      + COALESCE(tc.buses,0) +
                    COALESCE(tc.bikes,0)       + COALESCE(tc.motorcycles,0)
           ) AS real_count,
           tc.pedestrians, tc.cars, tc.trucks, tc.buses, tc.bikes, tc.motorcycles,
           COALESCE(p.plays, 0) AS plays
      FROM play_days pd
      JOIN traffic_counts tc ON tc.zone_id = pd.zone_id AND tc.date = pd.day
      LEFT JOIN plays p ON p.zone_id = pd.zone_id AND p.day = pd.day
  ),
  by_zone AS (
    SELECT m.zone_id, z.name AS zone_name, s.name AS screen_name,
           COUNT(DISTINCT m.day)::int AS days_counted,
           SUM(m.real_count)::bigint  AS impacts,
           SUM(m.plays)::bigint       AS plays
      FROM matched m
           JOIN zones z   ON z.id = m.zone_id
           JOIN screens s ON s.id = m.screen_id
     GROUP BY m.zone_id, z.name, s.name
  )
  SELECT jsonb_build_object(
    -- Cobertura: días contados frente a días en que el anuncio salió. Se
    -- muestra SIEMPRE, también cuando es total: cuando cubre todo es argumento
    -- de venta, y estar siempre evita que el cliente desconfíe al verlo.
    'days_counted',   (SELECT COUNT(*)::int FROM (SELECT DISTINCT day FROM matched) d),
    'days_with_plays',(SELECT COUNT(*)::int FROM (SELECT DISTINCT day FROM play_days) d),
    'impacts',        COALESCE((SELECT SUM(real_count)::bigint FROM matched), 0),
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
               'screen_name', screen_name || ' · ' || zone_name,
               'days', days_counted,
               'impacts', impacts, 'plays', plays) ORDER BY impacts DESC)
        FROM by_zone), '[]'::jsonb)
  );
$$;

REVOKE ALL     ON FUNCTION campaign_traffic_impacts(uuid, timestamptz, timestamptz) FROM public, anon;
GRANT  EXECUTE ON FUNCTION campaign_traffic_impacts(uuid, timestamptz, timestamptz) TO authenticated;

-- ── Anuncio individual ────────────────────────────────────────────────────
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
    SELECT pd.zone_id, pd.screen_id, pd.day,
           COALESCE(tc.total_count,
                    COALESCE(tc.pedestrians,0) + COALESCE(tc.cars,0) +
                    COALESCE(tc.trucks,0)      + COALESCE(tc.buses,0) +
                    COALESCE(tc.bikes,0)       + COALESCE(tc.motorcycles,0)
           ) AS real_count,
           tc.pedestrians, tc.cars, tc.trucks, tc.buses, tc.bikes, tc.motorcycles,
           COALESCE(p.plays, 0) AS plays
      FROM play_days pd
      JOIN traffic_counts tc ON tc.zone_id = pd.zone_id AND tc.date = pd.day
      LEFT JOIN plays p ON p.zone_id = pd.zone_id AND p.day = pd.day
  ),
  by_zone AS (
    SELECT m.zone_id, z.name AS zone_name, s.name AS screen_name,
           COUNT(DISTINCT m.day)::int AS days_counted,
           SUM(m.real_count)::bigint  AS impacts,
           SUM(m.plays)::bigint       AS plays
      FROM matched m
           JOIN zones z   ON z.id = m.zone_id
           JOIN screens s ON s.id = m.screen_id
     GROUP BY m.zone_id, z.name, s.name
  )
  SELECT jsonb_build_object(
    'days_counted',    (SELECT COUNT(*)::int FROM (SELECT DISTINCT day FROM matched) d),
    'days_with_plays', (SELECT COUNT(*)::int FROM (SELECT DISTINCT day FROM play_days) d),
    'impacts',         COALESCE((SELECT SUM(real_count)::bigint FROM matched), 0),
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

-- ── Comprobación ─────────────────────────────────────────────────────────
-- El titular debe pasar a coincidir con la suma del desglose:
--   SELECT (r->>'impacts')::bigint AS titular,
--          (SELECT SUM(v::bigint) FROM jsonb_each_text(r->'breakdown') AS e(k,v)) AS suma_barras
--     FROM content_traffic_impacts(
--            'CARDIO_RV PUENTE DIGITAL_03_1100x360px 22.mp4',
--            '2026-08-12'::timestamptz, '2026-08-19'::timestamptz) AS r;
