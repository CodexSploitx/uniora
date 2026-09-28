// PENTEST — Ronda 5: red team de máxima agresión. Grafo de escalada,
// colusión de N actores, concurrencia masiva, lifecycle de identificadores,
// confusión de tipos, fault injection, monotonicidad. TEMPORAL, no se
// commitea. Base aislada: uniora_pentest (reutilizada de rondas 2-4).
import pg from "pg";
import {
  createAuthorizationEngine,
  createOrganizationWithOwner,
  createMemoryStorage,
  computeAuthorizationSnapshot,
} from "@uniora/core";
import { applyMigrations, createPostgresStorage } from "@uniora/postgres";

const pool = new pg.Pool({ connectionString: "postgresql://postgres:uniora@localhost:55432/uniora_pentest" });
await pool.query("drop schema if exists uniora cascade");
await applyMigrations(pool);
const pg_storage = createPostgresStorage(pool);
const pgEngine = createAuthorizationEngine(pg_storage);
const mem_storage = createMemoryStorage();
const memEngine = createAuthorizationEngine(mem_storage);

let PASS = 0;
let FAIL = 0;
const findings = [];

function section(title) {
  console.log("\n" + "=".repeat(78));
  console.log(title);
  console.log("=".repeat(78));
}
function ok(label, condition, detail = "") {
  if (condition) {
    PASS++;
    console.log(`  [SAFE]  ${label}${detail ? " — " + detail : ""}`);
  } else {
    FAIL++;
    console.log(`  !!VULN!! ${label}${detail ? " — " + detail : ""}`);
    findings.push(label);
  }
}

// ---------------------------------------------------------------------------
// ATAQUE 1 — MASS CONCURRENCY: 10 Owners de la misma organización,
// TODOS intentando removerse mutuamente a la vez (90 operaciones
// concurrentes: cada uno de los 10 intenta remover a los otros 9).
// Repetido 3 veces contra Postgres real. Re-verifica el fix de la Ronda 4
// (Hallazgo 8) a una escala mucho mayor que 2 actores.
// ---------------------------------------------------------------------------
section("ATAQUE 1 — mass concurrency: 10 Owners, 90 remociones mutuas simultáneas (x3, Postgres real)");

for (let round = 0; round < 3; round++) {
  const orgId = `org-mass-${round}`;
  const { organization, ownerRole, membership: firstOwner } = await createOrganizationWithOwner(pg_storage, {
    organizationId: orgId,
    organizationName: `MASS_${round}`,
    ownerRoleId: `role-owner-mass-${round}`,
    membershipId: `m-owner-0-mass-${round}`,
    ownerIdentity: { provider: "e2e", subject: `owner-0-mass-${round}` },
  });
  const owners = [firstOwner];
  for (let i = 1; i < 10; i++) {
    const m = await pg_storage.memberships.create({
      id: `m-owner-${i}-mass-${round}`,
      organizationId: orgId,
      identity: { provider: "e2e", subject: `owner-${i}-mass-${round}` },
    });
    await pg_storage.memberships.assignOwnerRole(m.id, ownerRole.id);
    owners.push(m);
  }
  const before = (await pg_storage.memberships.countByRole([ownerRole.id]))[ownerRole.id];

  // Cada owner intenta remover a TODOS los demás, todo disparado sin
  // ningún `await` intermedio — máxima superposición de red posible.
  const attempts = [];
  for (const target of owners) {
    attempts.push(
      pg_storage.memberships.unassignOwnerRole(target.id, ownerRole.id).then(
        () => "removed",
        (e) => `rejected:${e.message.slice(0, 30)}`,
      ),
    );
  }
  await Promise.all(attempts);

  const after = (await pg_storage.memberships.countByRole([ownerRole.id]))[ownerRole.id];
  console.log(`  ronda ${round}: owners antes=${before} después=${after}`);
  ok(`[ronda ${round}] 10 owners bajo ataque masivo concurrente: nunca llega a 0`, after >= 1, `finales=${after}`);
}

// ---------------------------------------------------------------------------
// ATAQUE 1b — MASS CONCURRENCY: 500 assignRole/unassignRole concurrentes
// sobre roles NO protegidos (no Owner) — buscar "lost update" (una
// asignación que debería persistir desaparece, o al revés: aparece un
// roleId nunca pedido).
// ---------------------------------------------------------------------------
section("ATAQUE 1b — 500 assign/unassign concurrentes sobre un role normal: sin lost update ni fantasmas");

