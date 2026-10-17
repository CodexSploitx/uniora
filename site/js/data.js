// Static content used by the interactive widgets (bilingual where it is shown to the visitor).

export const PKG = {
  core: { n: "@uniora/core", i: "npm install @uniora/core", d: { en: "Framework-independent domain model: organizations with a protected Owner (created atomically), custom roles, permissions, features, audit logs, cross-provider identity linking, invitations and the deny-by-default AuthorizationEngine.", es: "Modelo de dominio independiente del framework: organizaciones con un Owner protegido (creado de forma atómica), roles personalizados, permisos, features, logs de auditoría, vinculación de identidades entre proveedores, invitaciones y el AuthorizationEngine deny-por-defecto." } },
  postgres: { n: "@uniora/postgres", i: "npm install @uniora/postgres pg", d: { en: "PostgreSQL storage adapter in a dedicated uniora.* schema, plus migrations — and SQL functions for row-level security in your own tables.", es: "Adaptador de almacenamiento PostgreSQL en un esquema uniora.* dedicado, más migraciones — y funciones SQL para row-level security en tus propias tablas." } },
  sqlite: { n: "@uniora/sqlite", i: "npm install @uniora/sqlite better-sqlite3", d: { en: "SQLite adapter over better-sqlite3 (uniora_* tables) for local development, tests and single-node apps — held to the same behavioural test suite as Postgres.", es: "Adaptador SQLite sobre better-sqlite3 (tablas uniora_*) para desarrollo local, tests y apps de un solo nodo — sometido a la misma suite de comportamiento que Postgres." } },
  "mailer-smtp": { n: "@uniora/mailer-smtp", i: "npm install @uniora/mailer-smtp", d: { en: "SMTP sender for invitations, configured from UNIORA_SMTP_* in .env, with professional multilingual (en/es/pt/fr/de/it), dark-mode-aware templates.", es: "Emisor SMTP para invitaciones, configurado desde UNIORA_SMTP_* en .env, con plantillas profesionales multilingües (en/es/pt/fr/de/it) compatibles con modo oscuro." } },
  supabase: { n: "@uniora/supabase", i: "npm install @uniora/supabase", d: { en: "Identity adapter for Supabase Auth: turns a session into an Identity. It only ever answers “who is this?”.", es: "Adaptador de identidad para Supabase Auth: convierte una sesión en una Identity. Solo responde “¿quién es?”." } },
  clerk: { n: "@uniora/clerk", i: "npm install @uniora/clerk", d: { en: "Identity adapter for Clerk. No hard dependency on the SDK: your app supplies the already-configured client.", es: "Adaptador de identidad para Clerk. Sin dependencia dura del SDK: tu app aporta el cliente ya configurado." } },
  auth0: { n: "@uniora/auth0", i: "npm install @uniora/auth0", d: { en: "Identity adapter for Auth0, with provider-verified e-mail helpers for invitation acceptance.", es: "Adaptador de identidad para Auth0, con helpers de correo verificado por el proveedor para aceptar invitaciones." } },
  "better-auth": { n: "@uniora/better-auth", i: "npm install @uniora/better-auth", d: { en: "Identity adapter for Better Auth, so you can self-host authentication and still get organizations and roles.", es: "Adaptador de identidad para Better Auth, para autoalojar la autenticación y aun así tener organizaciones y roles." } },
  react: { n: "@uniora/react", i: "npm install @uniora/react", d: { en: "Headless React helpers — <Can>, <Feature>, useCan, useFeature — over a server-computed AuthorizationSnapshot. UX only; never a security boundary.", es: "Helpers headless de React — <Can>, <Feature>, useCan, useFeature — sobre un AuthorizationSnapshot calculado en el servidor. Solo UX; nunca una frontera de seguridad." } },
  next: { n: "@uniora/next", i: "npm install @uniora/next", d: { en: "Next.js glue: request-scoped memoization with react.cache(), assertCan / assertAccess / authorizeRoute guards for Server Actions and Route Handlers, and invitation route helpers.", es: "Pegamento para Next.js: memoización por request con react.cache(), guards assertCan / assertAccess / authorizeRoute para Server Actions y Route Handlers, y helpers de rutas de invitación." } },
  express: { n: "@uniora/express", i: "npm install @uniora/express", d: { en: "Deny-by-default route middleware (requirePermission, requireFeature, authorize): answers 401/403 and fails closed on any error. Works with Express 4 and 5.", es: "Middleware de rutas deny-por-defecto (requirePermission, requireFeature, authorize): responde 401/403 y falla cerrado ante cualquier error. Funciona con Express 4 y 5." } },
  server: { n: "@uniora/server", i: "npm install @uniora/server", d: { en: "UNIORA as its own self-hosted HTTP API: API keys with scopes and organization lists, decisions, delegated changes on behalf of an end user, sign-up and invitations.", es: "UNIORA como su propia API HTTP autoalojada: API keys con scopes y listas de organizaciones, decisiones, cambios delegados en nombre de un usuario final, sign-up e invitaciones." } },
  client: { n: "@uniora/client", i: "npm install @uniora/client", d: { en: "The typed client of that API for your backend, with retries and a remote AuthorizationEngine for the Express and Next guards.", es: "El cliente tipado de esa API para tu backend, con reintentos y un AuthorizationEngine remoto para los guards de Express y Next." } },
  cli: { n: "@uniora/cli", i: "npm install --save-dev @uniora/cli", d: { en: "npx uniora init / check / migrate / doctor / studio — with a migration ledger, --json output and CI-friendly exit codes.", es: "npx uniora init / check / migrate / doctor / studio — con ledger de migraciones, salida --json y códigos de salida aptos para CI." } },
  studio: { n: "@uniora/studio", i: "npx uniora studio", d: { en: "UNIORA Studio: a local-first admin UI (Next.js + shadcn/ui + ReUI) to browse and manage organizations, members, roles, permissions, features and the audit log.", es: "UNIORA Studio: una UI de administración local-first (Next.js + shadcn/ui + ReUI) para explorar y gestionar organizaciones, miembros, roles, permisos, features y el log de auditoría." } },
};

