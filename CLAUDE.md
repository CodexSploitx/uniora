# UNIORA

Monorepo pnpm (Node 22+): `@uniora/core`, adaptadores de identidad y de base de datos, `@uniora/server` (API HTTP), `@uniora/client`, Studio y la CLI. Guía de contribución: `CONTRIBUTING.md`.

## Regla obligatoria: las APIs de UNIORA siempre al día

Cada vez que se haga un cambio, una actualización, una corrección o una función nueva, **usa la skill `uniora-api-sync`** (`.claude/skills/uniora-api-sync/SKILL.md`) antes de dar el trabajo por terminado, hacer commit o abrir un PR.

Resumen: si algo cambia en UNIORA, la API HTTP de `@uniora/server` (rutas, esquemas, scopes, errores, eventos), su OpenAPI (`guides/openapi.json`), la referencia (`guides/server-api.md`), el cliente (`packages/client/src/generated.ts`) y la API embebida deben quedar actualizados y regenerados con `UPDATE_DOCS=1 pnpm --filter @uniora/server test`. Solo se exime un cambio puramente interno, y la razón se escribe en el PR.

## Versiones (SemVer)

Un cambio **no** sube la versión: se anota bajo `## Unreleased` del CHANGELOG. La versión se sube al cortar un release: solo correcciones → parche (`0.12.0` → `0.12.1`); función nueva compatible (campo, ruta, scope, error, migración) → menor (`0.13.0`); cambio incompatible → mayor (en `0.x`, menor). Detalle en la skill `uniora-api-sync` (Paso 7).

## Comandos

```bash
pnpm install
pnpm build        # los paquetes se consumen por dist/, compila primero
pnpm typecheck
pnpm test         # Postgres real con TEST_DATABASE_URL, SQLite y memoria
pnpm lint
pnpm sql:export   # tras añadir o cambiar una migración
```