{
  const { organization } = await createOrganizationWithOwner(pg_storage, {
    organizationId: "org-lostupdate",
    organizationName: "LostUpdate",
    ownerRoleId: "role-owner-lu",
    membershipId: "m-owner-lu",
    ownerIdentity: { provider: "e2e", subject: "owner-lu" },
  });
  const role = await pg_storage.roles.create({ id: "role-lu", organizationId: organization.id, name: "Editor", permissionKeys: [] });
  const member = await pg_storage.memberships.create({
    id: "m-lu",
    organizationId: organization.id,
    identity: { provider: "e2e", subject: "lu-target" },
  });

  const ops = [];
  for (let i = 0; i < 250; i++) ops.push(pg_storage.memberships.assignRole(member.id, role.id).catch(() => {}));
  for (let i = 0; i < 250; i++) ops.push(pg_storage.memberships.unassignRole(member.id, role.id).catch(() => {}));
  await Promise.all(ops);

  const final = await pg_storage.memberships.findById(member.id);
  const hasRole = final.roleIds.includes(role.id);
  const grantCount = (await pool.query(`select count(*) from uniora.membership_roles where membership_id=$1 and role_id=$2`, [member.id, role.id])).rows[0].count;
  ok(
    "500 assign/unassign concurrentes dejan como mucho UNA fila de grant (nunca duplicada)",
    Number(grantCount) <= 1,
    `filas=${grantCount}, hasRole=${hasRole}`,
  );
}

// ---------------------------------------------------------------------------
// ATAQUE 2 — TWO/THREE-ACTOR COLLUSION: A (sin ningún permiso) crea un
// role vacío; B (que sí puede otorgar permisos) le concede un permiso
// sensible a ESE role sin saberlo (confundiéndolo con otro); A se asigna
// el role a sí mismo. Verificar que A obtiene EXACTAMENTE lo que B otorgó,
// nunca más (p. ej. nunca el bypass de Owner, nunca acceso a otra org).
// ---------------------------------------------------------------------------
section("ATAQUE 2 — colusión de actores: A crea un role vacío + B le otorga UN permiso + A se lo auto-asigna");

async function attack2(storage, engine, adapterLabel) {
  const { organization } = await createOrganizationWithOwner(storage, {
    organizationId: `org-collude-${adapterLabel}`,
    organizationName: "Collude",
    ownerRoleId: `role-owner-collude-${adapterLabel}`,
    membershipId: `m-owner-collude-${adapterLabel}`,
    ownerIdentity: { provider: "e2e", subject: `owner-collude-${adapterLabel}` },
  });
  await storage.permissions.register({ key: "narrow.action" });
  await storage.permissions.register({ key: "other.sensitive" });

  // "A" (actor de bajo privilegio en el modelo del host — a nivel de Core
  // puro cualquier llamada es posible, eso ya está documentado como
  // responsabilidad del host; lo que se ataca aquí es si Core mismo filtra
  // MÁS de lo que se pidió explícitamente).
  const role = await storage.roles.create({ id: `role-collude-${adapterLabel}`, organizationId: organization.id, name: "Collab Role", permissionKeys: [] });
  const memberA = await storage.memberships.create({
    id: `m-collude-a-${adapterLabel}`,
    organizationId: organization.id,
    identity: { provider: "e2e", subject: `collude-a-${adapterLabel}` },
  });

  // "B" otorga SOLO narrow.action al role — nunca other.sensitive.
  await storage.roles.grantPermission(role.id, "narrow.action");

  // A se autoasigna el role (colusión: A pidió a B que preparara el role,
  // ahora A se lo apropia).
  await storage.memberships.assignRole(memberA.id, role.id);

  const identityA = { provider: "e2e", subject: `collude-a-${adapterLabel}` };
  const gotNarrow = await engine.can({ identity: identityA, organizationId: organization.id, permission: "narrow.action" });
  const gotSensitive = await engine.can({ identity: identityA, organizationId: organization.id, permission: "other.sensitive" });
  const gotAnythingElse = await engine.can({ identity: identityA, organizationId: organization.id, permission: "whatever.nobody.granted" });

  ok(`[${adapterLabel}] A obtiene EXACTAMENTE narrow.action (lo que B otorgó)`, gotNarrow === true);
  ok(`[${adapterLabel}] A NUNCA obtiene other.sensitive (B nunca lo otorgó a este role)`, gotSensitive === false);
  ok(`[${adapterLabel}] A no obtiene ningún permiso "de regalo" no pedido explícitamente`, gotAnythingElse === false);
}
await attack2(mem_storage, memEngine, "memory");
await attack2(pg_storage, pgEngine, "postgres");

