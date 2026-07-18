# GestorPlayer

Plataforma SaaS de señalización digital para pantallas LED (React + TypeScript + Vite + Supabase).

## ⚠️ Antes de hacer push: corre el build

Vercel despliega automáticamente desde `main`, pero **compila con TypeScript estricto** (`tsc -b`), a diferencia del servidor de desarrollo (Vite/HMR) que **no** hace chequeo completo de tipos. Si el build falla, **Vercel NO actualiza el sitio: sigue sirviendo la versión anterior en silencio**, aunque el commit ya esté en GitHub.

Por eso, **siempre corre esto antes de `git push`**:

```bash
npm run build
```

- Si termina en `✓ built`, puedes hacer push con seguridad.
- Si muestra errores `TSxxxx`, arréglalos primero. Un `.tsx` que se ve bien en local puede romper el build de producción (p. ej. un objeto al que le falta un campo obligatorio de su tipo).

Después de que Vercel despliegue el commit nuevo, recarga con **Ctrl+Shift+R** para saltarte la caché del navegador.

## Comandos

```bash
npm run dev      # servidor de desarrollo (no valida tipos a fondo)
npm run build    # build de producción — DEBE pasar antes de push
npm run preview  # previsualiza el build de producción localmente
```

## Migraciones de base de datos (Supabase)

Algunos cambios requieren ejecutar SQL en Supabase antes de que la funcionalidad opere. Los últimos añadidos:

```sql
-- Soft-delete de contenido para preservar estadísticas
ALTER TABLE media_content ADD COLUMN IF NOT EXISTS archived_at timestamptz;

-- Sub-playlists (grupos round-robin) dentro de campañas
ALTER TABLE sub_playlists ADD COLUMN IF NOT EXISTS campaign_id uuid;
ALTER TABLE sub_playlists ADD COLUMN IF NOT EXISTS archived_at timestamptz;
```

### Índices de rendimiento (recomendado a escala)

```sql
CREATE INDEX IF NOT EXISTS idx_media_content_organization ON media_content(organization_id);
CREATE INDEX IF NOT EXISTS idx_media_content_campaign     ON media_content(campaign_id);
CREATE INDEX IF NOT EXISTS idx_playback_events_screen     ON playback_events(screen_id);
CREATE INDEX IF NOT EXISTS idx_playback_events_campaign   ON playback_events(campaign_id);
CREATE INDEX IF NOT EXISTS idx_playback_events_created    ON playback_events(created_at);
```

---

## Almacenamiento: Cloudflare R2 para videos e imágenes

Los archivos pesados (videos e imágenes de las pantallas) se suben a **Cloudflare R2**
a través de la Edge Function `supabase/functions/upload-to-r2`. Supabase Storage se
mantiene solo para archivos pequeños (logos, etc.).

**Las credenciales de R2 nunca están en el frontend.** El frontend solo llama a la
Edge Function con el JWT del usuario; la función valida la sesión, resuelve el
`organization_id` del usuario server-side y firma la subida S3 con las credenciales
que viven como *secrets* del servidor.

`media_content.storage_path` ahora puede contener **una ruta de Supabase** (archivos
antiguos, que siguen funcionando sin migrar) **o una URL pública completa de R2**
(archivos nuevos). El helper `src/lib/mediaUrl.ts` (`resolveMediaUrl`) detecta cuál es
y la resuelve; el player Android (`player/index.html`) hace lo mismo.

### Secrets de la Edge Function (nunca en `.env` del frontend)

```bash
supabase secrets set \
  R2_ACCOUNT_ID=2f3c4fe8c6bb3d788f080d206498784f \
  R2_BUCKET_NAME=gestplayer-media \
  R2_PUBLIC_URL=https://pub-3b8fbcfbfb9c47b792014349a03369c1.r2.dev \
  R2_ACCESS_KEY_ID=<tu-access-key-id> \
  R2_SECRET_ACCESS_KEY=<tu-secret-access-key>
```

`SUPABASE_URL` y `SUPABASE_ANON_KEY` ya los inyecta Supabase automáticamente en las
Edge Functions; no hace falta definirlos.

### Desplegar la función

```bash
supabase functions deploy upload-to-r2
```

### CORS del bucket R2 (obligatorio para la reproducción offline)

La reproducción **online** funciona sin CORS (los tags `<video>`/`<img>` no lo exigen).
Pero el **caché offline** del player usa `fetch()` para descargar los archivos, y eso sí
requiere que R2 permita el origen del player. En el bucket R2 → Settings → CORS Policy:

```json
[
  {
    "AllowedOrigins": ["https://gestorplayer.vercel.app", "http://localhost:5173"],
    "AllowedMethods": ["GET"],
    "AllowedHeaders": ["*"],
    "MaxAgeSeconds": 3600
  }
]
```

Sin esta política, todo se reproduce en línea con normalidad, pero los archivos de R2
no se guardarán en el caché para uso sin conexión.

---

## Plantilla base: React + TypeScript + Vite

This template provides a minimal setup to get React working in Vite with HMR and some Oxlint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the Oxlint configuration

If you are developing a production application, we recommend enabling type-aware lint rules by installing `oxlint-tsgolint` and editing `.oxlintrc.json`:

```json
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "plugins": ["react", "typescript", "oxc"],
  "options": {
    "typeAware": true
  },
  "rules": {
    "react/rules-of-hooks": "error",
    "react/only-export-components": ["warn", { "allowConstantExport": true }]
  }
}
```

See the [Oxlint rules documentation](https://oxc.rs/docs/guide/usage/linter/rules) for the full list of rules and categories.
