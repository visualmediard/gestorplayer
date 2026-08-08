-- SUPERADMIN GLOBAL DE LA PLATAFORMA
--
-- Distinto del rol 'admin' (que es por organización): el superadmin es el dueño
-- de GestPlayer y ve/gestiona TODAS las organizaciones.
--
-- Nota de seguridad: is_superadmin (profiles) y status (organizations) viven en
-- tablas que los usuarios YA pueden actualizar (Settings guarda nombre, logo y
-- datos de contacto de su propia org). Sin protección, un admin cualquiera
-- podría auto-otorgarse is_superadmin o des-suspender su organización. Las
-- policies de RLS autorizan la fila completa, no columna por columna, así que
-- ambas se blindan además con triggers.

-- ── 1. Columnas nuevas ─────────────────────────────────────────────────────
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS is_superadmin boolean NOT NULL DEFAULT false;

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'organizations_status_check'
  ) THEN
    ALTER TABLE organizations
      ADD CONSTRAINT organizations_status_check
      CHECK (status IN ('active', 'suspended', 'cancelled'));
  END IF;
END $$;

-- ── 2. Helper ──────────────────────────────────────────────────────────────
-- SECURITY DEFINER para poder usarse dentro de policies sobre profiles sin caer
-- en la recursión de RLS (mismo patrón que current_user_role()).
CREATE OR REPLACE FUNCTION is_superadmin()
  RETURNS boolean LANGUAGE sql SECURITY DEFINER STABLE
  SET search_path = public AS $$
    SELECT COALESCE(
      (SELECT p.is_superadmin FROM profiles p WHERE p.id = auth.uid()),
      false
    )
  $$;

REVOKE ALL     ON FUNCTION is_superadmin() FROM public, anon;
GRANT  EXECUTE ON FUNCTION is_superadmin() TO authenticated;

-- ── 3. Blindaje de columnas sensibles ──────────────────────────────────────
-- auth.uid() IS NULL = migración / service_role / SQL editor: se deja pasar
-- (ahí no hay usuario que escale privilegios, y RLS ya bloquea a anon).
CREATE OR REPLACE FUNCTION guard_is_superadmin()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL OR is_superadmin() THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.is_superadmin := false;          -- nadie se auto-otorga al registrarse
  ELSIF NEW.is_superadmin IS DISTINCT FROM OLD.is_superadmin THEN
    RAISE EXCEPTION 'No autorizado a modificar is_superadmin';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_guard_is_superadmin ON profiles;
CREATE TRIGGER trg_guard_is_superadmin
  BEFORE INSERT OR UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION guard_is_superadmin();

CREATE OR REPLACE FUNCTION guard_org_status()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL OR is_superadmin() THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.status := 'active';
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'No autorizado a modificar el estado de la organización';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_guard_org_status ON organizations;
CREATE TRIGGER trg_guard_org_status
  BEFORE INSERT OR UPDATE ON organizations
  FOR EACH ROW EXECUTE FUNCTION guard_org_status();

-- ── 4. RLS: el superadmin lee todo ─────────────────────────────────────────
-- Aditivas: se combinan con OR con las policies existentes, que siguen
-- funcionando igual para el resto de usuarios.
DROP POLICY IF EXISTS "superadmin reads all organizations" ON organizations;
CREATE POLICY "superadmin reads all organizations"
  ON organizations FOR SELECT USING (is_superadmin());

DROP POLICY IF EXISTS "superadmin updates all organizations" ON organizations;
CREATE POLICY "superadmin updates all organizations"
  ON organizations FOR UPDATE
  USING (is_superadmin()) WITH CHECK (is_superadmin());

DROP POLICY IF EXISTS "superadmin reads all profiles" ON profiles;
CREATE POLICY "superadmin reads all profiles"
  ON profiles FOR SELECT USING (is_superadmin());

-- ── 5. Resumen de todas las organizaciones (una sola llamada) ──────────────
-- SECURITY DEFINER salta RLS, así que el WHERE is_superadmin() es la única
-- puerta: sin él, cualquier autenticado leería toda la plataforma.
-- used_bytes replica la regla de org_storage_usage(): cuenta cada storage_path
-- UNA vez (un archivo se repite en biblioteca + cada zona/campaña) y usa MAX
-- para que una copia con tamaño NULL no rebaje el archivo a 0.
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
  user_count       int
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
    (SELECT count(*)::int FROM profiles p WHERE p.organization_id = o.id)
  FROM organizations o
  WHERE is_superadmin()
  ORDER BY o.created_at DESC;
$$;

REVOKE ALL     ON FUNCTION superadmin_orgs_overview() FROM public, anon;
GRANT  EXECUTE ON FUNCTION superadmin_orgs_overview() TO authenticated;

-- ── 6. Cambio de estado (única vía de escritura del panel) ─────────────────
CREATE OR REPLACE FUNCTION set_org_status(p_org_id uuid, p_status text)
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public AS $$
BEGIN
  IF NOT is_superadmin() THEN
    RAISE EXCEPTION 'Solo el superadmin puede cambiar el estado de una organización';
  END IF;
  IF p_status NOT IN ('active', 'suspended', 'cancelled') THEN
    RAISE EXCEPTION 'Estado inválido: %', p_status;
  END IF;
  UPDATE organizations SET status = p_status WHERE id = p_org_id;
END $$;

REVOKE ALL     ON FUNCTION set_org_status(uuid, text) FROM public, anon;
GRANT  EXECUTE ON FUNCTION set_org_status(uuid, text) TO authenticated;

-- ── 7. Alta del superadmin ─────────────────────────────────────────────────
UPDATE profiles SET is_superadmin = true
 WHERE lower(email) = 'visualmediard@gmail.com';
