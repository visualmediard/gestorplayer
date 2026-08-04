-- Bug de seguridad: media_content no tenía organization_id y la política RLS
-- dejaba pasar TODOS los ítems de biblioteca (zone_id IS NULL) a cualquier
-- organización. Se agrega organization_id, se hace backfill y se reescribe la
-- política para scopear por organización sin el hueco.

-- 1. Columna nueva (nullable para poder backfill; FK a organizations).
ALTER TABLE media_content
  ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE;

-- 2. Backfill de ítems EN ZONA: vía zona → programa → organización.
UPDATE media_content mc
SET organization_id = p.organization_id
FROM zones z
JOIN programs p ON p.id = z.program_id
WHERE mc.zone_id = z.id
  AND mc.organization_id IS NULL;

-- 3. Backfill de ítems de BIBLIOTECA (y demás sin zona): vía uploaded_by → perfil → org.
UPDATE media_content mc
SET organization_id = pr.organization_id
FROM profiles pr
WHERE mc.uploaded_by = pr.id
  AND mc.organization_id IS NULL;

-- 4. (Diagnóstico) filas huérfanas que queden sin org (sin zona y sin uploader
--    válido). La nueva RLS las oculta a todos, así que es seguro dejarlas:
--    SELECT count(*) FROM media_content WHERE organization_id IS NULL;

-- 5. Índice para el filtro por org (la RLS lo usa en cada lectura).
CREATE INDEX IF NOT EXISTS idx_media_content_org ON media_content(organization_id);

-- 6. Reescribir la política: scope por organization_id, SIN el zone_id IS NULL abierto.
--    Las políticas del player (anon "player reads media by token" y
--    "screen reads own media") NO se tocan.
DROP POLICY IF EXISTS "org manages media" ON media_content;
CREATE POLICY "org manages media"
  ON media_content FOR ALL
  USING (
    organization_id IN (SELECT organization_id FROM profiles WHERE id = auth.uid())
  )
  WITH CHECK (
    organization_id IN (SELECT organization_id FROM profiles WHERE id = auth.uid())
  );
