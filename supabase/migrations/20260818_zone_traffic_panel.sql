-- FASE D, PIEZA 1 — cada zona apunta a su emplazamiento del proveedor de conteo
--
-- Una zona es una CARA del rótulo, y esa cara es un "panel" en DataVisiooh, con
-- su propio id entero. Guardar aquí ese id es lo que permitirá cruzar el conteo
-- real con las reproducciones de esa cara concreta (playback_events ya guarda
-- zone_id, así que la atribución sale correcta sola).
--
-- NULL = sin mapear, y es el estado de todas las zonas existentes: no hace
-- falta backfill. Una zona sin mapear se comporta exactamente como hoy.
--
-- Sin RPC a propósito. La escritura la gobierna la policy "org manages zones",
-- que ya aísla por organización en USING y WITH CHECK. Montar una RPC solo para
-- esta columna sería falso rigor: quien puede mover la geometría de la zona
-- --el mismo UPDATE, la misma policy-- podría cambiar este campo de todos
-- modos. El "solo admin" del mapeo se aplica en la UI, que es donde el resto
-- del sistema distingue rol (la RLS aísla organización, no rol).
--
-- Tampoco se impone unicidad en base. Lo natural sería "un panel por
-- organización", pero zones no tiene organization_id --cuelga de programs-- y
-- un índice único no puede atravesar ese join; haría falta un trigger y no
-- compensa. El editor avisa si el panel ya está asignado a otra zona.

ALTER TABLE zones ADD COLUMN IF NOT EXISTS traffic_panel_id integer;

-- Un id de panel es un entero positivo. La cota es barata y evita que un 0 o un
-- negativo lleguen a la Edge Function del conector.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'zones_traffic_panel_id_check') THEN
    ALTER TABLE zones
      ADD CONSTRAINT zones_traffic_panel_id_check
      CHECK (traffic_panel_id IS NULL OR traffic_panel_id > 0);
  END IF;
END $$;

COMMENT ON COLUMN zones.traffic_panel_id IS
  'ID del emplazamiento en el proveedor de conteo vehicular (panel_id). NULL = sin mapear.';

-- Índice parcial: las consultas de sincronización recorrerán solo las zonas
-- mapeadas, que serán una minoría frente al total.
CREATE INDEX IF NOT EXISTS zones_traffic_panel_id_idx
  ON zones (traffic_panel_id) WHERE traffic_panel_id IS NOT NULL;

-- ── Comprobación ─────────────────────────────────────────────────────────
--   SELECT z.name, z.traffic_panel_id, p.name AS programa
--     FROM zones z JOIN programs p ON p.id = z.program_id
--    ORDER BY z.traffic_panel_id NULLS LAST;
