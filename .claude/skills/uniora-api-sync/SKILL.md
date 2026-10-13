---
name: uniora-api-sync
description: OBLIGATORIA en este repositorio cada vez que se haga un cambio, una actualización, una corrección o una función nueva (feature, bugfix, refactor con efecto visible, migración, nuevo campo, nuevo error, nuevo permiso, nuevo evento). Obliga a mantener actualizadas las APIs de UNIORA — la API HTTP de @uniora/server con su OpenAPI, el cliente @uniora/client y la referencia server-api.md, y la API embebida (@uniora/core y adaptadores) — y a no dar el trabajo por terminado hasta que todo lo derivado esté regenerado y los tests pasen. Use whenever code, schema, storage, permissions, adapters or Studio change in uniora; before finishing, committing or opening a PR.
---

# UNIORA: las APIs siempre al día

**Regla de oro: ningún cambio en UNIORA está terminado hasta que las APIs que lo exponen estén actualizadas.**
UNIORA se usa de dos formas, y las dos son una API pública que clientes reales usan sin ver nuestro código:

1. **Servicio externo** (`@uniora/server`): una API HTTP con clave. Quien la usa (por ejemplo climasy) solo conoce lo que está en las rutas, en `guides/openapi.json` y en `@uniora/client`. **Si una función no tiene ruta, para esa gente no existe.**
2. **Embebida** (librería): lo que exportan `@uniora/core`, los adaptadores (`@uniora/supabase`, `clerk`, `auth0`, `better-auth`), `@uniora/express`, `@uniora/next`, `@uniora/postgres`, `@uniora/sqlite`.

Esta skill existe porque ya pasó: los perfiles de usuario (nombre, email, avatar) se entregaron para la forma embebida, pero **nadie añadió su ruta al servidor ni al cliente**; quien usa UNIORA como servicio externo no podía enviarlos ni leerlos. No se repite.

## Cuándo se aplica

Siempre que el trabajo toque cualquiera de estas cosas, aunque sea "pequeño":

- Una función, método, tipo o export nuevo o modificado de `@uniora/core` o de cualquier paquete publicable.
- Datos nuevos o cambiados: campos, tablas, migraciones, repositorios de almacenamiento.
- Permisos, roles, scopes, políticas, equipos, invitaciones, organizaciones, miembros, features, auditoría, webhooks/eventos.
- Errores nuevos o con otro significado, validaciones, límites.
- Lo que Studio, la CLI, Express o Next muestran o hacen sobre esos datos.

Solo se exime un cambio **puramente interno** (renombrar una variable privada, comentarios, tests, refactor sin efecto observable). Esa exención no se asume: se **declara por escrito** en la descripción del PR con la razón concreta, tras responder las preguntas de abajo.

## Paso 1 — Preguntas que decide el alcance (responde todas, por escrito)

1. ¿Alguien que use UNIORA **como servicio externo** necesitaría hacer, leer o recibir algo nuevo o distinto por este cambio? Si sí → hace falta ruta o campo en la API HTTP.
2. ¿Cambia la **forma de una respuesta** existente (campo nuevo, campo que ahora puede faltar, otro tipo, otro orden)? → hay que actualizar el esquema de salida.
3. ¿Cambia lo que **acepta una petición** (campo nuevo, regla más estricta o más laxa)? → hay que actualizar el esquema de entrada.
4. ¿Hay **errores nuevos** o un error existente cambia de significado? → hay que documentarlos.
5. ¿Hay un **permiso o scope** nuevo, o una ruta cambia de quién puede llamarla? → hay que actualizar los scopes.
6. ¿Se **emite un evento** nuevo o cambia el contenido de uno? → hay que actualizarlo en webhooks y docs.
7. ¿Cambia la **API embebida** (exports, firmas, opciones)? → hay que actualizar la referencia y las guías.
8. ¿Un cliente con una versión anterior sigue funcionando? Si no, es un **cambio incompatible** y se trata como tal (Paso 5).

Si la respuesta a la 1 es "no" pero la función sí existe en la librería, escribe en el PR por qué no tiene sentido por HTTP. "Se me olvidó" no es una razón.

## Paso 2 — Actualizar la API HTTP (`packages/server`)

