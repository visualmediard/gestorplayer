-- Modo de ajuste del contenido dentro de cada zona (el tamaño de la zona / canvas
-- NUNCA cambia; solo cómo el video/imagen se encaja en ese espacio fijo).
--
-- Valores (equivalen a CSS object-fit):
--   'cover'   → Rellenar: llena toda la zona, recorta lo que sobra (por defecto).
--   'contain' → Contener: muestra el contenido completo, deja bandas si no calza.
--   'fill'    → Estirar: deforma el contenido para llenar exactamente la zona.
--
-- Default 'cover' = comportamiento actual, no rompe zonas existentes.

ALTER TABLE zones
  ADD COLUMN IF NOT EXISTS fit_mode text NOT NULL DEFAULT 'cover';