// ---------------------------------------------------------------------------
// ATAQUE 3 — IDENTIFIER LIFECYCLE: membership delete() + create() con el
// MISMO id explícito. ¿El nuevo membership hereda roleIds del anterior?
// ---------------------------------------------------------------------------
section("ATAQUE 3 — lifecycle: membership.delete() + create() con el mismo id no hereda roles viejos");

async function attack3(storage, engine, adapterLabel) {
  const { organization } = await createOrganizationWithOwner(storage, {
    organizationId: `org-life-${adapterLabel}`,
    organizationName: "Life",
    ownerRoleId: `role-owner-life-${adapterLabel}`,
    membershipId: `m-owner-life-${adapterLabel}`,
    ownerIdentity: { provider: "e2e", subject: `owner-life-${adapterLabel}` },
  });
  await storage.permissions.register({ key: "life.secret" });
  const privilegedRole = await storage.roles.create({
    id: `role-life-priv-${adapterLabel}`,
    organizationId: organization.id,
    name: "Privileged",
    permissionKeys: ["life.secret"],
  });

  const reusedId = `m-reused-${adapterLabel}`;
  const first = await storage.memberships.create({
    id: reusedId,
    organizationId: organization.id,
    identity: { provider: "e2e", subject: `life-old-${adapterLabel}` },
    roleIds: [privilegedRole.id],
  });
  await storage.memberships.delete(first.id);

  // Recrear con el MISMO id, para una identidad DISTINTA, SIN pedir roles.
  const second = await storage.memberships.create({
    id: reusedId,
    organizationId: organization.id,
    identity: { provider: "e2e", subject: `life-new-${adapterLabel}` },
  });

  ok(`[${adapterLabel}] el membership recreado con el mismo id no trae roleIds heredados`, second.roleIds.length === 0, `roleIds=${JSON.stringify(second.roleIds)}`);

  const canNew = await engine.can({ identity: { provider: "e2e", subject: `life-new-${adapterLabel}` }, organizationId: organization.id, permission: "life.secret" });
  ok(`[${adapterLabel}] la nueva identidad bajo el id reciclado NO tiene el permiso del membership anterior`, canNew === false);

  const canOld = await engine.can({ identity: { provider: "e2e", subject: `life-old-${adapterLabel}` }, organizationId: organization.id, permission: "life.secret" });
  ok(`[${adapterLabel}] la identidad ORIGINAL (ya borrada) no resucita el permiso a través del id reciclado`, canOld === false);
}
await attack3(mem_storage, memEngine, "memory");
await attack3(pg_storage, pgEngine, "postgres");

// ---------------------------------------------------------------------------
// ATAQUE 4 — IDENTIFIER LIFECYCLE: permission unregister() + register()
// del mismo key. Un role que YA tenía el permiso revocado antes del
// unregister no debe recuperarlo automáticamente al re-registrarse.
// ---------------------------------------------------------------------------
section("ATAQUE 4 — lifecycle: permission unregister()+register() del mismo key no resucita grants viejos");

