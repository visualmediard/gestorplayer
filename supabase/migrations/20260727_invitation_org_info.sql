-- Branding público de la organización de una invitación (para la página /invite).
-- SECURITY DEFINER: el invitado aún no tiene sesión y la RLS no le dejaría leer
-- invitations ni organizations. Solo expone nombre y logo (no es sensible).
CREATE OR REPLACE FUNCTION invitation_org_info(p_token text)
  RETURNS TABLE (org_name text, logo_url text)
  LANGUAGE sql SECURITY DEFINER STABLE
  SET search_path = public AS $$
    SELECT o.name, o.logo_url
    FROM invitations i
    JOIN organizations o ON o.id = i.organization_id
    WHERE i.token = p_token
    LIMIT 1
  $$;

GRANT EXECUTE ON FUNCTION invitation_org_info(text) TO anon, authenticated;
