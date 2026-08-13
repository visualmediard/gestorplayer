-- SENTIDO DE CIRCULACIÓN EN EL CONTEO VEHICULAR
--
-- El proveedor entrega UN ARCHIVO POR SENTIDO, y lo indica en el nombre:
--   "Av. Kennedy & Av. Máximo Gómez - SN - 2026_07_29-2026_08_12.xlsx"
-- Un rótulo visible desde dos aproximaciones (p. ej. SN y NS) tiene un conteo
-- distinto por cada una, y sus impactos son la suma de ambos.
--
-- Con UNIQUE (screen_id, date) eso era imposible: importar el NS sobre el SN
-- pisaba las mismas fechas y se perdía el primero, en silencio, porque el
-- upsert lo trataba como una corrección del mismo dato.
--
-- OJO con el NOT NULL: en Postgres dos NULL NO se consideran iguales, así que
-- con `direction` nullable la clave única dejaría convivir varias filas con
-- direction NULL para la misma pantalla y fecha. El upsert dejaría de detectar
-- el conflicto y una reimportación DUPLICARÍA los impactos en vez de
-- actualizarlos. Por eso la columna es NOT NULL con 'ND' (no determinado).

-- ── 1. Columna, primero nullable para poder rellenarla ────────────────────
ALTER TABLE traffic_counts ADD COLUMN IF NOT EXISTS direction text;

-- ── 2. Backfill desde el nombre del archivo ──────────────────────────────
-- Las filas existentes traen el sentido en source_file. Se busca un par de
-- letras de sentido delimitado por guiones, que es como lo escribe el
-- proveedor. Se cubren las 12 combinaciones de puntos cardinales.
UPDATE traffic_counts
   SET direction = upper(substring(
         source_file FROM '[-–]\s*([SsNnEeOoWw][SsNnEeOoWw])\s*[-–]'))
 WHERE direction IS NULL
   AND source_file IS NOT NULL
   AND source_file ~ '[-–]\s*[SsNnEeOoWw][SsNnEeOoWw]\s*[-–]';

-- Lo que no se pudo deducir queda marcado, no adivinado: es preferible que el
-- usuario vea 'ND' y lo corrija a asignarle un sentido equivocado que luego
-- sume impactos donde no toca.
UPDATE traffic_counts SET direction = 'ND' WHERE direction IS NULL;

ALTER TABLE traffic_counts ALTER COLUMN direction SET DEFAULT 'ND';
ALTER TABLE traffic_counts ALTER COLUMN direction SET NOT NULL;

-- ── 3. La clave única pasa a incluir el sentido ──────────────────────────
-- El nombre lo generó Postgres al declarar la UNIQUE inline en la tabla.
ALTER TABLE traffic_counts DROP CONSTRAINT IF EXISTS traffic_counts_screen_id_date_key;

ALTER TABLE traffic_counts
  DROP CONSTRAINT IF EXISTS traffic_counts_screen_id_date_direction_key;
ALTER TABLE traffic_counts
  ADD CONSTRAINT traffic_counts_screen_id_date_direction_key
  UNIQUE (screen_id, date, direction);

-- ── Comprobación ─────────────────────────────────────────────────────────
-- Qué sentido se le asignó a cada importación existente:
--
--   SELECT s.name, tc.direction, tc.source_file,
--          count(*) AS dias, sum(tc.total_impacts) AS impactos
--     FROM traffic_counts tc JOIN screens s ON s.id = tc.screen_id
--    GROUP BY 1, 2, 3 ORDER BY 1, 2;
--
-- Si alguna sale como 'ND' y sabes cuál es, se corrige con:
--   UPDATE traffic_counts SET direction = 'SN'
--    WHERE direction = 'ND' AND source_file = '…';
