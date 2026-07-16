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
