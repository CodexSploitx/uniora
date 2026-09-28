# `test/npm-consumer`

Consumidor externo **real** de UNIORA: instala `@uniora/cli`, `@uniora/core`
y `@uniora/postgres` desde el **registro público de npm** (nunca
`workspace:*`), exactamente como lo haría cualquier usuario del proyecto.
Deliberadamente fuera del workspace de pnpm (no aparece en
`pnpm-workspace.yaml`) y usa `npm`, no `pnpm`.

Comprueba lo que `test/integration` no puede: que lo que **de verdad se
publica** (`dist/`, `exports`, el binario `uniora`) funciona de punta a
punta — no solo el código fuente del monorepo.

## Uso

Requiere el Postgres de `docker-compose.yml` de la raíz levantado.

```bash
cd test/npm-consumer
cp .env.example .env      # primera vez
npm install                # primera vez, o tras subir la versión publicada
npm run verify
```

`verify.mjs`:

1. Crea y resetea su propia base de datos (`uniora_npm_consumer` — nunca
   otra), para que la corrida sea reproducible.
2. Corre `npx uniora init` real (genera `uniora.config.mjs`).
3. Corre `npx uniora doctor`/`migrate`/`doctor` reales (`--json`), aplicando
   las 13 migraciones contra Postgres real.
4. Importa `@uniora/core`/`@uniora/postgres` desde `node_modules` (el paquete
   publicado, no el código fuente) y ejercita un flujo real de autorización:
   Owner con bypass, identidad sin membership denegada (fail-closed).

No forma parte de `pnpm -r test` (no es un miembro del workspace) — se corre
manualmente, normalmente tras publicar una versión nueva en npm.

`uniora.config.mjs` y `.env` se generan localmente y están en `.gitignore`
(igual que en cualquier proyecto anfitrión real) — no se trackean.
