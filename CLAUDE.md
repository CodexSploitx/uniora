# UNIORA

Monorepo pnpm (Node 22+): `@uniora/core`, adaptadores de identidad y de base de datos, `@uniora/server` (API HTTP), `@uniora/client`, Studio y la CLI. Guía de contribución: `CONTRIBUTING.md`.

## Regla obligatoria: las APIs de UNIORA siempre al día

Cada vez que se haga un cambio, una actualización, una corrección o una función nueva, **usa la skill `uniora-api-sync`** (`.claude/skills/uniora-api-sync/SKILL.md`) antes de dar el trabajo por terminado, hacer commit o abrir un PR.

Resumen: si algo cambia en UNIORA, la API HTTP de `@uniora/server` (rutas, esquemas, scopes, errores, eventos), su OpenAPI (`guides/openapi.json`), la referencia (`guides/server-api.md`), el cliente (`packages/client/src/generated.ts`) y la API embebida deben quedar actualizados y regenerados con `UPDATE_DOCS=1 pnpm --filter @uniora/server test`. **Y su documentación de uso:** también hay que escribir o actualizar la documentación para saber cómo usarla (para qué sirve, requisitos, ejemplo mínimo por cada forma de uso —embebida y servicio externo—, reglas que sorprenden, errores y cómo adoptarla) en la guía del área, `guides/server.md`, los READMEs de los paquetes afectados y, si es destacado, `README.md` y `README.es.md`; los ejemplos escritos a mano se comprueban. Solo se exime un cambio puramente interno, y la razón se escribe en el PR.

## Versiones y releases

Un cambio **no** sube la versión: se anota bajo `## Unreleased` del CHANGELOG. El número (SemVer), el bump en bloque y la publicación están en la skill `uniora-release`, que se usa solo cuando la persona pide cortar un release. **Publicar es de la persona**: al terminar, entrégale siempre los enlaces para crear el tag y para el workflow de Actions, donde ella aprueba; no empujes el tag.

## Comandos

```bash
pnpm install
pnpm build        # los paquetes se consumen por dist/, compila primero
pnpm typecheck
pnpm test         # Postgres real con TEST_DATABASE_URL, SQLite y memoria
pnpm lint
pnpm sql:export   # tras añadir o cambiar una migración
```
