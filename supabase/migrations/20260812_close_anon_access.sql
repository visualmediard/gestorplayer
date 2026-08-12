-- FASE 5: CIERRE DEL ACCESO ANÓNIMO A LAS TABLAS (cierra P1)
--
-- Último paso de la revisión de seguridad previa al lanzamiento. Hasta ahora,
-- para que el player pudiera funcionar sin sesión, siete tablas tenían
-- policies con USING (true) para el rol anon: cualquiera con la clave pública
-- --que va en el bundle del frontend-- podía descargarse la lista completa de
-- pantallas y clientes, el inventario de contenido, y los tokens de
-- vinculación en curso. screens tenía además UPDATE abierto, con lo que se
-- podía secuestrar el device_fingerprint de cualquier pantalla, y
-- playback_events aceptaba INSERT con screen_id arbitrario.
--
-- Ya no hace falta: el player --web y Android-- pasa entero por RPCs
-- SECURITY DEFINER, que corren como su dueño y no dependen de estos permisos.
--
-- Verificado ANTES de correr esto:
--   · Player.tsx: cero consultas directas, solo las 6 RPCs
--   · Bundle del APK: cero lecturas directas a las seis tablas
--   · KENNEDY (única pantalla Android) reportando android-2026.08.10
--   · Pair.tsx usa sesión de admin (authenticated), no el cliente anónimo
--
-- Verificado DESPUÉS: KENNEDY reproduce, el player web reproduce, y vincular
-- una pantalla nueva desde el panel funciona.

-- ── 1. Reemplazar el acceso del panel antes de quitarlo ───────────────────
-- public_pairings era FOR ALL con USING(true), así que cubría también a
-- authenticated. Pair.tsx valida el código con un SELECT sobre
-- device_pairings: se le da policy propia ANTES de borrar la permisiva, o el
-- panel dejaría de poder vincular.
DROP POLICY IF EXISTS "authenticated reads pairings" ON device_pairings;
CREATE POLICY "authenticated reads pairings"
  ON device_pairings FOR SELECT TO authenticated USING (true);

-- ── 2. Borrar las policies USING(true) de anon ────────────────────────────
-- En programs había dos, duplicadas entre sí.
DROP POLICY IF EXISTS "public_pairings"                ON device_pairings;
DROP POLICY IF EXISTS "player reads screen by token"   ON screens;
DROP POLICY IF EXISTS "player reads media by token"    ON media_content;
DROP POLICY IF EXISTS "player reads program by token"  ON programs;
DROP POLICY IF EXISTS "anon reads program by token"    ON programs;
DROP POLICY IF EXISTS "player reads zones by token"    ON zones;
DROP POLICY IF EXISTS "anon reads sub_playlists"       ON sub_playlists;
DROP POLICY IF EXISTS "player inserts playback events" ON playback_events;

-- ── 3. Revocar privilegios de tabla a anon ────────────────────────────────
-- La barrera que NO depende de acertar el nombre de una policy: sin
-- privilegio de tabla, ninguna policy puede conceder acceso. Cubre de paso el
-- UPDATE abierto de screens, cuya policy nunca se localizó por nombre.
REVOKE ALL ON device_pairings FROM anon;
REVOKE ALL ON screens         FROM anon;
REVOKE ALL ON media_content   FROM anon;
REVOKE ALL ON programs        FROM anon;
REVOKE ALL ON zones           FROM anon;
REVOKE ALL ON sub_playlists   FROM anon;
REVOKE ALL ON playback_events FROM anon;

-- ── Comprobación (debe devolver cero filas) ───────────────────────────────
-- SELECT table_name, privilege_type FROM information_schema.role_table_grants
-- WHERE grantee = 'anon' AND table_schema = 'public'
--   AND table_name IN ('device_pairings','screens','media_content','programs',
--                      'zones','sub_playlists','playback_events');

-- ── Vuelta atrás, si hiciera falta ────────────────────────────────────────
-- GRANT SELECT ON screens, media_content, programs, zones, sub_playlists TO anon;
-- GRANT SELECT, INSERT, DELETE ON device_pairings TO anon;
-- GRANT UPDATE ON screens TO anon;
-- GRANT INSERT ON playback_events TO anon;
-- CREATE POLICY "public_pairings" ON device_pairings FOR ALL USING (true);
-- CREATE POLICY "player reads screen by token" ON screens FOR SELECT USING (true);
-- CREATE POLICY "player reads media by token" ON media_content FOR SELECT USING (true);
-- CREATE POLICY "player reads program by token" ON programs FOR SELECT USING (true);
-- CREATE POLICY "player reads zones by token" ON zones FOR SELECT USING (true);
-- CREATE POLICY "anon reads sub_playlists" ON sub_playlists FOR SELECT USING (true);
-- CREATE POLICY "player inserts playback events" ON playback_events FOR INSERT WITH CHECK (true);
