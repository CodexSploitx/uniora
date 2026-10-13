# UNIORA

Monorepo pnpm (Node 22+): `@uniora/core`, adaptadores de identidad y de base de datos, `@uniora/server` (API HTTP), `@uniora/client`, Studio y la CLI. Guía de contribución: `CONTRIBUTING.md`.

## Regla obligatoria: las APIs de UNIORA siempre al día

Cada vez que se haga un cambio, una actualización, una corrección o una función nueva, **usa la skill `uniora-api-sync`** (`.claude/skills/uniora-api-sync/SKILL.md`) antes de dar el trabajo por terminado, hacer commit o abrir un PR.

Resumen: si algo cambia en UNIORA, la API HTTP de `@uniora/server` (rutas, esquemas, scopes, errores, eventos), su OpenAPI (`guides/openapi.json`), la referencia (`guides/server-api.md`), el cliente (`packages/client/src/generated.ts`) y la API embebida deben quedar actualizados y regenerados con `UPDATE_DOCS=1 pnpm --filter @uniora/server test`. **Y su documentación de uso:** también hay que escribir o actualizar la documentación para saber cómo usarla (para qué sirve, requisitos, ejemplo mínimo por cada forma de uso —embebida y servicio externo—, reglas que sorprenden, errores y cómo adoptarla) en la guía del área, `guides/server.md`, los READMEs de los paquetes afectados y, si es destacado, `README.md` y `README.es.md`; los ejemplos escritos a mano se comprueban. Solo se exime un cambio puramente interno, y la razón se escribe en el PR.

## Versiones (SemVer)

Un cambio **no** sube la versión: se anota bajo `## Unreleased` del CHANGELOG. La versión se sube al cortar un release: solo correcciones → parche (`0.12.0` → `0.12.1`); función nueva compatible (campo, ruta, scope, error, migración) → menor (`0.13.0`); cambio incompatible → mayor (en `0.x`, menor). Detalle en la skill `uniora-api-sync` (Paso 8). **Publicar es de la persona**: cuando un release esté listo, entrega siempre los enlaces para crear el tag (`releases/new?tag=vX.Y.Z&target=main`) y el de Actions (`actions/workflows/release.yml`) para que ella apruebe la publicación; no empujes el tag.

## Comandos

```bash
pnpm install
pnpm build        # los paquetes se consumen por dist/, compila primero
pnpm typecheck
pnpm test         # Postgres real con TEST_DATABASE_URL, SQLite y memoria
pnpm lint
pnpm sql:export   # tras añadir o cambiar una migración
```
