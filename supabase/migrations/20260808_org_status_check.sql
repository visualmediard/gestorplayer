-- ESTADO DE LA ORGANIZACIÓN PARA EL USUARIO ACTUAL
--
-- El frontend necesita saber si la organización del usuario está suspendida
-- para cerrarle la sesión (fase 2 del panel de superadmin). No se consulta
-- `organizations` directamente porque la policy de SELECT de esa tabla no
-- cubre por igual a los cuatro roles: para operator/seller/client la consulta
-- podría devolver nada y el chequeo fallaría en silencio.
--
-- SECURITY DEFINER salta RLS, pero no filtra nada sensible: solo devuelve el
-- estado de la organización a la que el propio usuario ya pertenece.

CREATE OR REPLACE FUNCTION my_org_status()
  RETURNS text LANGUAGE sql SECURITY DEFINER STABLE
  SET search_path = public AS $$
    SELECT o.status
      FROM organizations o
     WHERE o.id = (SELECT p.organization_id FROM profiles p WHERE p.id = auth.uid())
  $$;

REVOKE ALL     ON FUNCTION my_org_status() FROM public, anon;
GRANT  EXECUTE ON FUNCTION my_org_status() TO authenticated;