Todo está en una sola tabla de rutas. Los tests, el OpenAPI y la documentación leen esa misma lista, así que lo que no esté ahí no existe.

1. **Ruta**: define o edita la ruta con `defineRoute` en `packages/server/src/routes/` (el archivo según el área: `reads.ts`, `access.ts`, `teams.ts`, `policies.ts`, `invitations.ts`, `provisioning.ts`, `platform.ts`, `decisions.ts`, `delegated.ts`). Una ruta nueva se registra en `packages/server/src/routes/index.ts` (`allRoutes`). Cada ruta lleva `id`, método, ruta, resumen, descripción, `scope`, `errors`, esquema de entrada y de salida.
2. **Esquemas**: los de salida compartidos (por ejemplo el de miembro) están en `routes/schemas.ts`; los de entrada comunes en `routes/common.ts`. Si un dato nuevo aparece en una respuesta existente, añádelo ahí **como opcional** para no romper clientes antiguos. El servidor es estricto: rechaza campos desconocidos y da forma a la salida, así que un campo que no esté en el esquema **no sale**.
3. **Scope**: cada ruta pide **exactamente un** scope. Reutiliza uno existente si encaja. Si hace falta uno nuevo: añádelo a `packages/core/src/api/scopes.ts` (con descripción y `sensitive`), a la copia que usa Studio en `apps/studio/src/lib/api-scopes.ts` (un test falla si difieren) y revisa que la CLI (`uniora server keys create --scopes`) lo acepte. Un scope que actúa en nombre de un usuario es `sensitive: true`. No reutilices un scope que no corresponde solo por comodidad.
4. **Seguridad**: una ruta de escritura no debe permitir que un usuario final cambie datos de otro. Escribe un test que falle sin la protección. Si guarda datos que vienen de un tercero, valida, recorta y limita (tamaño, número de elementos, URLs solo http/https).
5. **Errores**: cada código nuevo se añade a los `errors` de la ruta y a `guides/errors.md`. Los códigos solo se añaden, nunca se renombran ni cambian de significado.
6. **Eventos**: si el cambio emite o altera un evento (outbox/webhooks), actualízalo en el emisor, en `guides/server.md` (sección de webhooks) y en sus pruebas.
7. **Ejemplo ejecutado**: añade en `packages/server/src/docs-tool/scenario.ts` un paso que llame a la ruta nueva o modificada. Hay un test que **falla si una ruta no tiene ejemplo ejecutado**. El ejemplo de la documentación sale de lo que el servidor responde de verdad.
8. **Tests de la ruta**: en el archivo `routes-*.test.ts` del área (o uno nuevo). Cubre el caso feliz, el scope que falta, un cliente sin acceso a esa organización, una entrada inválida, y el cuerpo exacto de la respuesta.

## Paso 3 — Regenerar lo derivado (nunca a mano)

Estos tres archivos se generan juntos desde la tabla de rutas y **se commitean**:

| Archivo | Qué es |
| --- | --- |
| `guides/server-api.md` | Referencia de la API, con ejemplos ejecutados |
| `guides/openapi.json` | Contrato máquina-legible (OpenAPI) |
| `packages/client/src/generated.ts` | Superficie tipada de `@uniora/client` |

Procedimiento:

```bash
pnpm build                                          # los paquetes se consumen por dist/
UPDATE_DOCS=1 pnpm --filter @uniora/server test     # regenera los tres
pnpm --filter @uniora/server test                   # sin la variable: debe pasar sin tocar nada
```

Revisa el diff generado: debe contener **exactamente** lo que querías cambiar y nada más. Un cambio inesperado en otro endpoint es una regresión de contrato.

## Paso 4 — Cliente, Studio, adaptadores, CLI y guías

- **`@uniora/client`** (`packages/client/src`): `generated.ts` ya sale del paso 3; si el cambio necesita lógica a mano (`client.ts`, `engine.ts`), escríbela y añade su prueba.
- **API embebida**: exporta lo nuevo en `packages/core/src/index.ts`, documenta en `guides/core-reference.md` y en la guía del área (`teams.md`, `policies.md`, `invitations.md`, `identity-adapters.md`, etc.). Los adaptadores de identidad mantienen la misma forma entre sí.
- **Almacenamiento**: lo que toca datos va en el repositorio del núcleo, en el almacenamiento en memoria, en **Postgres y SQLite** y en la suite compartida `packages/database/conformance`. Las migraciones son aditivas, con número nuevo en **los dos** adaptadores, nunca se editan tras un release, y se regenera el SQL con `pnpm sql:export`.
- **Studio** (`apps/studio`): si muestra o edita esos datos, actualízalo; el texto visible se traduce (clave en inglés y su par en español).
- **CLI y servidor**: si hay opciones o configuración nuevas, `guides/cli-and-studio.md` y `guides/server.md`.

