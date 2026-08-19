-- Resumen de qué tráfico hay cargado por zona: primer día, último día y cuántos
-- días tienen dato. Alimenta la tarjeta de Configuración → Conteo vehicular.
--
-- ── NO CONVERTIR A SECURITY DEFINER ──────────────────────────────────────
-- Esta función es SECURITY INVOKER (el valor por defecto de Postgres, por eso
-- no se declara). Es una decisión, no un olvido: al correr con los permisos de
-- quien llama, la RLS se evalúa sobre zones, programs y traffic_counts, y el
-- aislamiento entre organizaciones lo impone la política que ya existe
-- ("org members read traffic", en 20260814_traffic_by_zone.sql), que filtra
-- por zones → programs → organization_id = current_org_id().
--
-- Con SECURITY DEFINER esa garantía desaparecería: la función pasaría a correr
-- como su dueño, saltándose la RLS, y devolvería las zonas de TODAS las
-- organizaciones salvo que alguien añadiera a mano un filtro por
-- current_org_id(). Un filtro escrito a mano se puede borrar en una
-- refactorización sin que nada falle de forma visible; una política de RLS, no.
--
-- Si algún día hace falta convertirla, hay que añadir el filtro explícito EN LA
-- MISMA edición, no después.
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION traffic_coverage()
  RETURNS TABLE (
    zone_id      uuid,
    zone_name    text,
    program_name text,
    panel_id     integer,
    first_date   date,
    last_date    date,
    days         bigint
  )
  LANGUAGE sql STABLE
  SET search_path = public AS $$
    -- LEFT JOIN a propósito: una zona mapeada pero todavía sin sincronizar
    -- aparece con days = 0, que es justo lo que hay que ver para saber que
    -- falta traerla. Con INNER JOIN desaparecería de la lista y parecería que
    -- no está mapeada.
    --
    -- COUNT(t.date) y no COUNT(*): con el LEFT JOIN, COUNT(*) contaría la fila
    -- nula y devolvería 1 para las zonas sin datos.
    SELECT z.id, z.name, p.name, z.traffic_panel_id,
           MIN(t.date), MAX(t.date), COUNT(t.date)
      FROM zones z
      JOIN programs p ON p.id = z.program_id
      LEFT JOIN traffic_counts t ON t.zone_id = z.id
     WHERE z.traffic_panel_id IS NOT NULL
     GROUP BY z.id, z.name, p.name, z.traffic_panel_id
     ORDER BY p.name, z.name
  $$;

-- El player no tiene nada que hacer aquí.
REVOKE ALL     ON FUNCTION traffic_coverage() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION traffic_coverage() TO authenticated;

-- ── Comprobación ─────────────────────────────────────────────────────────
--   SELECT * FROM traffic_coverage();
--   -- Debe devolver solo las zonas de TU organización. Si aparecen zonas de
--   -- otra, la función se convirtió en SECURITY DEFINER en algún momento.
