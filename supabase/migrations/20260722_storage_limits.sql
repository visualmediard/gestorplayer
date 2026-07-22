-- LÍMITE DE ALMACENAMIENTO POR ORGANIZACIÓN
--
-- Cada organización tiene un tope (storage_limit_mb, 2 GB por defecto) que el
-- superadmin puede subir por empresa. El consumo se calcula sumando el tamaño
-- de cada ARCHIVO físico único en R2 — no por fila de media_content, porque un
-- mismo archivo (storage_path) se repite en biblioteca + cada zona/campaña.

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS storage_limit_mb integer NOT NULL DEFAULT 2048;

ALTER TABLE media_content
  ADD COLUMN IF NOT EXISTS file_size_bytes bigint DEFAULT NULL;

-- Consumo de la organización del usuario que llama.
-- SECURITY INVOKER: corre con los permisos del usuario, así el RLS de
-- media_content ya limita las filas a su organización (mismo conjunto que ve
-- en la biblioteca). Cuenta cada storage_path UNA vez; MAX evita que una copia
-- con tamaño NULL rebaje el archivo a 0.
CREATE OR REPLACE FUNCTION org_storage_usage()
RETURNS TABLE (used_bytes bigint, limit_mb integer)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT
    COALESCE((
      SELECT SUM(sz)::bigint
      FROM (
        SELECT MAX(mc.file_size_bytes) AS sz
        FROM media_content mc
        WHERE mc.archived_at   IS NULL
          AND mc.storage_path  IS NOT NULL
          AND mc.storage_path <> ''
        GROUP BY mc.storage_path
      ) t
    ), 0)::bigint AS used_bytes,
    COALESCE((
      SELECT o.storage_limit_mb
      FROM organizations o
      WHERE o.id = (SELECT p.organization_id FROM profiles p WHERE p.id = auth.uid())
    ), 2048) AS limit_mb;
$$;

REVOKE ALL     ON FUNCTION org_storage_usage() FROM public, anon;
GRANT  EXECUTE ON FUNCTION org_storage_usage() TO authenticated;
