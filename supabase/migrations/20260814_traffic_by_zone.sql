-- EL CONTEO VEHICULAR PASA A COLGAR DE LA ZONA
--
-- KENNEDY es UN reproductor que reparte su lienzo entre las caras del rótulo,
-- así que cada cara (cada sentido de circulación) es una ZONA, no una pantalla.
--
-- Con el conteo colgando de screen_id, un anuncio que solo sale en la cara SN
-- sumaba el tráfico de las cuatro caras: el cruce encontraba todos los conteos
-- de esa pantalla y no tenía forma de saber en cuál se reprodujo. Le
-- atribuiría al anunciante gente que nunca vio su anuncio.
--
-- playback_events ya guarda zone_id, así que cruzando por zona la atribución
-- sale correcta sola.
--
-- ON DELETE RESTRICT y no CASCADE: las zonas pertenecen al programa y se
-- rehacen al rediseñarlo. Con CASCADE, un rediseño borraría meses de aforo
-- importado sin avisar, y no te enterarías hasta abrir un reporte. Con
-- RESTRICT, Postgres impide borrar una zona que tenga conteo y obliga a
-- decidir en el momento.
--
-- A largo plazo el modelo correcto es una entidad "cara" independiente del
-- programa; hoy no toca, pero queda dicho.
--
-- Se elimina `direction`: con zone_id, el NOMBRE DE LA ZONA es el sentido.
-- Mantener las dos cosas invita a que se contradigan (renombras la zona y
-- direction se queda con el valor viejo) y deja de estar claro cuál manda.

-- ── 1. Se vacía la tabla, avisando de cuántas filas ──────────────────────
-- No hay mapeo automático fiable: las filas SN podrían emparejarse con la zona
-- por parecido de nombre, pero las NS no tienen zona destino todavía, y esa
-- heurística es justo la que asigna tráfico a la cara equivocada en silencio
-- cuando hay varias zonas con nombres parecidos. Los archivos están a mano y
-- reimportar son treinta segundos.
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM traffic_counts;
  RAISE NOTICE 'traffic_counts: se borran % fila(s). Hay que reimportar los archivos por ZONA.', n;
  DELETE FROM traffic_counts;
END $$;

-- ── 2. Las policies dependen de screen_id: se van antes que la columna ───
DROP POLICY IF EXISTS "org members read traffic"  ON traffic_counts;
DROP POLICY IF EXISTS "org admins write traffic"  ON traffic_counts;

-- ── 3. Cambio de columnas ────────────────────────────────────────────────
ALTER TABLE traffic_counts DROP COLUMN IF EXISTS direction;
ALTER TABLE traffic_counts DROP COLUMN IF EXISTS screen_id;   -- se lleva su UNIQUE

-- La tabla está vacía, así que el NOT NULL entra directo sin backfill.
ALTER TABLE traffic_counts
  ADD COLUMN IF NOT EXISTS zone_id uuid NOT NULL
  REFERENCES zones(id) ON DELETE RESTRICT;

ALTER TABLE traffic_counts
  DROP CONSTRAINT IF EXISTS traffic_counts_zone_id_date_key;
ALTER TABLE traffic_counts
  ADD CONSTRAINT traffic_counts_zone_id_date_key UNIQUE (zone_id, date);

-- ── 4. RLS: aislamiento por zona → programa → organización ───────────────
-- Un join más que antes. Nada de USING (true): esta tabla no la toca el player.
ALTER TABLE traffic_counts ENABLE ROW LEVEL SECURITY;

-- Lectura: cualquier miembro de la organización. La necesitan los reportes.
CREATE POLICY "org members read traffic"
  ON traffic_counts FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM zones z
      JOIN programs p ON p.id = z.program_id
     WHERE z.id = traffic_counts.zone_id
       AND p.organization_id = current_org_id()
  ));

-- Escritura: solo admins. El WITH CHECK impide insertar apuntando a una zona
-- de otra organización.
CREATE POLICY "org admins write traffic"
  ON traffic_counts FOR ALL TO authenticated
  USING (
    current_user_role() = 'admin'
    AND EXISTS (
      SELECT 1 FROM zones z
        JOIN programs p ON p.id = z.program_id
       WHERE z.id = traffic_counts.zone_id
         AND p.organization_id = current_org_id()
    )
  )
  WITH CHECK (
    current_user_role() = 'admin'
    AND EXISTS (
      SELECT 1 FROM zones z
        JOIN programs p ON p.id = z.program_id
       WHERE z.id = traffic_counts.zone_id
         AND p.organization_id = current_org_id()
    )
  );

-- ── 5. Privilegios: se reafirman tras el cambio de columnas ──────────────
REVOKE ALL ON traffic_counts FROM PUBLIC, anon;
GRANT  SELECT, INSERT, UPDATE, DELETE ON traffic_counts TO authenticated;
GRANT  ALL ON traffic_counts TO service_role;

-- El UNIQUE ya indexa (zone_id, date); basta con la fecha suelta para el rango.
CREATE INDEX IF NOT EXISTS idx_traffic_counts_date ON traffic_counts(date);

-- ── Comprobación ─────────────────────────────────────────────────────────
--   SELECT count(*) FROM traffic_counts;            -- debe ser 0
--   \d traffic_counts                               -- zone_id NOT NULL, sin screen_id
