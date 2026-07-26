-- Sección de Configuración: roles de usuario, logo de organización e invitaciones.
--
-- role en profiles: controla los permisos dentro de la organización.
--   admin    → acceso total (default, para no romper usuarios existentes)
--   operator → gestiona contenido, programas, pantallas
--   seller   → gestiona campañas de sus clientes
--   client   → solo ve reportes de sus campañas
--
-- logo_url en organizations: marca blanca del dashboard.
--
-- invitations: invitaciones pendientes por email con token de un solo uso.
--   RLS: cada organización solo ve y crea invitaciones propias.

-- ── Rol de usuario ────────────────────────────────────────────────────────
-- Default 'admin' para que los usuarios ya existentes conserven acceso total.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'admin';

-- CHECK de valores permitidos (idempotente: solo se agrega si no existe).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'profiles_role_check'
  ) THEN
    ALTER TABLE profiles
      ADD CONSTRAINT profiles_role_check
      CHECK (role IN ('admin', 'operator', 'seller', 'client'));
  END IF;
END $$;

-- ── Logo de la organización ───────────────────────────────────────────────
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS logo_url text DEFAULT NULL;

-- ── Invitaciones ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invitations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email           text NOT NULL,
  role            text NOT NULL DEFAULT 'operator'
                    CHECK (role IN ('admin', 'operator', 'seller', 'client')),
  token           text NOT NULL UNIQUE,
  created_by      uuid REFERENCES profiles(id) ON DELETE SET NULL,
  expires_at      timestamptz DEFAULT (now() + interval '7 days'),
  accepted_at     timestamptz DEFAULT NULL,
  created_at      timestamptz DEFAULT now()
);

ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;

-- Lectura: cualquier miembro de la organización ve sus invitaciones.
DROP POLICY IF EXISTS "org members read their invitations" ON invitations;
CREATE POLICY "org members read their invitations"
  ON invitations FOR SELECT
  USING (
    organization_id IN (
      SELECT organization_id FROM profiles WHERE id = auth.uid()
    )
  );

-- Escritura (crear/editar/borrar): solo admins de esa misma organización.
-- USING filtra las filas que un admin puede modificar/borrar; WITH CHECK
-- valida las filas que inserta/actualiza, evitando que cree invitaciones
-- para una organización distinta a la suya.
DROP POLICY IF EXISTS "org admins manage their invitations" ON invitations;
CREATE POLICY "org admins manage their invitations"
  ON invitations FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM profiles
       WHERE id = auth.uid()
         AND role = 'admin'
         AND organization_id = invitations.organization_id
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM profiles
       WHERE id = auth.uid()
         AND role = 'admin'
         AND organization_id = invitations.organization_id
    )
  );