## Paso 5 — Compatibilidad (los clientes externos no se actualizan a la vez)

- **Añadir es seguro; quitar o cambiar no.** Campo nuevo en una respuesta: opcional. Campo nuevo en una petición: opcional, con un valor por defecto que conserve el comportamiento anterior. Ruta nueva: sin tocar las existentes.
- **Prohibido sin aviso**: quitar o renombrar un campo, ruta o scope; hacer obligatorio un campo que no lo era; cambiar el tipo o el significado de algo; reutilizar un código de error. Si es inevitable: se anuncia en el CHANGELOG como **cambio incompatible**, se avisa en la descripción del PR, y se prefiere dejar el nombre viejo funcionando un release con aviso de obsolescencia.
- Un cliente que lleve la versión anterior del cliente HTTP debe seguir funcionando contra el servidor nuevo.

## Paso 6 — Verificación (todo en verde, sin saltarse nada)

```bash
pnpm build
pnpm typecheck
pnpm test          # necesita TEST_DATABASE_URL para Postgres real; SQLite y memoria van siempre
pnpm lint
node scripts/check-release.mjs     # coherencia de versiones y metadatos
```

Además:

- Corre `pnpm --filter @uniora/server test` **sin** `UPDATE_DOCS` y comprueba que los tres archivos generados no cambian.
- Si hay una ruta nueva, llámala de verdad con un servidor levantado (o con los tests de ruta, que usan uno real) y comprueba la respuesta y el error de un scope ausente.
- Nunca saltes, desactives o pongas en cuarentena un test para que pase.

## Paso 7 — Cierre

1. **CHANGELOG.md**: entrada bajo "Unreleased" que mencione explícitamente el efecto en la API HTTP (ruta nueva, campo nuevo, scope nuevo, error nuevo) y en la embebida, y las migraciones nuevas con su número.
2. **Descripción del PR**: una sección "API" que liste qué rutas, campos, scopes, errores y eventos cambian, o la razón escrita de que no cambia ninguno.
3. **Versión**: el release es en bloque (los 15 paquetes comparten versión) y se publica con un tag `vX.Y.Z`. Una API HTTP que cambia exige un release; `@uniora/server` y `@uniora/client` deben salir juntos. Antes de pedir el tag corre el chequeo de empaquetado (`pnpm -r build && pnpm check:packages`).
4. Dile a la persona **qué tiene que actualizar en sus proyectos** que usan UNIORA (paquetes, `uniora migrate`, claves con el scope nuevo) y qué comportamiento cambia para quien use el servidor externo.

## Lista de comprobación final (si falta una, no está terminado)

- [ ] Respondí por escrito las 8 preguntas del Paso 1.
- [ ] La ruta, el esquema de entrada y el de salida están actualizados (o dejé escrita la razón de que no aplica).
- [ ] El scope es exactamente uno por ruta, y si es nuevo está en Core, en Studio y en la CLI.
- [ ] Errores nuevos documentados; ninguno renombrado.
- [ ] Hay un paso ejecutado en `docs-tool/scenario.ts` para cada ruta nueva o cambiada.
- [ ] Regeneré `server-api.md`, `openapi.json` y `generated.ts` con `UPDATE_DOCS=1`, y sin la variable todo pasa sin cambios.
- [ ] Hay pruebas de la ruta (caso feliz, scope ausente, otra organización, entrada inválida).
- [ ] La API embebida está exportada y documentada; Postgres, SQLite y memoria pasan la misma suite.
- [ ] Nada se rompe para un cliente con la versión anterior (o está anunciado como incompatible).
- [ ] `build`, `typecheck`, `test` y `lint` en verde; no hay tests saltados.
- [ ] CHANGELOG y descripción del PR mencionan el efecto en las APIs.