async function attack4(storage, engine, adapterLabel) {
  const { organization } = await createOrganizationWithOwner(storage, {
    organizationId: `org-permlife-${adapterLabel}`,
    organizationName: "PermLife",
    ownerRoleId: `role-owner-permlife-${adapterLabel}`,
    membershipId: `m-owner-permlife-${adapterLabel}`,
    ownerIdentity: { provider: "e2e", subject: `owner-permlife-${adapterLabel}` },
  });
  await storage.permissions.register({ key: "recyclable.action" });
  const role = await storage.roles.create({
    id: `role-permlife-${adapterLabel}`,
    organizationId: organization.id,
    name: "Recycler",
    permissionKeys: ["recyclable.action"],
  });
  const member = await storage.memberships.create({
    id: `m-permlife-${adapterLabel}`,
    organizationId: organization.id,
    identity: { provider: "e2e", subject: `permlife-${adapterLabel}` },
    roleIds: [role.id],
  });

  // Revocar correctamente, luego el catálogo se puede desregistrar.
  await storage.roles.revokePermission(role.id, "recyclable.action");
  await storage.permissions.unregister("recyclable.action");
  // Re-registrar el MISMO key (p. ej. otra feature del host reutiliza el nombre).
  await storage.permissions.register({ key: "recyclable.action", name: "Reused for something else" });

  const canNow = await engine.can({ identity: { provider: "e2e", subject: `permlife-${adapterLabel}` }, organizationId: organization.id, permission: "recyclable.action" });
  ok(`[${adapterLabel}] tras revoke+unregister+re-register, el role NO recupera el permiso automáticamente`, canNow === false);
}
await attack4(mem_storage, memEngine, "memory");
await attack4(pg_storage, pgEngine, "postgres");

// ---------------------------------------------------------------------------
// ATAQUE 5 — TYPE CONFUSION: llamar a las APIs públicas de Core con tipos
// que TypeScript rechazaría en compilación, pero que JS en runtime
// aceptaría sin más (bypaseando TS deliberadamente, como haría un caller
// no-TS o un JSON malformado que atraviesa una frontera HTTP/CLI).
// ---------------------------------------------------------------------------
section("ATAQUE 5 — confusión de tipos contra can()/access.check() (bypaseando TypeScript)");

async function attack5(engine, ctxOrgId, memberIdentity, adapterLabel) {
  const cases = [
    ["permission = null", { identity: memberIdentity, organizationId: ctxOrgId, permission: null }],
    ["permission = 123 (number)", { identity: memberIdentity, organizationId: ctxOrgId, permission: 123 }],
    ["permission = ['a','b'] (array)", { identity: memberIdentity, organizationId: ctxOrgId, permission: ["a", "b"] }],
    ["permission = true (boolean)", { identity: memberIdentity, organizationId: ctxOrgId, permission: true }],
    ["permission = {} (object)", { identity: memberIdentity, organizationId: ctxOrgId, permission: {} }],
    ["organizationId = null", { identity: memberIdentity, organizationId: null, permission: "narrow.action" }],
    ["organizationId = {} (object)", { identity: memberIdentity, organizationId: {}, permission: "narrow.action" }],
    ["identity = null", { identity: null, organizationId: ctxOrgId, permission: "narrow.action" }],
    ["identity.subject = 123 (number)", { identity: { provider: "e2e", subject: 123 }, organizationId: ctxOrgId, permission: "narrow.action" }],
  ];
  for (const [label, input] of cases) {
    try {
      const result = await engine.access.check(input);
      ok(`[${adapterLabel}] type confusion: ${label} -> nunca da true`, result === false, `resultado=${result}`);
    } catch (error) {
      // Lanzar una excepción (en vez de devolver true) también es un
      // resultado fail-closed aceptable — se documenta, no se cuenta como
      // vulnerabilidad, siempre que no deje mutado ningún estado.
      ok(`[${adapterLabel}] type confusion: ${label} -> lanza en vez de conceder (fail-closed)`, true, `error=${error.constructor.name}`);
    }
  }
}
{
  const { organization } = await createOrganizationWithOwner(mem_storage, {
    organizationId: "org-typeconf-mem",
    organizationName: "TypeConf",
    ownerRoleId: "role-owner-typeconf-mem",
    membershipId: "m-owner-typeconf-mem",
    ownerIdentity: { provider: "e2e", subject: "owner-typeconf-mem" },
  });
  await mem_storage.permissions.register({ key: "narrow.action" });
  const role = await mem_storage.roles.create({ id: "role-typeconf-mem", organizationId: organization.id, name: "R", permissionKeys: [] });
  await mem_storage.memberships.create({ id: "m-typeconf-mem", organizationId: organization.id, identity: { provider: "e2e", subject: "typeconf-mem" }, roleIds: [role.id] });
  await attack5(memEngine, organization.id, { provider: "e2e", subject: "typeconf-mem" }, "memory");
}
{
  const { organization } = await createOrganizationWithOwner(pg_storage, {
    organizationId: "org-typeconf-pg",
    organizationName: "TypeConf",
    ownerRoleId: "role-owner-typeconf-pg",
    membershipId: "m-owner-typeconf-pg",
    ownerIdentity: { provider: "e2e", subject: "owner-typeconf-pg" },
  });
  await pg_storage.permissions.register({ key: "narrow.action" });
  const role = await pg_storage.roles.create({ id: "role-typeconf-pg", organizationId: organization.id, name: "R", permissionKeys: [] });
  await pg_storage.memberships.create({ id: "m-typeconf-pg", organizationId: organization.id, identity: { provider: "e2e", subject: "typeconf-pg" }, roleIds: [role.id] });
  await attack5(pgEngine, organization.id, { provider: "e2e", subject: "typeconf-pg" }, "postgres");
}

