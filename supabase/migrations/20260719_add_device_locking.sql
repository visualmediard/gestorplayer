-- DEVICE LOCKING — Un token, un dispositivo.
--
-- Cuando un player arranca por primera vez con un token, registra su
-- huella (device_fingerprint) en la pantalla. A partir de ahí, solo ese
-- dispositivo puede reproducir con ese token. Otro dispositivo que intente
-- el mismo token queda bloqueado con un mensaje.
--
-- device_fingerprint: hash estable del dispositivo (userAgent + resolución +
--   núcleos + canvas fingerprint). NULL = pantalla libre, la reclama el
--   primer dispositivo que se conecte.
-- last_seen_at: último latido del dispositivo dueño (se actualiza ~cada 5 min).

ALTER TABLE screens
  ADD COLUMN IF NOT EXISTS device_fingerprint text        DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS last_seen_at        timestamptz DEFAULT NULL;

-- ─────────────────────────────────────────────────────────────────────────
-- LIBERAR DISPOSITIVO
--
-- Limpia la huella de una pantalla para que el próximo dispositivo que se
-- conecte la reclame. Pensada para un futuro panel de superadmin ("liberar
-- acceso"). Por ahora se invoca manualmente:
--
--   select release_screen_device('<screen_uuid>');
--
-- SECURITY DEFINER para que pueda ejecutarse aunque las políticas RLS no
-- permitan UPDATE directo de device_fingerprint desde el cliente. Se restringe
-- su ejecución a roles autenticados (ajústese cuando exista el rol superadmin).
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION release_screen_device(p_screen_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE screens
     SET device_fingerprint = NULL,
         last_seen_at        = NULL
   WHERE id = p_screen_id;
$$;

REVOKE ALL     ON FUNCTION release_screen_device(uuid) FROM public, anon;
GRANT  EXECUTE ON FUNCTION release_screen_device(uuid) TO authenticated;
