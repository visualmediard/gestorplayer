-- PUBLICIDAD DINÁMICA SEGÚN EL CLIMA — modelo de datos
--
-- El anunciante sube varias versiones de una creatividad y la pantalla elige
-- cuál mostrar según el clima real del emplazamiento.
--
-- El clima lo consulta el SERVIDOR (Edge Function → Open-Meteo) y viaja dentro
-- de get_player_payload. El player NO llama a ninguna API externa: sería
-- reabrir por otro lado lo que cerramos al blindar las tablas, y además
-- dejaría la reproducción a merced de que un tercero responda.
--
-- Esta migración solo crea el modelo. La función de refresco y la ampliación
-- del payload van aparte.

-- ── 1. Coordenadas de la pantalla ────────────────────────────────────────
-- Open-Meteo necesita lat/lon. `location` es texto libre y geocodificarlo
-- exigiría otro servicio externo y otra fuente de fallos. Se rellenan a mano
-- una vez por pantalla.
ALTER TABLE screens ADD COLUMN IF NOT EXISTS latitude  numeric(9,6);
ALTER TABLE screens ADD COLUMN IF NOT EXISTS longitude numeric(9,6);

-- ── 2. La condición del anuncio ──────────────────────────────────────────
-- NULL = "da igual". Con las dos nulas, el anuncio es incondicional y se
-- comporta exactamente como hasta ahora: por eso no hace falta backfill.
--
-- Dos columnas y no una porque lluvia y temperatura SE COMBINAN con Y:
-- "con lluvia" a secas es una condición válida, y "calor sin lluvia" también.
ALTER TABLE media_content ADD COLUMN IF NOT EXISTS weather_rain boolean;
ALTER TABLE media_content ADD COLUMN IF NOT EXISTS weather_band text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'media_content_weather_band_check') THEN
    ALTER TABLE media_content
      ADD CONSTRAINT media_content_weather_band_check
      CHECK (weather_band IS NULL OR weather_band IN ('frio', 'templado', 'calor'));
  END IF;
END $$;

-- ── 3. Umbrales, en un solo sitio ────────────────────────────────────────
-- Tabla de UNA fila en vez de constantes en el código: recalibrar las bandas
-- no debería exigir un despliegue. Los valores por defecto están calibrados a
-- República Dominicana.
--
-- Es configuración GLOBAL de la plataforma, no por organización: por eso solo
-- el superadmin la escribe. Si algún día hiciera falta por organización, se
-- añade organization_id y se ajusta la policy.
CREATE TABLE IF NOT EXISTS weather_thresholds (
  id       boolean PRIMARY KEY DEFAULT true CHECK (id),   -- fuerza una sola fila
  cold_max numeric NOT NULL DEFAULT 24,   -- por debajo → 'frio'
  hot_min  numeric NOT NULL DEFAULT 30,   -- por encima → 'calor'
  CHECK (cold_max < hot_min)
);

INSERT INTO weather_thresholds (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

ALTER TABLE weather_thresholds ENABLE ROW LEVEL SECURITY;

-- Lectura para cualquier autenticado: el panel muestra las bandas al elegir la
-- condición de un anuncio.
DROP POLICY IF EXISTS "read weather thresholds" ON weather_thresholds;
CREATE POLICY "read weather thresholds"
  ON weather_thresholds FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "superadmin writes weather thresholds" ON weather_thresholds;
CREATE POLICY "superadmin writes weather thresholds"
  ON weather_thresholds FOR ALL TO authenticated
  USING (is_superadmin()) WITH CHECK (is_superadmin());

REVOKE ALL ON weather_thresholds FROM PUBLIC, anon;
GRANT  SELECT ON weather_thresholds TO authenticated;
GRANT  ALL    ON weather_thresholds TO service_role;

-- ── 4. Caché del clima ───────────────────────────────────────────────────
-- Una fila por PANTALLA, no por coordenada: las zonas son caras del mismo
-- rótulo, comparten ubicación y por tanto clima.
--
-- observed_at es el momento al que se refiere la medición (lo da Open-Meteo);
-- fetched_at es cuándo la trajimos. Se guardan los dos porque el "stale" que
-- decide el fail-safe depende de la antigüedad del DATO, no de la petición.
CREATE TABLE IF NOT EXISTS weather_cache (
  screen_id     uuid PRIMARY KEY REFERENCES screens(id) ON DELETE CASCADE,
  temperature_c numeric,
  is_raining    boolean,
  observed_at   timestamptz,
  fetched_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE weather_cache ENABLE ROW LEVEL SECURITY;

-- Lectura por organización. El player no la necesita --el clima le llega
-- dentro de get_player_payload, que es SECURITY DEFINER-- pero el panel sí,
-- para poder responder a "¿por qué no sale la versión de lluvia?".
DROP POLICY IF EXISTS "org members read weather" ON weather_cache;
CREATE POLICY "org members read weather"
  ON weather_cache FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM screens s
     WHERE s.id = weather_cache.screen_id
       AND s.organization_id = current_org_id()
  ));

-- La escritura es solo de la Edge Function (service_role): nadie desde el
-- panel debería poder falsear el clima de una pantalla.
REVOKE ALL ON weather_cache FROM PUBLIC, anon, authenticated;
GRANT  SELECT ON weather_cache TO authenticated;
GRANT  ALL    ON weather_cache TO service_role;

-- ── Comprobación ─────────────────────────────────────────────────────────
--   SELECT * FROM weather_thresholds;
--   SELECT name, latitude, longitude FROM screens;
