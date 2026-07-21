-- BATCHING DE REPRODUCCIONES
--
-- Los players dejan de hacer un INSERT por reproducción: acumulan en memoria
-- y envían UN lote cada 10 minutos. Cada fila puede representar N
-- reproducciones del mismo contenido en la misma zona (columna count).
--
-- Compatibilidad: las filas históricas y las de players con APK viejo quedan
-- con count=1 (DEFAULT), por lo que los totales no cambian. Correr esta
-- migración ANTES de instalar el APK nuevo.
--
-- Solo content_stats y screen_content_counts agregan desde playback_events;
-- campaign_stats y campaign_zone_detail leen de content_stats y no cambian.

ALTER TABLE playback_events
  ADD COLUMN IF NOT EXISTS count integer NOT NULL DEFAULT 1;

-- ── content_stats: COUNT(*) → SUM(count) ───────────────────────────────
-- Misma estructura, orden y tipos de columnas que la vista original
-- (requisito de CREATE OR REPLACE y de las vistas dependientes).
CREATE OR REPLACE VIEW public.content_stats WITH (security_invoker = on) AS
 SELECT mc.id AS content_id,
    mc.name,
    mc.type,
    mc.storage_path,
    z.id AS zone_id,
    z.name AS zone_name,
    p.id AS program_id,
    p.name AS program_name,
    p.organization_id,
    (COALESCE(sum(pe.count), 0))::bigint AS total_reproductions,
    (COALESCE(sum(pe.count) FILTER (WHERE pe.played_at::date = (now() AT TIME ZONE 'America/Santo_Domingo'::text)::date), 0))::bigint AS today_reproductions,
    max(pe.played_at) AS last_reproduction
   FROM media_content mc
     JOIN zones z ON z.id = mc.zone_id
     JOIN programs p ON p.id = z.program_id
     LEFT JOIN playback_events pe ON pe.content_id = mc.id
  GROUP BY mc.id, mc.name, mc.type, mc.storage_path, z.id, z.name, p.id, p.name, p.organization_id;

-- ── screen_content_counts: COUNT(*) → SUM(count) ───────────────────────
CREATE OR REPLACE VIEW public.screen_content_counts WITH (security_invoker = on) AS
 SELECT pe.screen_id,
    pe.content_id,
    (COALESCE(sum(pe.count), 0))::bigint AS total_plays,
    max(pe.played_at) AS last_played_at
   FROM playback_events pe
     JOIN screens s ON s.id = pe.screen_id
     JOIN programs p ON p.id = s.current_program_id
  WHERE pe.played_at >= COALESCE(p.published_at, '2000-01-01 00:00:00+00'::timestamp with time zone)
  GROUP BY pe.screen_id, pe.content_id;
