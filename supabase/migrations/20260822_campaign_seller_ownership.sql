-- CADA CAMPAÑA TIENE UN VENDEDOR, Y CADA VENDEDOR VE SOLO LAS SUYAS
--
-- Hasta aquí `campaigns` tenía una sola policy, campaigns_org_isolation, con
-- cmd ALL: aislaba por organización sin distinguir rol, así que un vendedor
-- podía leer Y ESCRIBIR todas las campañas de su organización.
--
-- Esta es una restricción REAL, en la base, no un filtro de la interfaz.

-- ── 1. El dueño ───────────────────────────────────────────────────────────
-- Se guarda el id del perfil, no el correo: el correo cambia y dejaría el
-- vínculo roto sin que nada avise.
--
-- ON DELETE SET NULL y no CASCADE: si se borra al vendedor, la campaña NO debe
-- desaparecer. Pasa a estar sin dueño, que es un problema de asignación, no de
-- datos perdidos.
--
-- Sin CHECK de que el perfil tenga rol 'seller': los roles cambian con el
-- tiempo, y un constraint así convertiría un cambio de rol legítimo en un
-- error de integridad. La UI ofrece solo vendedores; la base solo exige que
-- sea un perfil real.
ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS seller_id uuid REFERENCES profiles(id) ON DELETE SET NULL;

-- Las campañas existentes quedan en NULL = sin dueño: invisibles para
-- cualquier vendedor, visibles para admin y operator. No hay backfill posible
-- porque no existe ningún dato del que deducir el dueño; inventarlo sería peor
-- que dejarlo vacío.

CREATE INDEX IF NOT EXISTS campaigns_seller_id_idx
  ON campaigns (seller_id) WHERE seller_id IS NOT NULL;

-- ── 2. campaigns: una policy por operación ────────────────────────────────
-- La policy ALL única se sustituye por cuatro, porque leer y escribir dejan de
-- tener la misma regla: el vendedor lee lo suyo y no escribe nada.
--
-- ATENCIÓN: entre el DROP y el primer CREATE la tabla se queda sin policies y
-- RLS deniega todo. Correr el archivo entero de una vez.
DROP POLICY IF EXISTS campaigns_org_isolation ON campaigns;

-- Lectura: admin y operator ven todas las de su organización; el vendedor solo
-- aquellas cuyo dueño es él. Nada de USING (true).
DROP POLICY IF EXISTS "campaigns select by role" ON campaigns;
CREATE POLICY "campaigns select by role"
  ON campaigns FOR SELECT TO authenticated
  USING (
    organization_id = current_org_id()
    AND (
      current_user_role() IN ('admin', 'operator')
      OR seller_id = auth.uid()
    )
  );

-- Escritura: solo admin y operator. El vendedor no crea, no edita y no borra
-- campañas — tampoco las suyas.
--
-- El WITH CHECK del INSERT impide crear una campaña apuntando a OTRA
-- organización: sin él, el USING no se evalúa en un INSERT y la fila entraría.
DROP POLICY IF EXISTS "campaigns insert by role" ON campaigns;
CREATE POLICY "campaigns insert by role"
  ON campaigns FOR INSERT TO authenticated
  WITH CHECK (
    organization_id = current_org_id()
    AND current_user_role() IN ('admin', 'operator')
  );

-- En UPDATE hacen falta las dos mitades: USING dice qué filas puede tocar,
-- WITH CHECK cómo pueden quedar. Sin la segunda, un admin podría mover una
-- campaña a otra organización con un UPDATE.
DROP POLICY IF EXISTS "campaigns update by role" ON campaigns;
CREATE POLICY "campaigns update by role"
  ON campaigns FOR UPDATE TO authenticated
  USING (
    organization_id = current_org_id()
    AND current_user_role() IN ('admin', 'operator')
  )
  WITH CHECK (
    organization_id = current_org_id()
    AND current_user_role() IN ('admin', 'operator')
  );

DROP POLICY IF EXISTS "campaigns delete by role" ON campaigns;
CREATE POLICY "campaigns delete by role"
  ON campaigns FOR DELETE TO authenticated
  USING (
    organization_id = current_org_id()
    AND current_user_role() IN ('admin', 'operator')
  );

-- ── 3. media_content: lo que hace que la restricción llegue a Estadísticas ─
-- Estadísticas NO lee campaigns para sus cifras: lee la vista content_stats,
-- que agrega media_content + zones + programs + playback_events y no toca
-- campaigns en ningún punto. Restringir solo campaigns dejaría al vendedor
-- viendo las reproducciones de TODOS los anuncios de la organización, apenas
-- sin el nombre de la campaña al lado. Sería una restricción de apariencia.
--
-- La vista es security_invoker = on, así que respeta la RLS del usuario sobre
-- las tablas de abajo: acotar media_content sí llega hasta Estadísticas.
--
-- LA POLICY ES *RESTRICTIVE*, Y ESE ES EL PUNTO CLAVE.
-- Las policies normales (PERMISSIVE) se combinan con OR: añadir una nueva
-- AMPLÍA lo que se ve, nunca lo reduce, así que una permissive aquí no
-- restringiría nada — el vendedor seguiría pasando por la policy de
-- organización que ya existe. Una RESTRICTIVE se combina con AND: se evalúa
-- ADEMÁS de las actuales y solo puede quitar filas.
--
-- Y por eso mismo NO ROMPE a admin ni a operator: para ellos la primera rama
-- devuelve true, la condición entera es true, y el resultado es exactamente el
-- que ya tenían. Las policies existentes de media_content no se tocan.
DROP POLICY IF EXISTS "media_content seller sees own campaigns" ON media_content;
CREATE POLICY "media_content seller sees own campaigns"
  ON media_content AS RESTRICTIVE FOR SELECT TO authenticated
  USING (
    current_user_role() <> 'seller'
    OR EXISTS (
      SELECT 1 FROM campaigns c
       WHERE c.id = media_content.campaign_id
         AND c.seller_id = auth.uid()
    )
  );

-- Consecuencia querida y que conviene tener presente: el contenido con
-- campaign_id NULL deja de ser visible para un vendedor. Hoy, en esta base,
-- TODOS los anuncios tienen campaign_id en NULL, así que un vendedor verá
-- Estadísticas vacías hasta que se creen campañas con dueño y se les asigne
-- contenido. Es el comportamiento correcto del modelo, no un fallo.
--
-- Solo afecta a SELECT: las escrituras de media_content siguen como estaban.
-- El player no se ve afectado: recibe todo por get_player_payload, que es
-- SECURITY DEFINER y no evalúa estas policies.

-- ── Comprobación ─────────────────────────────────────────────────────────
--   -- Las cuatro de campaigns, más la restrictiva de media_content:
--   SELECT tablename, policyname, cmd, permissive
--     FROM pg_policies
--    WHERE tablename IN ('campaigns','media_content')
--    ORDER BY tablename, cmd;
--
--   -- Que admin/operator siguen viendo todo el contenido (debe dar el total):
--   SELECT count(*) FROM media_content;
--
--   -- Simulando a un vendedor, dentro de una transacción que se deshace:
--   --   begin;
--   --   set local role authenticated;
--   --   set local request.jwt.claims = '{"sub":"<uuid del vendedor>"}';
--   --   select count(*) from campaigns;      -- solo las suyas
--   --   select count(*) from media_content;  -- solo el de sus campañas
--   --   rollback;
