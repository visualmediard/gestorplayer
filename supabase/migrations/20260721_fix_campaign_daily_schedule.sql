-- REPARACIÓN: horario diario de campañas que no llegó al contenido
--
-- Las campañas tienen daily_start_time / daily_end_time, pero al inyectar el
-- contenido en las zonas NO se copiaban a schedule_start / schedule_end —
-- que son los campos que el reproductor sabe leer. Resultado: campañas
-- configuradas para ciertas horas se reproducían las 24 horas.
--
-- El código ya quedó corregido (Campaigns.tsx copia el horario al publicar);
-- esto repara las campañas YA publicadas.
--
-- Idempotente: solo toca las filas cuyo horario difiere del de su campaña.

-- 1) Copiar el horario de cada campaña viva a su contenido activo
UPDATE media_content mc
   SET schedule_start = c.daily_start_time,
       schedule_end   = c.daily_end_time
  FROM campaigns c
 WHERE mc.campaign_id     = c.id
   AND c.deleted_at      IS NULL
   AND mc.archived_at    IS NULL
   AND c.daily_start_time IS NOT NULL
   AND c.daily_end_time   IS NOT NULL
   AND (mc.schedule_start IS DISTINCT FROM c.daily_start_time
     OR mc.schedule_end   IS DISTINCT FROM c.daily_end_time);

-- 2) Avisar a los reproductores (detectan cambios por programs.published_at)
--    para que apliquen el horario sin esperar a una republicación manual.
UPDATE programs p
   SET published_at = now()
 WHERE p.id IN (
   SELECT DISTINCT z.program_id
     FROM media_content mc
     JOIN campaigns c ON c.id = mc.campaign_id
     JOIN zones     z ON z.id = mc.zone_id
    WHERE c.deleted_at      IS NULL
      AND mc.archived_at    IS NULL
      AND c.daily_start_time IS NOT NULL
      AND z.program_id      IS NOT NULL
 );
