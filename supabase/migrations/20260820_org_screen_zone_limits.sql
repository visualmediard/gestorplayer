-- LÍMITES DE PANTALLAS Y ZONAS POR ORGANIZACIÓN
--
-- Los gestiona el superadmin desde su panel, igual que storage_limit_mb.
--
-- NULL = SIN LÍMITE, y es el valor con el que nacen las dos columnas. Es
-- deliberado no poner un número por defecto: si screen_limit naciera con 10,
-- cualquier organización que hoy tenga 12 pantallas quedaría bloqueada en el
-- momento de correr esta migración, sin que nadie lo haya decidido.

-- ── 1. Las columnas ───────────────────────────────────────────────────────
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS screen_limit integer;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS zone_limit   integer;

-- ── 2. Blindaje, en la MISMA migración que las columnas ───────────────────
-- Toda columna sensible nace desprotegida: la policy "users update own org"
-- autoriza el UPDATE de la fila COMPLETA a cualquier admin de su organización
-- (Settings.tsx guarda nombre y contacto desde el cliente), y la RLS no
-- distingue columnas. Sin esto, un admin podría ampliarse los límites desde la
-- consola del navegador. Es exactamente lo que pasó con storage_limit_mb, que
-- estuvo un mes y medio desprotegida.
--
-- Solo se reemplaza la función; el trigger trg_guard_org_columns sigue
-- apuntando al mismo nombre, así que aquí NO hay ventana sin blindaje como sí
-- la hubo en 20260810_org_storage_limit.sql (que tuvo que renombrar).
CREATE OR REPLACE FUNCTION guard_org_admin_columns()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public AS $$
BEGIN
  -- auth.uid() IS NULL = migración / service_role / SQL editor: se deja pasar
  -- (ahí no hay usuario que escale privilegios, y RLS ya bloquea a anon).
  IF auth.uid() IS NULL OR is_superadmin() THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.status           := 'active';
    NEW.storage_limit_mb := 2048;
    -- Nadie se autoasigna límites al crear su organización.
    NEW.screen_limit     := NULL;
    NEW.zone_limit       := NULL;
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'No autorizado a modificar el estado de la organización';
  END IF;
  IF NEW.storage_limit_mb IS DISTINCT FROM OLD.storage_limit_mb THEN
    RAISE EXCEPTION 'No autorizado a modificar el límite de almacenamiento';
  END IF;
  IF NEW.screen_limit IS DISTINCT FROM OLD.screen_limit THEN
    RAISE EXCEPTION 'No autorizado a modificar el límite de pantallas';
  END IF;
  IF NEW.zone_limit IS DISTINCT FROM OLD.zone_limit THEN
    RAISE EXCEPTION 'No autorizado a modificar el límite de zonas';
  END IF;

  RETURN NEW;
END $$;

