-- ACUSE DE RECIBO DE LA PUBLICACIÓN
--
-- Hasta aquí el sistema sabía "publiqué a las 15:42" y "el dispositivo dio
-- señales de vida a las 15:43", pero no si ese dispositivo ya está
-- reproduciendo la versión nueva o todavía la anterior. Con esos dos datos no
-- se puede distinguir "sincronizado" de "esperando conexión" sin adivinar, y
-- una inferencia mostrada como certeza es lo que hace que alguien deje de
-- confiar en un indicador.
--
-- Esta columna la reporta el propio player: qué publicación tiene APLICADA.
--
-- Alcance honesto: verde significa "el dispositivo recibió y aplicó esta
-- publicación", NO "se está reproduciendo bien". Un video corrupto daría verde
-- igual. La telemetría de reproducción real es otra pieza.

ALTER TABLE screens
  ADD COLUMN IF NOT EXISTS synced_published_at timestamptz;

COMMENT ON COLUMN screens.synced_published_at IS
  'published_at del programa que el dispositivo tiene aplicado. NULL = el player todavía no lo reporta (app antigua o aún sin latir): estado DESCONOCIDO, nunca "desincronizada".';

-- ── El ack viaja dentro del latido ────────────────────────────────────────
-- Se amplía player_heartbeat en vez de crear una RPC hermana, y no por ahorrar
-- código: con dos llamadas independientes, una puede fallar sin la otra y
-- aparecerían pantallas que reportan latido pero no ack (o al revés), o sea
-- combinaciones imposibles que el semáforo tendría que interpretar. Yendo
-- dentro del latido, si llegó uno llegó el otro.
--
-- El parámetro es OPCIONAL con DEFAULT NULL: un APK viejo que llame con tres
-- argumentos sigue funcionando exactamente igual, sin tocar nada. Eso es
-- justo lo que hace falta mientras las pantallas en campo se actualizan.
--
-- Se elimina la firma de 3 argumentos para que no queden dos funciones vivas:
-- con una sola, las llamadas de 3 argumentos resuelven a ésta y el DEFAULT
-- hace el resto. ATENCIÓN: entre el DROP y el CREATE, un heartbeat que llegue
-- justo en medio falla. Correr el archivo entero de una vez.
DROP FUNCTION IF EXISTS player_heartbeat(text, text, text);

CREATE OR REPLACE FUNCTION player_heartbeat(
  p_token               text,
  p_app_version         text        DEFAULT NULL,
  p_session             text        DEFAULT NULL,
  p_synced_published_at timestamptz DEFAULT NULL
)
  RETURNS jsonb LANGUAGE sql SECURITY DEFINER
  SET search_path = public AS $$
  UPDATE screens
     SET last_heartbeat = now(),
         app_version    = COALESCE(p_app_version, app_version),
         -- Solo avanza, nunca retrocede. Si por reordenamiento de red llegara
         -- un latido viejo después de uno nuevo, GREATEST evita que la pantalla
         -- "se desincronice" sola en el panel. Con NULL, se conserva lo que
         -- hubiera: un player antiguo no debe borrar el ack de uno nuevo.
         synced_published_at = CASE
           WHEN p_synced_published_at IS NULL THEN synced_published_at
           ELSE GREATEST(COALESCE(synced_published_at, p_synced_published_at),
                         p_synced_published_at)
         END
   WHERE device_token::text = p_token
  RETURNING jsonb_build_object(
    -- Misma forma de respuesta que antes: el player Android la lee y no debe
    -- cambiar. owner solo tiene sentido si el cliente manda su sesión; el
    -- player web de React no la manda y tampoco lee la respuesta.
    'owner',     (p_session IS NOT NULL AND device_fingerprint IS NOT DISTINCT FROM p_session),
    'has_owner', (device_fingerprint IS NOT NULL)
  );
$$;

-- El player es anónimo: sin este GRANT no puede latir.
REVOKE ALL     ON FUNCTION player_heartbeat(text, text, text, timestamptz) FROM public;
GRANT  EXECUTE ON FUNCTION player_heartbeat(text, text, text, timestamptz) TO anon, authenticated;

-- ── Comprobación ─────────────────────────────────────────────────────────
--   -- Una sola función, con cuatro argumentos:
--   SELECT proname, pg_get_function_identity_arguments(oid)
--     FROM pg_proc WHERE proname = 'player_heartbeat';
--
--   -- El semáforo, tal como lo calculará el panel:
--   SELECT s.name,
--          p.published_at,
--          s.synced_published_at,
--          s.last_heartbeat,
--          CASE
--            WHEN s.synced_published_at IS NULL                       THEN 'desconocido'
--            WHEN s.synced_published_at >= p.published_at             THEN 'sincronizada'
--            WHEN s.last_heartbeat > now() - interval '2 minutes'     THEN 'sincronizando'
--            ELSE 'esperando conexion'
--          END AS estado
--     FROM screens s
--     LEFT JOIN programs p ON p.id = s.current_program_id;