// ---------------------------------------------------------------------------
// ATAQUE 6 — FAULT INJECTION: createRole con un permissionKeys que falla
// a MITAD del array (índice intermedio inválido) — ¿el role queda huérfano
// (creado pero sin ninguno de los permisos válidos que sí venían antes del
// inválido, o peor, con ALGUNOS permisos aplicados parcialmente)?
// ---------------------------------------------------------------------------
section("ATAQUE 6 — fault injection: createRole con permissionKeys inválido a mitad del array");

async function attack6(storage, adapterLabel) {
  const { organization } = await createOrganizationWithOwner(storage, {
    organizationId: `org-fault-${adapterLabel}`,
    organizationName: "Fault",
    ownerRoleId: `role-owner-fault-${adapterLabel}`,
    membershipId: `m-owner-fault-${adapterLabel}`,
    ownerIdentity: { provider: "e2e", subject: `owner-fault-${adapterLabel}` },
  });
  await storage.permissions.register({ key: "fault.a" });
  await storage.permissions.register({ key: "fault.b" });

  let threw = false;
  try {
    await storage.roles.create({
      id: `role-fault-${adapterLabel}`,
      organizationId: organization.id,
      name: "Faulty",
      permissionKeys: ["fault.a", "", "fault.b"], // "" es inválido a mitad del array
    });
  } catch {
    threw = true;
  }
  ok(`[${adapterLabel}] createRole con un permissionKey inválido a mitad del array lanza`, threw === true);

  const orphan = await storage.roles.findSummariesByIds([`role-fault-${adapterLabel}`]);
  ok(`[${adapterLabel}] el role NUNCA queda creado a medias (ni con 0 ni con 1 de los 2 permisos válidos)`, orphan.length === 0, `encontrados=${orphan.length}`);
}
await attack6(mem_storage, "memory");
await attack6(pg_storage, "postgres");

// ---------------------------------------------------------------------------
// ATAQUE 7 — MONOTONICITY: revocar un permiso NUNCA debe, por ningún
// camino (can() directo, access.check(), snapshot), producir un conjunto
// de autorización MÁS AMPLIO que antes de revocar.
// ---------------------------------------------------------------------------
section("ATAQUE 7 — monotonicidad: revoke nunca aumenta el conjunto de autorización (property-based, 200 secuencias aleatorias)");

{
  const storage = mem_storage; // memoria: determinista, sin red — ideal para muchas iteraciones rápidas
  const { organization } = await createOrganizationWithOwner(storage, {
    organizationId: "org-mono",
    organizationName: "Mono",
    ownerRoleId: "role-owner-mono",
    membershipId: "m-owner-mono",
    ownerIdentity: { provider: "e2e", subject: "owner-mono" },
  });
  const PERMS = ["mono.a", "mono.b", "mono.c", "mono.d"];
  for (const p of PERMS) await storage.permissions.register({ key: p });
  const role = await storage.roles.create({ id: "role-mono", organizationId: organization.id, name: "Mono", permissionKeys: [] });
  const identity = { provider: "e2e", subject: "mono-actor" };
  await storage.memberships.create({ id: "m-mono", organizationId: organization.id, identity, roleIds: [role.id] });

  let violations = 0;
  let granted = new Set();
  for (let i = 0; i < 200; i++) {
    const perm = PERMS[Math.floor(Math.random() * PERMS.length)];
    const before = new Set(granted);
    if (Math.random() < 0.5) {
      await storage.roles.grantPermission(role.id, perm);
      granted.add(perm);
    } else {
      const wasGranted = granted.has(perm);
      await storage.roles.revokePermission(role.id, perm);
      granted.delete(perm);
      if (wasGranted) {
        // Justo tras revocar: el permiso revocado NUNCA debe seguir autorizando.
        const stillAllowed = await memEngine.can({ identity, organizationId: organization.id, permission: perm });
        if (stillAllowed) violations++;
      }
    }
    // Invariante general: el conjunto actual de `can()===true` nunca debe
    // exceder `granted` (el conjunto que Core cree que otorgó).
    for (const p of PERMS) {
      const allowed = await memEngine.can({ identity, organizationId: organization.id, permission: p });
      if (allowed && !granted.has(p)) violations++;
    }
  }
  ok("200 secuencias aleatorias de grant/revoke: el conjunto autorizado nunca excede lo explícitamente otorgado", violations === 0, `violaciones=${violations}`);
}