export const CODE = {
  core: { c: `import { createAuthorizationEngine, createMemoryStorage } from "@uniora/core";
// swap createMemoryStorage() for @uniora/postgres (or @uniora/sqlite) in production

const storage = createMemoryStorage();
const uniora = createAuthorizationEngine(storage);

const canDeleteVehicle = await uniora.can({
  identity: { provider: "supabase", subject: userId },
  organizationId: orgId,
  permission: "vehicles.delete",
});

// Combined permission + feature-entitlement check
const canUseAI = await uniora.access.check({
  identity: { provider: "supabase", subject: userId },
  organizationId: orgId,
  permission: "assistant.use",
  feature: "ai_assistant",
});`, n: { en: "Permissions answer “what can this user do”; features answer “what has this organization unlocked”. Two questions, one call.", es: "Los permisos responden “qué puede hacer este usuario”; las features, “qué ha desbloqueado esta organización”. Dos preguntas, una llamada." } },
  owner: { c: `import { createOrganizationWithOwner } from "@uniora/core";

const { organization, membership } = await createOrganizationWithOwner(storage, {
  organizationId: orgId,
  organizationName: "Acme Motors",   // slug derived: "acme-motors"
  ownerRoleId: crypto.randomUUID(),
  membershipId: crypto.randomUUID(),
  ownerIdentity: { provider: "supabase", subject: userId },
});
// The Owner now passes every uniora.can(...) check for this organization.
// And the last Owner can never be removed, blocked or demoted.`, n: { en: "Every organization is born with exactly one protected Owner — created atomically, never as an afterthought.", es: "Cada organización nace con exactamente un Owner protegido — creado de forma atómica, nunca como una ocurrencia tardía." } },
  express: { c: `import { requirePermission, requireFeature } from "@uniora/express";

app.delete(
  "/orgs/:orgId/vehicles/:id",
  requirePermission(engine, "vehicles.delete", {
    // identity: whatever your auth middleware resolved
    resolve: (req) => req.identity && { identity: req.identity, organizationId: req.params.orgId },
  }),
  deleteVehicle,
);
// 401 when the caller is unknown, 403 when the engine denies,
// and any error goes to next(err): a failure never lets a request through.`, n: { en: "Fails closed. Works with Express 4 and 5 — no dependency on the express package itself.", es: "Falla cerrado. Funciona con Express 4 y 5 — sin dependencia del paquete express." } },
  next: { c: `import { assertCan, authorizeRoute } from "@uniora/next";

// Server Action — throws AuthorizationDeniedError
await assertCan(engine, { identity, organizationId, permission: "vehicles.delete" });

// Route Handler — returns a ready-to-return Response | null
const denied = await authorizeRoute(engine, { identity, organizationId, permission: "vehicles.delete" });
if (denied) return denied;`, n: { en: "Request-scoped memoization with react.cache(), plus guards for Server Actions and Route Handlers.", es: "Memoización por request con react.cache(), más guards para Server Actions y Route Handlers." } },
  react: { c: `// server: compute a bounded snapshot
const snapshot = await computeAuthorizationSnapshot(engine, storage.features, {
  identity, organizationId,
  permissions: ["vehicles.create"],
  features: ["advanced_reports"],
});

// client: just read it
<UnioraProvider snapshot={snapshot}>
  <Can permission="vehicles.create"><CreateVehicleButton /></Can>
  <Feature feature="advanced_reports"><AdvancedReportsPanel /></Feature>
</UnioraProvider>`, n: { en: "@uniora/react never talks to your database. Hiding a button is never a substitute for the server authorizing the real operation.", es: "@uniora/react nunca habla con tu base de datos. Ocultar un botón nunca sustituye a que el servidor autorice la operación real." } },
  sqlite: { c: `import Database from "better-sqlite3";
import { applyMigrations, createSqliteStorage } from "@uniora/sqlite";

const db = new Database("app.db");
db.pragma("journal_mode = WAL"); // recommended for a file shared by several processes
applyMigrations(db);             // synchronous and idempotent — safe on every start
const storage = createSqliteStorage(db);`, n: { en: "Same UnioraStorage as Postgres, held to the same behavioural suite — including the concurrency and security regressions.", es: "El mismo UnioraStorage que Postgres, sometido a la misma suite de comportamiento — incluidas las regresiones de concurrencia y seguridad." } },
};

