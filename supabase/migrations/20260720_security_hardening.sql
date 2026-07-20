-- ENDURECIMIENTO DE SEGURIDAD (multi-tenant)
--
-- 1) Vistas con SECURITY DEFINER → SECURITY INVOKER
--    Una vista definer ignora el RLS y corre con los permisos de su dueño,
--    por lo que puede filtrar datos de una organización a otra. Con
--    security_invoker=on la vista respeta el RLS del usuario que consulta.
--    El bloque recorre TODAS las vistas de 'public' que aún no lo tengan.
--
-- 2) release_screen_device: cerraba un hueco multi-tenant. Al ser SECURITY
--    DEFINER y estar concedida a 'authenticated', cualquier usuario logueado
--    podía liberar la pantalla de OTRA organización pasando su id. Ahora la
--    función verifica que la pantalla pertenezca a la organización del que llama.

-- ── 1) security_invoker en todas las vistas de public ──────────────────
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'v'
      AND NOT EXISTS (
        SELECT 1 FROM unnest(c.reloptions) opt
        WHERE opt IN ('security_invoker=on', 'security_invoker=true')
      )
  LOOP
    EXECUTE format('ALTER VIEW public.%I SET (security_invoker = on)', r.relname);
    RAISE NOTICE 'security_invoker activado en vista %', r.relname;
  END LOOP;
END $$;

-- ── 2) release_screen_device: verificar pertenencia a la organización ──
CREATE OR REPLACE FUNCTION release_screen_device(p_screen_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE screens s
     SET device_fingerprint = NULL,
         last_seen_at        = NULL
   WHERE s.id = p_screen_id
     AND s.organization_id = (
       SELECT p.organization_id FROM profiles p WHERE p.id = auth.uid()
     );
END;
$$;

REVOKE ALL     ON FUNCTION release_screen_device(uuid) FROM public, anon;
GRANT  EXECUTE ON FUNCTION release_screen_device(uuid) TO authenticated;
