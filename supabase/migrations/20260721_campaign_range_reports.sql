-- REPORTE DE CAMPAÑA POR RANGO DE FECHAS
--
-- El reporte de campaña sacaba sus totales de la vista campaign_zone_detail
-- (→ content_stats), que agrega TODO el historial sin filtro de fecha. Para
-- poder acotar por rango se agregan dos funciones que consultan
-- playback_events directamente, aprovechando el índice de played_at.
--
-- Agregan en el servidor (devuelven ~30 filas en vez de decenas de miles),
-- evitando el límite de 1000 filas de PostgREST y el tráfico innecesario.
--
-- SUM(count) — no COUNT(*) — porque con el batching una fila representa N
-- reproducciones.
--
-- SECURITY INVOKER (por defecto): las funciones corren con los permisos del
-- usuario que llama, así que el RLS de playback_events/media_content aplica
-- y cada organización solo ve lo suyo.

-- ── Reproducciones por día ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION campaign_daily_plays(
  p_campaign_id uuid,
  p_from        timestamptz,
  p_to          timestamptz
)
RETURNS TABLE (day date, plays bigint)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT (pe.played_at AT TIME ZONE 'America/Santo_Domingo')::date AS day,
         SUM(pe.count)::bigint                                     AS plays
    FROM playback_events pe
    JOIN media_content  mc ON mc.id = pe.content_id
   WHERE mc.campaign_id = p_campaign_id
     AND pe.played_at  >= p_from
     AND pe.played_at  <  p_to
   GROUP BY 1
   ORDER BY 1;
$$;

-- ── Reproducciones por pantalla y zona ─────────────────────────────────
CREATE OR REPLACE FUNCTION campaign_screen_plays(
  p_campaign_id uuid,
  p_from        timestamptz,
  p_to          timestamptz
)
RETURNS TABLE (screen_name text, zone_name text, plays bigint)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT COALESCE(s.name, '—')   AS screen_name,
         COALESCE(z.name, '—')   AS zone_name,
         SUM(pe.count)::bigint   AS plays
    FROM playback_events pe
    JOIN media_content  mc ON mc.id = pe.content_id
    LEFT JOIN zones     z  ON z.id  = pe.zone_id
    LEFT JOIN screens   s  ON s.id  = pe.screen_id
   WHERE mc.campaign_id = p_campaign_id
     AND pe.played_at  >= p_from
     AND pe.played_at  <  p_to
   GROUP BY 1, 2
   ORDER BY 3 DESC;
$$;

REVOKE ALL     ON FUNCTION campaign_daily_plays(uuid, timestamptz, timestamptz)  FROM public, anon;
REVOKE ALL     ON FUNCTION campaign_screen_plays(uuid, timestamptz, timestamptz) FROM public, anon;
GRANT  EXECUTE ON FUNCTION campaign_daily_plays(uuid, timestamptz, timestamptz)  TO authenticated;
GRANT  EXECUTE ON FUNCTION campaign_screen_plays(uuid, timestamptz, timestamptz) TO authenticated;
