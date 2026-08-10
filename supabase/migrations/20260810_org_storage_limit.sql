-- LÍMITE DE ALMACENAMIENTO GESTIONADO POR EL SUPERADMIN
--
-- storage_limit_mb existía desde 20260722 sin protección: la policy
-- "users update own org" autoriza el UPDATE de la fila COMPLETA a cualquier
-- admin de su organización (Settings.tsx guarda nombre y contacto desde el
-- cliente), y RLS no distingue columnas. Es decir, un admin podía ampliarse el
-- almacenamiento solo desde la consola del navegador. Mismo agujero que ya se
-- tapó para is_superadmin y status.
--
-- IMPORTANTE: correr el archivo entero de una vez. Entre el DROP del trigger
-- viejo y el CREATE del nuevo la columna `status` queda sin blindaje.

-- ── 1. Blindaje: se amplía el guard existente a las dos columnas ───────────
-- Reemplaza a guard_org_status(), que solo cubría `status`. Se renombra porque
-- el nombre viejo ya no describiría lo que hace.
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
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'No autorizado a modificar el estado de la organización';
  END IF;
  IF NEW.storage_limit_mb IS DISTINCT FROM OLD.storage_limit_mb THEN
    RAISE EXCEPTION 'No autorizado a modificar el límite de almacenamiento';
  END IF;

  RETURN NEW;
END $$;

-- El trigger debe irse antes que la función a la que apunta.
DROP TRIGGER  IF EXISTS trg_guard_org_status ON organizations;
DROP FUNCTION IF EXISTS guard_org_status();

DROP TRIGGER IF EXISTS trg_guard_org_columns ON organizations;
CREATE TRIGGER trg_guard_org_columns
  BEFORE INSERT OR UPDATE ON organizations
  FOR EACH ROW EXECUTE FUNCTION guard_org_admin_columns();

-- ── 2. Cambio del límite (única vía de escritura) ──────────────────────────
CREATE OR REPLACE FUNCTION set_org_storage_limit(p_org_id uuid, p_limit_mb integer)
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public AS $$
BEGIN
  IF NOT is_superadmin() THEN
    RAISE EXCEPTION 'Solo el superadmin puede cambiar el límite de almacenamiento';
  END IF;
  -- Tope superior contra un dedazo: 1 TB. Sin él, un cero de más regala
  -- espacio sin que nada lo note hasta que llegue la factura de R2.
  IF p_limit_mb IS NULL OR p_limit_mb < 100 OR p_limit_mb > 1048576 THEN
    RAISE EXCEPTION 'El límite debe estar entre 100 MB y 1 TB';
  END IF;
  UPDATE organizations SET storage_limit_mb = p_limit_mb WHERE id = p_org_id;
END $$;

REVOKE ALL     ON FUNCTION set_org_storage_limit(uuid, integer) FROM public, anon;
GRANT  EXECUTE ON FUNCTION set_org_storage_limit(uuid, integer) TO authenticated;