export const LIC = {
  yes: [
    ["commercial", { en: "Commercial product", es: "Producto comercial" }, { en: "Permitted. Personal, internal and commercial use is allowed at no cost.", es: "Permitido. El uso personal, interno y comercial está permitido sin costo." }],
    ["saas", { en: "Paid SaaS built on UNIORA", es: "SaaS de pago construido sobre UNIORA" }, { en: "Permitted. A paid SaaS or product built on UNIORA is within the license, and you do not have to publish your own code.", es: "Permitido. Un SaaS o producto de pago construido sobre UNIORA está dentro de la licencia, y no tienes que publicar tu propio código." }],
    ["modify", { en: "Modifying the source", es: "Modificar el código" }, { en: "Permitted. You may make changes and derivative works for any purpose. Mark the files you changed.", es: "Permitido. Puedes hacer cambios y obras derivadas para cualquier propósito. Indica los archivos que cambiaste." }],
    ["redistribute", { en: "Redistribution", es: "Redistribución" }, { en: "Permitted, provided recipients also receive the license text and the NOTICE file.", es: "Permitido, siempre que quienes lo reciban obtengan también el texto de la licencia y el archivo NOTICE." }],
    ["competing", { en: "A competing authorization service", es: "Un servicio de autorización competidor" }, { en: "Permitted. Apache-2.0 has no field-of-use restriction, so competing products are allowed.", es: "Permitido. Apache-2.0 no restringe el ámbito de uso, así que los productos competidores están permitidos." }],
  ],
  no: [
    ["trademark", { en: "Using the UNIORA name or logo as your own", es: "Usar el nombre o el logo de UNIORA como propios" }, { en: "Not permitted. The license grants no trademark rights, except to describe where the work comes from.", es: "No permitido. La licencia no concede derechos de marca, salvo para describir el origen de la obra." }],
    ["strip", { en: "Removing the license or notices", es: "Quitar la licencia o los avisos" }, { en: "Not permitted. Anyone who receives a copy from you must also receive the license text and the NOTICE file.", es: "No permitido. Quien reciba una copia tuya debe recibir también el texto de la licencia y el archivo NOTICE." }],
    ["warranty", { en: "Expecting a warranty", es: "Esperar una garantía" }, { en: "Not provided. UNIORA is offered as is, without warranties or liability from its authors.", es: "No se ofrece. UNIORA se entrega tal cual, sin garantías ni responsabilidad de sus autores." }],
  ],
};

