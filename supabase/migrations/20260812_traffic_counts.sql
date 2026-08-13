-- CONTEO VEHICULAR POR EMPLAZAMIENTO
--
-- Las empresas de conteo entregan un reporte periódico por punto de medición
-- (Excel, una fila por día) con el desglose de peatones y vehículos, el total
-- de conteo y un "Total Impactos" que ya lleva aplicado su factor de ocupación
-- por tipo de vehículo (un autobús aporta más personas que una moto).
--
-- total_impacts se guarda TAL CUAL, sin recalcular: ese factor lo firma el
-- proveedor y es lo que hace el número defendible ante el cliente final. Si lo
-- recalculáramos nosotros, dejaría de ser auditable.
--
-- El dato cuelga de la PANTALLA, no de la campaña: el tráfico es del
-- emplazamiento y lo aprovechan todas las campañas que pasen por ahí. Colgarlo
-- de la campaña obligaría a reimportar el mismo archivo por cada anunciante.

CREATE TABLE IF NOT EXISTS traffic_counts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  screen_id       uuid NOT NULL REFERENCES screens(id) ON DELETE CASCADE,
  date            date NOT NULL,

  -- Desglose del proveedor. Nullable: si algún día cambian las categorías, se
  -- importa lo que venga sin bloquear la carga.
  pedestrians     integer,
  cars            integer,
  trucks          integer,
  buses           integer,
  bikes           integer,
  motorcycles     integer,
  total_count     integer,

  -- Lo único obligatorio: es la cifra que acaba en el reporte del cliente.
  total_impacts   integer NOT NULL,

  -- Trazabilidad de la importación.
  source_file     text,
  source_location text,          -- la ubicación tal como la escribe el proveedor
  imported_at     timestamptz NOT NULL DEFAULT now(),
  imported_by     uuid REFERENCES profiles(id) ON DELETE SET NULL,

  -- Reimportar un periodo corregido ACTUALIZA en vez de duplicar. Sin esto, el
  -- error más fácil de cometer es cargar dos veces el mismo mes y doblar los
  -- impactos del reporte.
  UNIQUE (screen_id, date)
);

-- ── RLS: restrictiva desde el principio ───────────────────────────────────
-- Nada de USING (true). El aislamiento va por screen_id -> organization_id,
-- usando current_org_id() (SECURITY DEFINER) para no consultar profiles desde
-- la policy y caer en recursión.
ALTER TABLE traffic_counts ENABLE ROW LEVEL SECURITY;

-- Lectura: cualquier miembro de la organización dueña de la pantalla. Hace
-- falta para que el reporte de campaña pueda mostrar los impactos.
DROP POLICY IF EXISTS "org members read traffic" ON traffic_counts;
CREATE POLICY "org members read traffic"
  ON traffic_counts FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM screens s
     WHERE s.id = traffic_counts.screen_id
       AND s.organization_id = current_org_id()
  ));

-- Escritura: solo admins, y solo sobre pantallas de su organización. El
-- WITH CHECK impide insertar filas apuntando a una pantalla ajena.
DROP POLICY IF EXISTS "org admins write traffic" ON traffic_counts;
CREATE POLICY "org admins write traffic"
  ON traffic_counts FOR ALL TO authenticated
  USING (
    current_user_role() = 'admin'
    AND EXISTS (
      SELECT 1 FROM screens s
       WHERE s.id = traffic_counts.screen_id
         AND s.organization_id = current_org_id()
    )
  )
  WITH CHECK (
    current_user_role() = 'admin'
    AND EXISTS (
      SELECT 1 FROM screens s
       WHERE s.id = traffic_counts.screen_id
         AND s.organization_id = current_org_id()
    )
  );

-- ── Privilegios acotados ──────────────────────────────────────────────────
-- Explícito y no heredado: Supabase concede por defecto sobre las tablas
-- nuevas del esquema public, y esa es justo la puerta que acabamos de cerrar
-- en el resto de tablas (20260812_close_anon_access). El player NUNCA necesita
-- estos datos: son para el panel.
REVOKE ALL ON traffic_counts FROM PUBLIC, anon;
GRANT  SELECT, INSERT, UPDATE, DELETE ON traffic_counts TO authenticated;
GRANT  ALL ON traffic_counts TO service_role;

-- Índice para el cruce del reporte (pantallas + rango de fechas). El UNIQUE ya
-- crea uno sobre (screen_id, date), así que basta con el de fecha suelta para
-- los rangos que no filtran por pantalla.
CREATE INDEX IF NOT EXISTS idx_traffic_counts_date ON traffic_counts(date);