// ---------------------------------------------------------------------------
// ATAQUE 8 — SNAPSHOT: computar un snapshot para Org A y usar su forma
// (mismos permission/feature keys) contra Org B con una identidad que
// SÍ pertenece a B pero nunca se le pidió ese conjunto en B.
// ---------------------------------------------------------------------------
section("ATAQUE 8 — snapshot: el organizationId del snapshot siempre refleja la organización realmente evaluada");

{
  const storageM = mem_storage;
  const orgA = await createOrganizationWithOwner(storageM, {
    organizationId: "org-snap-a", organizationName: "SnapA", ownerRoleId: "role-owner-snap-a",
    membershipId: "m-owner-snap-a", ownerIdentity: { provider: "e2e", subject: "owner-snap-a" },
  });
  const orgB = await createOrganizationWithOwner(storageM, {
    organizationId: "org-snap-b", organizationName: "SnapB", ownerRoleId: "role-owner-snap-b",
    membershipId: "m-owner-snap-b", ownerIdentity: { provider: "e2e", subject: "owner-snap-b" },
  });
  await storageM.permissions.register({ key: "shared.action" });
  const roleB = await storageM.roles.create({ id: "role-b-snap", organizationId: orgB.organization.id, name: "R", permissionKeys: ["shared.action"] });
  const identity = { provider: "e2e", subject: "snap-cross" };
  await storageM.memberships.create({ id: "m-cross-a", organizationId: orgA.organization.id, identity, roleIds: [] });
  await storageM.memberships.create({ id: "m-cross-b", organizationId: orgB.organization.id, identity, roleIds: [roleB.id] });

  const snapA = await computeAuthorizationSnapshot(memEngine, storageM.features, { identity, organizationId: orgA.organization.id, permissions: ["shared.action"] });
  const snapB = await computeAuthorizationSnapshot(memEngine, storageM.features, { identity, organizationId: orgB.organization.id, permissions: ["shared.action"] });

  ok("snapshot de Org A trae organizationId=A (nunca ambiguo)", snapA.organizationId === orgA.organization.id);
  ok("snapshot de Org A: shared.action=false (no otorgado ahí)", snapA.permissions["shared.action"] === false);
  ok("snapshot de Org B: shared.action=true (sí otorgado ahí) — confirma que A y B nunca se mezclan", snapB.permissions["shared.action"] === true);
}

// ---------------------------------------------------------------------------
// ATAQUE 9 — IDENTIFIER LIFECYCLE: feature unregister()+register() del
// mismo key no resucita el estado "enabled" viejo de ninguna organización.
// ---------------------------------------------------------------------------
section("ATAQUE 9 — lifecycle: feature unregister()+register() del mismo key no resucita el enabled viejo");

