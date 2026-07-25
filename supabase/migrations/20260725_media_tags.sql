-- Etiquetas de contenido (media_tags) y su relación con media_content.
--
-- Las etiquetas permiten agrupar archivos de la biblioteca para filtrarlos
-- y eliminarlos en lote. El borrado en lote respeta el soft-delete: los
-- archivos con estadísticas se conservan archivados, los demás se borran.
--
-- RLS: cada organización solo puede ver y gestionar sus propias etiquetas.
-- La tabla media_content_tags sigue la misma autorización a través de la
-- FK tag_id → media_tags.organization_id.

-- ── Etiquetas por organización ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS media_tags (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            text NOT NULL,
  color           text NOT NULL DEFAULT '#3B82F6',
  created_at      timestamptz DEFAULT now(),
  UNIQUE(organization_id, name)
);

ALTER TABLE media_tags ENABLE ROW LEVEL SECURITY;

CREATE POLICY "org members manage their tags"
  ON media_tags FOR ALL
  USING (
    organization_id IN (
      SELECT organization_id FROM profiles WHERE id = auth.uid()
    )
  );

-- ── Relación muchos-a-muchos contenido ↔ etiquetas ────────────────────────
-- Se etiqueta la fila "representante" de biblioteca (zone_id IS NULL,
-- campaign_id IS NULL cuando existe). La CASCADE elimina automáticamente
-- estas filas cuando se borra el media_content o la etiqueta.
CREATE TABLE IF NOT EXISTS media_content_tags (
  media_content_id uuid NOT NULL REFERENCES media_content(id) ON DELETE CASCADE,
  tag_id           uuid NOT NULL REFERENCES media_tags(id)    ON DELETE CASCADE,
  PRIMARY KEY (media_content_id, tag_id)
);

ALTER TABLE media_content_tags ENABLE ROW LEVEL SECURITY;

CREATE POLICY "org members manage their content tags"
  ON media_content_tags FOR ALL
  USING (
    tag_id IN (
      SELECT id FROM media_tags
       WHERE organization_id IN (
         SELECT organization_id FROM profiles WHERE id = auth.uid()
       )
    )
  );