// Hotspots over the real Studio screenshots: [x%, y%, text]
export const SPOTS = {
  overview: [
    [28, 29, { en: "Live totals for organizations, members, roles, permissions and features.", es: "Totales en vivo de organizaciones, miembros, roles, permisos y features." }],
    [82.5, 56, { en: "Recent activity is read from the append-only audit log.", es: "La actividad reciente se lee del log de auditoría solo-añadir." }],
    [8.8, 94.4, { en: "Local database. Data never leaves this machine.", es: "Base de datos local. Los datos nunca salen de esta máquina." }],
  ],
  members: [
    [46, 54, { en: "The Owner role is protected: it is created with the organization.", es: "El rol Owner está protegido: se crea junto con la organización." }],
    [94, 54, { en: "The last Owner cannot be removed, blocked or demoted.", es: "El último Owner no puede eliminarse, bloquearse ni degradarse." }],
    [92.7, 37, { en: "Add a member and assign one or more roles.", es: "Añade un miembro y asigna uno o más roles." }],
  ],
  roles: [
    [26.5, 69, { en: "Owner has full access to the organization.", es: "El Owner tiene acceso completo a la organización." }],
    [54, 57.8, { en: "Permissions are granted per role. billing.manage is not granted to Administrator.", es: "Los permisos se conceden por rol. billing.manage no está concedido a Administrator." }],
    [24.4, 37, { en: "Create custom roles for each organization.", es: "Crea roles personalizados para cada organización." }],
  ],
  permissions: [
    [76, 34, { en: "Shows how many roles hold each permission.", es: "Muestra cuántos roles tienen cada permiso." }],
    [75.8, 45, { en: "billing.manage is registered but granted to no role yet.", es: "billing.manage está registrado pero aún no se concede a ningún rol." }],
    [90, 23.6, { en: "Register a permission in the global catalog.", es: "Registra un permiso en el catálogo global." }],
  ],
  features: [
    [78.8, 35, { en: "Adoption of each feature across organizations.", es: "Adopción de cada feature entre las organizaciones." }],
    [78.8, 49.8, { en: "api_access is enabled in all five organizations.", es: "api_access está habilitada en las cinco organizaciones." }],
    [22, 23.6, { en: "Features are capabilities an organization can unlock.", es: "Las features son capacidades que una organización puede desbloquear." }],
  ],
  activity: [
    [22.5, 29, { en: "Each change is written to the audit log in the same transaction.", es: "Cada cambio se escribe en el log de auditoría en la misma transacción." }],
    [43, 19, { en: "Studio is the only writer of these entries.", es: "Studio es el único que escribe estas entradas." }],
    [8.8, 94.4, { en: "Everything shown is stored in your own database.", es: "Todo lo que se muestra está almacenado en tu propia base de datos." }],
  ],
};