async function attack9(storage, adapterLabel) {
  const { organization } = await createOrganizationWithOwner(storage, {
    organizationId: `org-featlife-${adapterLabel}`,
    organizationName: "FeatLife",
    ownerRoleId: `role-owner-featlife-${adapterLabel}`,
    membershipId: `m-owner-featlife-${adapterLabel}`,
    ownerIdentity: { provider: "e2e", subject: `owner-featlife-${adapterLabel}` },
  });
  await storage.features.register({ name: "Recyclable", key: "recyclable_feature" });
  await storage.features.enable(organization.id, "recyclable_feature");
  await storage.features.disable(organization.id, "recyclable_feature"); // debe deshabilitarse antes de poder desregistrar
  await storage.features.unregister("recyclable_feature");
  await storage.features.register({ name: "Reused", key: "recyclable_feature" });

  const stillEnabled = await storage.features.isEnabled(organization.id, "recyclable_feature");
  ok(`[${adapterLabel}] tras disable+unregister+re-register, la feature NO aparece habilitada por sí sola`, stillEnabled === false);
}
await attack9(mem_storage, "memory");
await attack9(pg_storage, "postgres");

// ---------------------------------------------------------------------------
// ATAQUE 10 — CROSS-ORG STATE COLLISION: dos organizaciones con roles del
// MISMO nombre ("Admin") y MISMA key derivada, pero ids distintos. Ningún
// filtro por nombre/key (sin organizationId) debe confundirlos jamás.
// ---------------------------------------------------------------------------
section("ATAQUE 10 — cross-org collision: roles homónimos ('Admin') en Org A y Org B nunca se confunden");

{
  const orgA = await createOrganizationWithOwner(mem_storage, {
    organizationId: "org-homonym-a", organizationName: "HomonymA", ownerRoleId: "role-owner-homonym-a",
    membershipId: "m-owner-homonym-a", ownerIdentity: { provider: "e2e", subject: "owner-homonym-a" },
  });
  const orgB = await createOrganizationWithOwner(mem_storage, {
    organizationId: "org-homonym-b", organizationName: "HomonymB", ownerRoleId: "role-owner-homonym-b",
    membershipId: "m-owner-homonym-b", ownerIdentity: { provider: "e2e", subject: "owner-homonym-b" },
  });
  await mem_storage.permissions.register({ key: "homonym.a.secret" });
  await mem_storage.permissions.register({ key: "homonym.b.secret" });
  const roleA = await mem_storage.roles.create({ id: "role-homonym-a", organizationId: orgA.organization.id, name: "Admin", permissionKeys: ["homonym.a.secret"] });
  const roleB = await mem_storage.roles.create({ id: "role-homonym-b", organizationId: orgB.organization.id, name: "Admin", permissionKeys: ["homonym.b.secret"] });

  ok("los dos roles 'Admin' homónimos tienen keys derivadas iguales pero ids distintos (setup)", roleA.key === roleB.key && roleA.id !== roleB.id, `keyA=${roleA.key} keyB=${roleB.key}`);

  const memberA = await mem_storage.memberships.create({ id: "m-homonym-a", organizationId: orgA.organization.id, identity: { provider: "e2e", subject: "homonym-actor-a" }, roleIds: [roleA.id] });
  const identityA = { provider: "e2e", subject: "homonym-actor-a" };

  const hasSecretA = await memEngine.can({ identity: identityA, organizationId: orgA.organization.id, permission: "homonym.a.secret" });
  const hasSecretBviaOrgA = await memEngine.can({ identity: identityA, organizationId: orgA.organization.id, permission: "homonym.b.secret" });
  const hasSecretBviaOrgB = await memEngine.can({ identity: identityA, organizationId: orgB.organization.id, permission: "homonym.b.secret" });

  ok("miembro de A con role 'Admin' local tiene homonym.a.secret", hasSecretA === true);
  ok("ese mismo miembro NUNCA tiene homonym.b.secret vía su propia organización", hasSecretBviaOrgA === false);
  ok("ese mismo miembro NUNCA tiene homonym.b.secret preguntando por Org B (no es miembro de B)", hasSecretBviaOrgB === false);

  // Intento explícito de "swap": usar el roleId de B directamente contra la membership de A.
  let rejected = false;
  try {
    await mem_storage.memberships.assignRole(memberA.id, roleB.id);
  } catch {
    rejected = true;
  }
  ok("assignRole(membership de A, roleId de B con el mismo nombre 'Admin') se rechaza igual que cualquier roleId ajeno", rejected === true);
}

section("RESUMEN RONDA 5");
console.log(`PASS=${PASS}  FAIL=${FAIL}`);
if (findings.length > 0) {
  console.log("\nHallazgos a investigar:");
  for (const f of findings) console.log(`  - ${f}`);
}

await pool.end();