-- ── 3. Cambio de los límites (única vía de escritura) ─────────────────────
-- Una sola RPC con los dos parámetros, no dos funciones: se editan juntos en
-- la misma fila del panel. NULL explícito devuelve a "sin límite".
CREATE OR REPLACE FUNCTION set_org_limits(
  p_org_id       uuid,
  p_screen_limit integer,
  p_zone_limit   integer
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public AS $$
BEGIN
  IF NOT is_superadmin() THEN
    RAISE EXCEPTION 'Solo el superadmin puede cambiar los límites';
  END IF;

  -- Cotas de cordura contra un dedazo, igual que el tope de 1 TB del
  -- almacenamiento: un cero de más regalaría mil pantallas sin que nada lo
  -- note. NULL sí es válido: significa sin límite.
  IF p_screen_limit IS NOT NULL AND (p_screen_limit < 1 OR p_screen_limit > 10000) THEN
    RAISE EXCEPTION 'El límite de pantallas debe estar entre 1 y 10000, o vacío para sin límite';
  END IF;
  IF p_zone_limit IS NOT NULL AND (p_zone_limit < 1 OR p_zone_limit > 10000) THEN
    RAISE EXCEPTION 'El límite de zonas debe estar entre 1 y 10000, o vacío para sin límite';
  END IF;

  UPDATE organizations
     SET screen_limit = p_screen_limit,
         zone_limit   = p_zone_limit
   WHERE id = p_org_id;
END $$;

REVOKE ALL     ON FUNCTION set_org_limits(uuid, integer, integer) FROM public, anon;
GRANT  EXECUTE ON FUNCTION set_org_limits(uuid, integer, integer) TO authenticated;

-- ── 4. Aplicación del límite, pegada a la tabla ───────────────────────────
-- Va en un trigger BEFORE INSERT y no dentro de una RPC de creación porque hoy
-- las pantallas y las zonas se crean con un INSERT directo desde el frontend
-- (Screens.tsx y ZoneEditor.tsx), autorizado por RLS. Una RPC no cerraría
-- nada: bastaría la consola del navegador para insertar sin pasar por ella.
-- En el trigger da igual por dónde llegue la escritura.
--
-- SECURITY DEFINER es OBLIGATORIO aquí, y por un motivo concreto: con
-- SECURITY INVOKER el COUNT quedaría sujeto a la RLS del que inserta, y un
-- usuario que no viera todas las filas contaría de menos y se saltaría el
-- límite sin querer. El recuento tiene que ver la tabla entera.

CREATE OR REPLACE FUNCTION enforce_screen_limit()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public AS $$
DECLARE
  v_limit integer;
  v_count integer;
BEGIN
  -- Migraciones, service_role y SQL editor pasan; el superadmin también, por
  -- si necesita crear algo por encima del límite de un cliente.
  IF auth.uid() IS NULL OR is_superadmin() THEN
    RETURN NEW;
  END IF;
  IF NEW.organization_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT o.screen_limit INTO v_limit
    FROM organizations o WHERE o.id = NEW.organization_id;

  IF v_limit IS NULL THEN               -- sin límite
    RETURN NEW;
  END IF;

  SELECT count(*) INTO v_count
    FROM screens s WHERE s.organization_id = NEW.organization_id;

  IF v_count >= v_limit THEN
    RAISE EXCEPTION
      'Has alcanzado el límite de % pantalla% de tu plan. Contacta a tu proveedor para ampliarlo.',
      v_limit, CASE WHEN v_limit = 1 THEN '' ELSE 's' END;
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_enforce_screen_limit ON screens;
CREATE TRIGGER trg_enforce_screen_limit
  BEFORE INSERT ON screens
  FOR EACH ROW EXECUTE FUNCTION enforce_screen_limit();

-- El límite de zonas es el TOTAL de la organización, no por programa. zones no
-- tiene organization_id propio, así que se resuelve por su programa.
CREATE OR REPLACE FUNCTION enforce_zone_limit()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public AS $$
DECLARE
  v_org   uuid;
  v_limit integer;
  v_count integer;
BEGIN
  IF auth.uid() IS NULL OR is_superadmin() THEN
    RETURN NEW;
  END IF;

  SELECT p.organization_id INTO v_org
    FROM programs p WHERE p.id = NEW.program_id;

  IF v_org IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT o.zone_limit INTO v_limit
    FROM organizations o WHERE o.id = v_org;

  IF v_limit IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT count(*) INTO v_count
    FROM zones z JOIN programs p2 ON p2.id = z.program_id
   WHERE p2.organization_id = v_org;

  IF v_count >= v_limit THEN
    RAISE EXCEPTION
      'Has alcanzado el límite de % zona% de tu plan. Contacta a tu proveedor para ampliarlo.',
      v_limit, CASE WHEN v_limit = 1 THEN '' ELSE 's' END;
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_enforce_zone_limit ON zones;
CREATE TRIGGER trg_enforce_zone_limit
  BEFORE INSERT ON zones
  FOR EACH ROW EXECUTE FUNCTION enforce_zone_limit();

-- ── 5. El panel del superadmin necesita ver uso y límite juntos ──────────
-- Se amplía superadmin_orgs_overview con los dos límites y el conteo de zonas
-- (screen_count ya venía). Un límite sin el consumo al lado no dice nada.
--
-- Hay que DROP antes de CREATE: Postgres no deja que CREATE OR REPLACE cambie
-- el tipo de retorno de una función, y aquí se añaden columnas al RETURNS
-- TABLE. Entre las dos sentencias el panel de superadmin daría error unos
-- milisegundos; es una lectura suya y no afecta a ningún cliente.
DROP FUNCTION IF EXISTS superadmin_orgs_overview();

CREATE OR REPLACE FUNCTION superadmin_orgs_overview()
RETURNS TABLE (
  id               uuid,
  name             text,
  slug             text,
  status           text,
  created_at       timestamptz,
  storage_limit_mb integer,
  used_bytes       bigint,
  screen_count     int,
  user_count       int,
  screen_limit     integer,
  zone_limit       integer,
  zone_count       int
)
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public AS $$
  SELECT
    o.id, o.name, o.slug, o.status, o.created_at, o.storage_limit_mb,
    COALESCE((
      SELECT SUM(t.sz)::bigint FROM (
        SELECT MAX(mc.file_size_bytes) AS sz
        FROM media_content mc
        WHERE mc.organization_id = o.id
          AND mc.archived_at    IS NULL
          AND mc.storage_path   IS NOT NULL
          AND mc.storage_path  <> ''
        GROUP BY mc.storage_path
      ) t
    ), 0)::bigint,
    (SELECT count(*)::int FROM screens  s WHERE s.organization_id = o.id),
    (SELECT count(*)::int FROM profiles p WHERE p.organization_id = o.id),
    o.screen_limit,
    o.zone_limit,
    -- Zonas de toda la organización, igual que cuenta el trigger.
    (SELECT count(*)::int
       FROM zones z JOIN programs pr ON pr.id = z.program_id
      WHERE pr.organization_id = o.id)
  FROM organizations o
  WHERE is_superadmin()
  ORDER BY o.created_at DESC;
$$;

REVOKE ALL     ON FUNCTION superadmin_orgs_overview() FROM public, anon;
GRANT  EXECUTE ON FUNCTION superadmin_orgs_overview() TO authenticated;

-- Nota: los triggers solo miran INSERT. Bajar el límite de una organización
-- que ya lo supera NO borra nada: simplemente no podrá crear más hasta bajar
-- del nuevo tope. Y hay una condición de carrera teórica (dos inserciones
-- simultáneas podrían contar lo mismo y pasar las dos); cerrarla exigiría un
-- bloqueo sobre la fila de la organización y no compensa a este volumen.

-- ── Comprobación ─────────────────────────────────────────────────────────
--   SELECT name, screen_limit, zone_limit, storage_limit_mb FROM organizations;
--
--   -- Uso actual frente al límite:
--   SELECT o.name,
--          (SELECT count(*) FROM screens s WHERE s.organization_id = o.id) AS pantallas,
--          o.screen_limit,
--          (SELECT count(*) FROM zones z JOIN programs p ON p.id = z.program_id
--            WHERE p.organization_id = o.id) AS zonas,
--          o.zone_limit
--     FROM organizations o ORDER BY o.name;
