-- Reset remoto del reproductor desde el dashboard.
--
-- reset_requested_at: cuando el dashboard pone un timestamp aquí,
-- el player lo detecta en el próximo ciclo de polling, verifica
-- conectividad real y ejecuta softResync() sin recargar la página.
-- El player limpia el campo a NULL tras ejecutar el reset.

ALTER TABLE screens ADD COLUMN IF NOT EXISTS reset_requested_at timestamptz DEFAULT NULL;
