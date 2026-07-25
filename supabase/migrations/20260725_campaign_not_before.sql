-- Columna not_before en media_content: gate de fecha de inicio para campañas.
--
-- El player ya verificaba expires_at (= ends_at) para dejar de reproducir al
-- vencer la campaña. Esta columna permite el gate simétrico del inicio: si hoy
-- es anterior a not_before, el player salta el item igual que si estuviera
-- vencido, sin importar si hay conexión (usa el reloj del dispositivo).
--
-- not_before = campaña.starts_at copiada al publicar. NULL = sin restricción
-- de inicio (contenido sin campaña o campaña que empieza inmediatamente).

ALTER TABLE media_content
  ADD COLUMN IF NOT EXISTS not_before date DEFAULT NULL;

-- Backfill: contenido de campaña ya publicado que no tiene not_before aún.
-- Solo afecta filas activas (archived_at IS NULL) con campaña activa.
UPDATE media_content mc
   SET not_before = c.starts_at::date
  FROM campaigns c
 WHERE mc.campaign_id  = c.id
   AND c.starts_at     IS NOT NULL
   AND c.deleted_at    IS NULL
   AND mc.archived_at  IS NULL
   AND mc.not_before   IS NULL;
