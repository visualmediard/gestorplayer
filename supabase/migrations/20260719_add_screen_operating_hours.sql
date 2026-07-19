-- Horario operativo por pantalla. Define la ventana en que la pantalla
-- reproduce contenido y cuenta estadísticas. Fuera de esa ventana el player
-- muestra pantalla negra y NO registra reproducciones.
--
-- operating_start / operating_end: horas locales del dispositivo (ej. '06:00'
-- a '02:00'). Soportan cruce de medianoche. NULL en cualquiera de las dos =
-- sin restricción = pantalla siempre activa (24h), comportamiento actual.
--
-- Nota: es distinto de la columna existente operating_hours (número de horas
-- al día usado para el cálculo de frecuencias); esta define la ventana horaria.

ALTER TABLE screens
  ADD COLUMN IF NOT EXISTS operating_start time DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS operating_end   time DEFAULT NULL;
