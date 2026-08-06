-- Limpieza de device_pairings: los códigos de vinculación abandonados (QR
-- generado pero nunca escaneado, TV apagado, rotación cada 5 min del player
-- web) nunca se borran del lado del cliente y la tabla crece indefinidamente.
--
-- Esta migración añade una marca de tiempo y programa una limpieza periódica.

-- 1. Marca de creación para poder expirar (defensivo por si la columna ya existe).
ALTER TABLE device_pairings
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

-- 2. Función de limpieza: borra los códigos sin vincular con más de 15 min
--    (un código válido nunca vive más de 5 min del lado del player) y los ya
--    vinculados con más de 1 día (consumidos o abandonados).
CREATE OR REPLACE FUNCTION cleanup_device_pairings()
  RETURNS void LANGUAGE sql SECURITY DEFINER
  SET search_path = public AS $$
  DELETE FROM device_pairings
  WHERE (token IS NULL     AND created_at < now() - interval '15 minutes')
     OR (token IS NOT NULL AND created_at < now() - interval '1 day');
$$;

-- 3. Programa la limpieza cada 10 minutos con pg_cron.
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Reprogramable: quita el job anterior si ya existía (evita duplicados al
-- re-correr la migración).
SELECT cron.unschedule('cleanup-device-pairings')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'cleanup-device-pairings');

SELECT cron.schedule(
  'cleanup-device-pairings',
  '*/10 * * * *',
  $$ SELECT cleanup_device_pairings() $$
);
