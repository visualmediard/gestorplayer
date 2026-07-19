-- Programación por días y horas para cada contenido de una zona.
-- Todas las columnas son nullable: NULL = sin restricción (se reproduce siempre).
--
-- schedule_days:  días de la semana en que el contenido puede reproducirse.
--                 Formato JS Date.getDay(): 0=domingo, 1=lunes ... 6=sábado.
--                 NULL o array vacío = todos los días.
-- schedule_start: hora local de inicio del rango (ej. '06:00').
-- schedule_end:   hora local de fin del rango (ej. '22:00').
--                 Si start/end son NULL = sin restricción horaria.
--
-- La verificación se hace con la hora LOCAL del dispositivo donde corre el
-- player, por lo que funciona sin conexión (usa el reloj del dispositivo).

ALTER TABLE media_content
  ADD COLUMN IF NOT EXISTS schedule_days  integer[] DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS schedule_start time      DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS schedule_end   time      DEFAULT NULL;
