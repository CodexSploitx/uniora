<div align="center">

# UNIORA

**Universal Organization & Authorization**

Organizaciones, equipos, roles, permisos y feature flags — para cualquier proveedor de autenticación, sobre tu propia base de datos.

[![GitHub stars](https://img.shields.io/github/stars/CodexSploitx/uniora?style=social)](https://github.com/CodexSploitx/uniora)
![status](https://img.shields.io/badge/status-desarrollo%20temprano-orange)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)
![pnpm](https://img.shields.io/badge/monorepo-pnpm%20workspaces-yellow)

[English](README.md)

</div>

---

Tu proveedor de autenticación responde **"¿quién es este usuario?"**. No debería tener que responder también **"¿a qué organización pertenece, y qué puede hacer ahí?"** — es un problema distinto, uno que conviene mantener bajo control propio, sin importar qué proveedor de autenticación se elija hoy o al que se migre en el futuro.

**UNIORA es la capa que se coloca entre ambas preguntas.** No es un proveedor de autenticación — se conecta al que ya utilizas (Supabase, Clerk, Auth0, Better Auth) — y no es un SaaS: las organizaciones, membresías, roles, permisos y audit logs que administra viven en **tu propia base de datos**, no en la nuestra.

```text
Auth Provider                        UNIORA
     │                                  │
"¿Quién eres?"          "¿En qué organización estás? ¿Qué puedes hacer?
                         ¿Qué tiene habilitado tu organización?"
     │                                  │
     └────────────────┬─────────────────┘
                       ▼
                 ALLOW / DENY
```

## Por qué

- **Provider-agnostic.** Sustituye Supabase por Clerk, o añade Auth0 en paralelo, sin reescribir la lógica de autorización. `IdentityLinkRepository` incluso permite que un usuario migre de proveedor sin perder su organización, roles ni permisos.
- **Tu base de datos, tus reglas.** Ningún servicio central de UNIORA guarda tus datos. Todo vive en Postgres, bajo un schema dedicado `uniora.*` que no colisiona con las tablas de tu propia app.
- **Deny-by-default.** El `AuthorizationEngine` nunca otorga un acceso que no pueda justificar con confianza — permiso desconocido, membresía inexistente, organización incorrecta: siempre `DENY`, nunca un fallback silencioso a `ALLOW`.
- **Las organizaciones no pueden quedar huérfanas.** Toda organización nace con un Owner protegido, y `MembershipRepository` rechaza quitarle el role Owner o borrar una membership si es la última que lo tiene — reforzado con una constraint real de base de datos, no solo con código de aplicación.
- **Organizaciones *y* entitlements.** Los permisos responden "qué puede hacer este usuario"; las features responden "qué tiene desbloqueado esta organización". Son dos preguntas distintas, modeladas por separado, para que no tengas que simular una con la otra.
- **Core framework-independent.** `@uniora/core` no depende de Next.js, Express, ni de ningún driver de base de datos específico — los adapters se conectan alrededor.

## Vistazo rápido

```ts
import { createAuthorizationEngine, createMemoryStorage } from "@uniora/core";
// en producción, sustituye createMemoryStorage() por @uniora/postgres

const storage = createMemoryStorage();
const uniora = createAuthorizationEngine(storage);

const puedeBorrarVehiculo = await uniora.can({
  identity: { provider: "supabase", subject: userId },
  organizationId: orgId,
  permission: "vehicles.delete",
});

// Comprobación combinada de permiso + feature habilitada en la organización
const puedeUsarIA = await uniora.access.check({
  identity: { provider: "supabase", subject: userId },
  organizationId: orgId,
  permission: "assistant.use",
  feature: "ai_assistant",
});
```

Toda organización nace con exactamente un **Owner** protegido — creado de forma atómica junto con la organización, nunca como algo posterior:

```ts
import { createOrganizationWithOwner } from "@uniora/core";

const { organization, membership } = await createOrganizationWithOwner(storage, {
  organizationId: orgId,
  organizationName: "Acme Motors",
  // organizationSlug es opcional — se deriva del nombre si se omite
  // ("Acme Motors" -> "acme-motors"), y se valida y garantiza único en ambos casos.
  ownerRoleId: crypto.randomUUID(),
  membershipId: crypto.randomUUID(),
  ownerIdentity: { provider: "supabase", subject: userId },
});
// El owner de esa membership pasa cualquier chequeo de uniora.can(...) en esta
// organización, sin importar permissionKeys — revisa la documentación de
// @uniora/core para entender por qué.
```

Resolver la `identity` a partir de una sesión real es una sola llamada al adapter correspondiente:

```ts
import { resolveIdentity } from "@uniora/supabase"; // o @uniora/clerk, @uniora/auth0, @uniora/better-auth

const identity = await resolveIdentity(supabaseClient, accessToken); // Identity | null
```

Los adapters de identidad solo responden "¿quién es este subject?" — nunca "¿qué puede hacer?". Esa decisión es siempre del `AuthorizationEngine`.

El servidor calcula un `AuthorizationSnapshot` acotado; el cliente solo lo lee — `@uniora/react` nunca habla con tu base de datos:

```ts
// servidor (p. ej. un Server Component, una API route)
import { computeAuthorizationSnapshot } from "@uniora/core";

const snapshot = await computeAuthorizationSnapshot(engine, storage.features, {
  identity,
  organizationId,
  permissions: ["vehicles.create"],
  features: ["advanced_reports"],
});
```

```tsx
// cliente
import { UnioraProvider, Can, Feature } from "@uniora/react";

<UnioraProvider snapshot={snapshot}>
  <Can permission="vehicles.create">
    <CreateVehicleButton />
  </Can>
  <Feature feature="advanced_reports">
    <AdvancedReportsPanel />
  </Feature>
</UnioraProvider>
```

`<Can>`/`<Feature>`/`useCan`/`useFeature` son solo UX y deliberadamente headless (sin ningún sistema de diseño incluido) — ocultar un botón nunca sustituye a que el servidor autorice de forma independiente la operación real. Ver `apps/playground` para un ejemplo funcional completo construido con shadcn/ui + ReUI.

Específicamente para Next.js, `@uniora/next` conecta las piezas de arriba con los propios patrones del App Router — sin dependencia dura del paquete `next` en sí, solo `react.cache()` para memoización por request y las APIs estándar `Response`/`Request`:

```ts
// servidor — Server Action o Route Handler
import { assertCan, authorizeRoute } from "@uniora/next";

// lanza AuthorizationDeniedError — para un Server Action
await assertCan(engine, { identity, organizationId, permission: "vehicles.delete" });

// devuelve un Response | null listo para retornar — para un Route Handler
const denied = await authorizeRoute(engine, { identity, organizationId, permission: "vehicles.delete" });
if (denied) return denied;
```

## Paquetes

| Paquete | Qué hace |
| --- | --- |
| [`@uniora/core`](packages/core) | Modelo de dominio framework-independent: Organizations (con un role Owner protegido, creado de forma atómica), Custom Roles, Permissions, Features, Audit Logs, Identity Linking cross-provider, y el `AuthorizationEngine` deny-by-default. |
| [`@uniora/postgres`](packages/database/postgres) | Adapter de storage para PostgreSQL (schema dedicado `uniora.*`) + migraciones. |
| [`@uniora/supabase`](packages/adapters/supabase) | Adapter de identidad para Supabase Auth. |
| [`@uniora/clerk`](packages/adapters/clerk) | Adapter de identidad para Clerk. |
| [`@uniora/better-auth`](packages/adapters/better-auth) | Adapter de identidad para Better Auth. |
| [`@uniora/auth0`](packages/adapters/auth0) | Adapter de identidad para Auth0. |
| [`@uniora/react`](packages/react) | Helpers headless de React (`<Can>`, `<Feature>`, `useCan`, `useFeature`) sobre un `AuthorizationSnapshot` calculado en servidor. |
| [`@uniora/next`](packages/next) | Pegamento de Next.js: memoización por request (`react.cache()`) más los guards `assertCan`/`assertAccess`/`authorizeRoute` para Server Actions y Route Handlers. |
| [`@uniora/cli`](packages/cli) | `npx uniora init / check / migrate / doctor / studio` — con ledger de migraciones, salida `--json` y códigos de salida aptos para CI. |
| [`@uniora/studio`](apps/studio) | UNIORA Studio: una interfaz de administración local (Next.js + shadcn/ui + ReUI) para explorar y administrar organizaciones, miembros, roles, permisos, features y el audit log. Se abre con `npx uniora studio`. |

## Instalación y desarrollo local

Requiere Node.js, [pnpm](https://pnpm.io) y Docker (para Postgres local).

```bash
git clone https://github.com/CodexSploitx/uniora.git
cd uniora
pnpm install

docker compose up -d        # Postgres en localhost:55432
cp .env.example .env        # ajusta DATABASE_URL si cambiaste los valores por defecto

pnpm build       # build de todos los paquetes
pnpm typecheck   # typecheck de todo el monorepo
pnpm test        # todos los tests, incluyendo integración real contra Postgres
```

## CLI

Instálalo en tu proyecto (deja el comando `uniora` disponible para `npx`):

```bash
npm install --save-dev @uniora/cli
```

o ejecútalo una vez sin instalar nada: `npx @uniora/cli init`. (Usa el nombre con scope en esa forma puntual — un `npx uniora` a secas, fuera de un proyecto que ya tenga `@uniora/cli` instalado, resolvería a *otro* paquete de npm.)

```bash
npx uniora init      # crea uniora.config.mjs y .env.example en tu proyecto
npx uniora check     # valida la config y la conexión a la base de datos
npx uniora migrate   # aplica las migraciones pendientes de uniora.* (registradas en un ledger, aditivas, nunca destructivas)
npx uniora doctor    # diagnóstico más profundo: Node, .gitignore, config, DB, versión de PostgreSQL, migraciones, owners, Studio
npx uniora studio    # abre UNIORA Studio en local (--read-only, --port N, --no-open)
```

Pensado para correr también en CI, no solo en tu equipo:

```bash
npx uniora migrate --status --env production   # sale con 1 si hay migraciones pendientes o editadas tras aplicarse
npx uniora migrate --dry-run                   # ¿qué haría `migrate`? no toca nada
npx uniora doctor --json | jq '.checks[] | select(.severity != "ok")'
```

Todos los comandos aceptan `--config <archivo>`, `--env <nombre>` (carga `.env.<nombre>` — y solo ese, sin caer en silencio a tu `.env` de desarrollo) y `--json` (un único objeto JSON en stdout, que nunca contiene tu connection string). Códigos de salida: `0` ok · `1` algo falló · `2` uso incorrecto. `npx uniora <comando> --help` para más detalle.

**UNIORA Studio** es una interfaz de administración local sobre tu propia base de datos — un editor de roles y permisos, miembros, features por organización, un catálogo global de permisos/features y un registro de actividad de solo-anexar. Solo escucha en `127.0.0.1`, se desbloquea con un token aleatorio por ejecución y nunca envía datos a ningún lado. Cada cambio que hace queda auditado; `--read-only` lo convierte en un visor seguro.

## Principios de diseño

- **La autorización real ocurre siempre en el servidor.** Los componentes de cliente (`<Can>`, `<Feature>`) son azúcar de UX, nunca un límite de seguridad.
- **Explícito antes que implícito.** Toda operación con alcance de organización verifica membresía real — `userId + organizationId` nunca se trata como suficiente por sí solo.
- **Sin dependencias duras de SDKs de terceros.** Los adapters de identidad definen un contrato estructural mínimo; tu app provee el cliente real, ya configurado.
- **Migraciones aditivas.** Nada de lo que UNIORA corre contra tu base de datos es destructivo por defecto.

## Estado

UNIORA está en desarrollo activo (Roadmap V1.x). Publicado en npm bajo el scope [`@uniora`](https://www.npmjs.com/org/uniora) (`0.x`: la API aún puede cambiar entre versiones minor).

## Contribuir

Issues y pull requests son bienvenidos. El proyecto está en una etapa temprana, así que para cualquier cambio que exceda una corrección menor, se recomienda abrir primero una discusión.

## Licencia

UNIORA es **código disponible** (*source-available*) bajo la [PolyForm Shield License 1.0.0](LICENSE) — gratis de usar, pero no se puede vender.

- **Puedes** usarlo gratis en cualquier proyecto — personal, interno o comercial, incluido un SaaS o producto de pago que *dependa de* UNIORA — y leerlo, modificarlo y redistribuirlo (conservando la licencia y la línea `Required Notice`).
- **No puedes** usarlo para ofrecer un producto que compita con UNIORA — por ejemplo revenderlo, reempaquetarlo, u ofrecerlo (o un sustituto suyo) como tu propio producto o servicio, de pago o gratuito.

Es un resumen en lenguaje llano; lo único que rige es el archivo [`LICENSE`](LICENSE) (en inglés). Ten en cuenta que no es una licencia "open source" aprobada por la OSI.
