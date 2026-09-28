# `test/integration`

Prueba de integración end-to-end: ejercita `@uniora/core` + `@uniora/postgres`
**vía el código fuente del monorepo** (`workspace:*`) contra un Postgres real
— migraciones reales, transacciones reales, el `AuthorizationEngine` real —
incluyendo los invariantes de seguridad centrales del proyecto (aislamiento
cross-tenant, protección del último Owner, denegación de permisos/features
desconocidos).

No repite las suites unitarias de cada paquete (esas ya cubren cada método
exhaustivamente). Esto responde una pregunta distinta: **¿el flujo completo,
de punta a punta, funciona de verdad?**

## Uso

Requiere el Postgres de `docker-compose.yml` de la raíz levantado y un `.env`
con `TEST_DATABASE_URL` (ver `.env.example` en la raíz del repo).

```bash
pnpm install                                     # una vez, desde la raíz
pnpm --filter @uniora-test/integration test
```

Usa su propia base de datos (`uniora_test_e2e`, derivada de
`TEST_DATABASE_URL`) — nunca toca `DATABASE_URL` (dev/demo) ni `uniora_test`
(la suite unitaria de `@uniora/postgres`). Ya está incluida en `pnpm -r test`.

Ver `test/npm-consumer` para la otra mitad de esta verificación: los mismos
paquetes, pero instalados desde el registro real de npm.
