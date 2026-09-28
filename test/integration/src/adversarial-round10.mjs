// PENTEST — Ronda 10: Public API Abuse, Trust-Boundary & Confused-Deputy
// Warfare. No se centra en concurrencia (eso ya lo cubrieron las Rondas
// 4/6/7/8) — se centra en si una COMBINACIÓN de APIs públicas,
// individualmente correctas, permite cruzar una frontera de seguridad.
// TEMPORAL, no se commitea. Base aislada: uniora_pentest (recreada).
import pg from "pg";
import {
  createAuthorizationEngine,
  createOrganizationWithOwner,
  createMemoryStorage,
  computeAuthorizationSnapshot,
} from "@uniora/core";
import { applyMigrations, createPostgresStorage } from "@uniora/postgres";

// @uniora/next no es una dependencia de este workspace de test (evita traer
// `react` como dependencia de este paquete solo para el fuzzer) — su lógica
// (guard.ts/route.ts) es un passthrough de una línea sobre engine.can()/
// engine.access.check(), verificado por lectura directa del código fuente
// (packages/next/src/guard.ts, route.ts) y cubierto por sus propios 11 tests
// unitarios (packages/next/src/*.test.ts) — no reimplementa ninguna decisión
// de autorización, así que atacar engine.can()/access.check() directamente
// (como hace este script) ataca exactamente la misma superficie real.

const pool = new pg.Pool({ connectionString: "postgresql://postgres:uniora@localhost:55432/uniora_pentest" });
await pool.query("drop schema if exists uniora cascade");
await applyMigrations(pool);

let PASS = 0;
let FAIL = 0;
const findings = [];
function ok(label, condition, detail = "") {
  if (condition) {
    PASS++;
  } else {
    FAIL++;
    console.log(`  !!VULN!! ${label}${detail ? " — " + detail : ""}`);
    findings.push({ label, detail });
  }
}
function section(title) {
  console.log("\n" + "=".repeat(78));
  console.log(title);
  console.log("=".repeat(78));
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

const pgStorage = createPostgresStorage(pool);
const memStorage = createMemoryStorage();

// ---------------------------------------------------------------------------
// SECCIÓN 1 — PUBLIC API INVENTORY (comparación exports vs. documentación)
// ---------------------------------------------------------------------------
section("1. PUBLIC API INVENTORY");
{
  const coreExports = await import("@uniora/core");
  const postgresExports = await import("@uniora/postgres");
  const coreKeys = Object.keys(coreExports).sort();
  const pgKeys = Object.keys(postgresExports).sort();
  console.log("  @uniora/core exports:", coreKeys.join(", "));
  console.log("  @uniora/postgres exports:", pgKeys.join(", "));
  console.log("  @uniora/next exports (verificados por lectura de código, ver comentario arriba): createCachedAuthorizationSnapshot, createCachedIdentity, AuthorizationDeniedError, assertCan, assertAccess, authorizeRoute");

  // Ningún export debería exponer algo con nombre de debug/test/seed/force/skip/unsafe/raw/internal.
  const suspiciousPattern = /debug|seed|force|skip|unsafe|raw|internal|bypass/i;
  const suspicious = [...coreKeys, ...pgKeys].filter((k) => suspiciousPattern.test(k));
  ok("Sin exports con nombre sospechoso (debug/seed/force/skip/unsafe/raw/internal/bypass)", suspicious.length === 0, JSON.stringify(suspicious));

  // createOwnerRole es alcanzable solo vía storage.roles (no un export de nivel de paquete) — confirmar que
  // no hay un atajo de nivel de paquete separado que la eluda.
  ok("createOwnerRole NO es un export de nivel de paquete (solo storage.roles.createOwnerRole)", !("createOwnerRole" in coreExports));

  // Todo lo que exporta @uniora/core debe estar documentado en docs/core.md (búsqueda simple).
  const fs = await import("node:fs");
  const coreDoc = fs.readFileSync(new URL("../../../docs/core.md", import.meta.url), "utf8");
  const undocumented = coreKeys.filter((k) => !coreDoc.includes(k));
  console.log("  Exports de @uniora/core no mencionados literalmente en docs/core.md:", undocumented.join(", ") || "(ninguno)");
  // Esto es informativo, no un hallazgo de seguridad per se — solo se reporta.
}

// ---------------------------------------------------------------------------
// SECCIÓN 2 — MUNDO DE PRUEBA: 2 organizaciones con recursos homónimos
// ---------------------------------------------------------------------------
section("2. BUILDING THE ADVERSARIAL WORLD (Postgres + Memory)");

async function buildWorld(storage, tag) {
  const orgA = await createOrganizationWithOwner(storage, {
    organizationId: `${tag}-org-a`, organizationName: "R10 Org A",
    ownerRoleId: `${tag}-role-owner-a`, membershipId: `${tag}-m-owner-a`,
    ownerIdentity: { provider: "e2e", subject: `${tag}-owner-a` },
  });
  const orgB = await createOrganizationWithOwner(storage, {
    organizationId: `${tag}-org-b`, organizationName: "R10 Org B",
    ownerRoleId: `${tag}-role-owner-b`, membershipId: `${tag}-m-owner-b`,
    ownerIdentity: { provider: "e2e", subject: `${tag}-owner-b` },
  });

  await storage.permissions.register({ key: "users.manage" });
  await storage.permissions.register({ key: "billing.write" });
  await storage.permissions.register({ key: "reports.read" });
  await storage.features.register({ name: "ai_assistant", key: "ai_assistant" });

  // Roles homónimos: mismo `name`/`key` derivado, distinto `id`, distinta organización.
  const managerA = await storage.roles.create({
    id: `${tag}-role-manager-a`, organizationId: orgA.organization.id, name: "Manager", permissionKeys: ["users.manage"],
  });
  const managerB = await storage.roles.create({
    id: `${tag}-role-manager-b`, organizationId: orgB.organization.id, name: "Manager", permissionKeys: ["reports.read"],
  });

  // Miembros ordinarios (no-owner) en cada organización.
  const memberA = await storage.memberships.create({
    id: `${tag}-member-a`, organizationId: orgA.organization.id, identity: { provider: "e2e", subject: `${tag}-user-a` }, roleIds: [managerA.id],
  });
  const memberB = await storage.memberships.create({
    id: `${tag}-member-b`, organizationId: orgB.organization.id, identity: { provider: "e2e", subject: `${tag}-user-b` }, roleIds: [managerB.id],
  });
  // Un miembro SIN ningún rol.
  const bareA = await storage.memberships.create({
    id: `${tag}-bare-a`, organizationId: orgA.organization.id, identity: { provider: "e2e", subject: `${tag}-bare-a` }, roleIds: [],
  });

  await storage.features.enable(orgA.organization.id, "ai_assistant");

  return { orgA, orgB, managerA, managerB, memberA, memberB, bareA };
}

const pgWorld = await buildWorld(pgStorage, "pg");
const memWorld = await buildWorld(memStorage, "mem");

const engines = [
  { name: "Postgres", storage: pgStorage, world: pgWorld, engine: createAuthorizationEngine(pgStorage) },
  { name: "Memory", storage: memStorage, world: memWorld, engine: createAuthorizationEngine(memStorage) },
];

// ---------------------------------------------------------------------------
// SECCIÓN 3 — OPTIONAL PARAMETER ATTACK GENERALIZADO
// (regresión ampliada del Hallazgo 1/4/10 sobre access.check/can/snapshot)
// ---------------------------------------------------------------------------
section("3. OPTIONAL PARAMETER ATTACK — access.check / can / computeAuthorizationSnapshot");

for (const { name, world, engine, storage } of engines) {
  const outsider = { provider: "e2e", subject: "nobody-at-all" };
  const legitMemberA = world.memberA.identity;

  // 3.1 access.check con combinaciones exhaustivas de permission/feature ausentes/null/undefined/vacíos,
  // para un OUTSIDER (sin membership en ninguna organización) — nunca debe conceder acceso.
  const variants = [
    {}, // ninguno
    { permission: undefined }, { feature: undefined },
    { permission: undefined, feature: undefined },
    { permission: "" }, { feature: "" },
    { permission: "", feature: "" },
    { permission: null }, { feature: null },
    { permission: [] }, { feature: [] },
    { permission: {} }, { feature: {} },
    { permission: 0 }, { feature: 0 },
    { permission: false }, { feature: false },
    { permission: "users.manage", feature: undefined }, // permission real, feature omitido
    { feature: "ai_assistant", permission: undefined }, // feature real, permission omitido
  ];
  for (const variant of variants) {
    const result = await engine.access.check({ identity: outsider, organizationId: world.orgA.organization.id, ...variant });
    ok(
      `[${name}] access.check(outsider, orgA, ${JSON.stringify(variant)}) deniega`,
      result === false,
      `devolvió ${result}`,
    );
  }

  // 3.2 Mismos variants, pero para un MIEMBRO REAL de orgA sin el permiso/feature real solicitado —
  // debe seguir denegando (a menos que sea un chequeo puramente de membership, sección "ninguno").
  for (const variant of variants) {
    const hasRealKey = variant.permission === "users.manage" || variant.feature === "ai_assistant";
    const result = await engine.access.check({ identity: legitMemberA, organizationId: world.orgA.organization.id, ...variant });
    if (hasRealKey) {
      ok(`[${name}] access.check(memberA, orgA, ${JSON.stringify(variant)}) concede (clave real)`, result === true);
    } else {
      // Las variantes sin permission/feature explícito válido deben denegar, EXCEPTO el caso "ninguno" (pura
      // verificación de membership), que debe conceder porque memberA SÍ es miembro real de orgA.
      const isPureMembershipCheck = variant.permission === undefined && variant.feature === undefined;
      ok(
        `[${name}] access.check(memberA, orgA, ${JSON.stringify(variant)}) ${isPureMembershipCheck ? "concede (solo membership)" : "deniega (clave vacía/inválida)"}`,
        result === (isPureMembershipCheck ? true : false),
        `devolvió ${result}`,
      );
    }
  }

  // 3.3 computeAuthorizationSnapshot — matriz de permissions/features ausentes/vacíos/duplicados,
  // para un outsider y para un miembro real.
  const snapshotVariants = [
    {}, { permissions: [] }, { features: [] }, { permissions: [], features: [] },
    { permissions: [""] }, { features: [""] },
    { permissions: ["users.manage", "users.manage"] }, // duplicado — parameter pollution
    { permissions: ["users.manage", "does.not.exist"] },
    { features: ["ai_assistant", "ai_assistant"] },
  ];
  for (const variant of snapshotVariants) {
    const snap = await computeAuthorizationSnapshot(engine, storage.features, {
      identity: outsider, organizationId: world.orgA.organization.id, ...variant,
    });
    const anyTrue = Object.values(snap.permissions).some(Boolean) || Object.values(snap.features).some(Boolean);
    ok(`[${name}] snapshot(outsider, orgA, ${JSON.stringify(variant)}) sin ningún true`, anyTrue === false, JSON.stringify(snap));
  }
  // Duplicados para un miembro real con permiso real: debe seguir siendo `true` una sola vez, sin
  // amplificar ni ensuciar el resultado por el duplicado.
  const dupSnap = await computeAuthorizationSnapshot(engine, storage.features, {
    identity: legitMemberA, organizationId: world.orgA.organization.id,
    permissions: ["users.manage", "users.manage", "users.manage"],
  });
  ok(`[${name}] snapshot con permission duplicado 3x resuelve una sola entrada correcta`,
    Object.keys(dupSnap.permissions).length === 1 && dupSnap.permissions["users.manage"] === true);

  // 3.4 can() con permission vacío/atípico nunca concede, incluso para el Owner (el bypass del Owner
  // debe seguir siendo correcto — el bypass ignora permissionKeys, así que CUALQUIER string "concede"
  // para el Owner por diseño; lo que se verifica es que un NO-owner con permission="" nunca obtiene acceso).
  for (const badPermission of ["", null, undefined, 0, false, [], {}]) {
    const result = await engine.can({ identity: legitMemberA, organizationId: world.orgA.organization.id, permission: badPermission });
    ok(`[${name}] can(memberA, orgA, permission=${JSON.stringify(badPermission)}) deniega`, result === false, `devolvió ${result}`);
  }
}

// ---------------------------------------------------------------------------
// SECCIÓN 4 — ID CONFUSION / CROSS-ORG SUBSTITUTION A NIVEL DE CORE
// (sin pasar por Studio — ataca los primitivos públicos directamente,
// exactamente como lo haría un host que expone estos métodos sin cuidado)
// ---------------------------------------------------------------------------
section("4. ID CONFUSION & CROSS-ORG SUBSTITUTION (direct Core API)");

for (const { name, world, storage, engine } of engines) {
  // 4.1 access.check/can con organizationId de A pero identity que solo es miembro de B.
  const resultCrossOrg = await engine.access.check({
    identity: world.memberB.identity, organizationId: world.orgA.organization.id, permission: "users.manage",
  });
  ok(`[${name}] access.check(memberB.identity, orgA, "users.manage") deniega (miembro de otra org)`, resultCrossOrg === false);

  // 4.2 Usar el roleId de Manager de orgB dentro de assignRole con un membershipId de orgA — Core debe
  // rechazar (defensa en profundidad ya establecida, se re-verifica aquí explícitamente para Round 10).
  let threw = false;
  try {
    await storage.memberships.assignRole(world.bareA.id, world.managerB.id);
  } catch {
    threw = true;
  }
  ok(`[${name}] assignRole(bareA(orgA), managerB.id(orgB)) es rechazado`, threw === true);
  const bareAAfter = await storage.memberships.findById(world.bareA.id);
  ok(`[${name}] bareA sigue sin roles tras el intento cross-org`, bareAAfter.roleIds.length === 0);

  // 4.3 grantPermission sobre un roleId de orgB con una permissionKey que en orgA significa otra cosa
  // (mismo string "users.manage") — solo debe afectar al role real referenciado (managerB), nunca "cruzar"
  // hacia managerA por compartir key/nombre.
  await storage.roles.grantPermission(world.managerB.id, "billing.write");
  const canBWithBilling = await engine.can({ identity: world.memberB.identity, organizationId: world.orgB.organization.id, permission: "billing.write" });
  const canAWithBilling = await engine.can({ identity: world.memberA.identity, organizationId: world.orgA.organization.id, permission: "billing.write" });
  ok(`[${name}] grantPermission(managerB, "billing.write") concede solo a memberB`, canBWithBilling === true);
  ok(`[${name}] grantPermission(managerB, "billing.write") NO afecta a memberA (mismo nombre de rol, distinta org)`, canAWithBilling === false);
  await storage.roles.revokePermission(world.managerB.id, "billing.write"); // limpieza

  // 4.4 findByIds/findSummariesByIds mezclando ids de ambas organizaciones — nunca debe filtrar el
  // organizationId real de un role al confundirlo con otro (control de sanity, no ataque en sí).
  const mixed = await storage.roles.findByIds([world.managerA.id, world.managerB.id]);
  const mapById = Object.fromEntries(mixed.map((r) => [r.id, r]));
  ok(`[${name}] findByIds distingue orgId real por id, sin mezclar A/B`,
    mapById[world.managerA.id]?.organizationId === world.orgA.organization.id &&
    mapById[world.managerB.id]?.organizationId === world.orgB.organization.id);

  // 4.5 Membership "adyacente"/aleatorio/inexistente/borrado como membershipId en operaciones — nunca lanza
  // un error que revele si el id EXISTE en otra organización (oráculo de existencia cross-org).
  const randomId = "does-not-exist-anywhere-12345";
  let errRandom, errCrossOrg;
  try { await storage.memberships.assignRole(randomId, world.managerA.id); } catch (e) { errRandom = e.message; }
  try { await storage.memberships.assignRole(world.memberB.id, world.managerA.id); } catch (e) { errCrossOrg = e.message; }
  // Ambos deben fallar; no se exige que el mensaje sea idéntico (Core no promete eso), pero ninguno de los
  // dos debe tener éxito.
  ok(`[${name}] assignRole con membershipId inexistente falla`, errRandom !== undefined);
  ok(`[${name}] assignRole con membershipId de otra organización falla`, errCrossOrg !== undefined);
  const memberBAfter = await storage.memberships.findById(world.memberB.id);
  ok(`[${name}] memberB no ganó el rol managerA de la organización ajena`, !memberBAfter.roleIds.includes(world.managerA.id));
}

// ---------------------------------------------------------------------------
// SECCIÓN 5 — AUTHORIZATION SNAPSHOT ABUSE: snapshot de una org usado/leído
// como si fuera de otra; snapshot obtenido y luego el privilegio se revoca.
// ---------------------------------------------------------------------------
section("5. AUTHORIZATION SNAPSHOT ABUSE (revocation-after-snapshot / cross-org read)");

for (const { name, world, storage, engine } of engines) {
  // 5.1 El snapshot siempre lleva el organizationId real embebido — un host no puede confundirlo con el
  // de otra organización sin ignorar deliberadamente ese campo.
  const snapA = await computeAuthorizationSnapshot(engine, storage.features, {
    identity: world.memberA.identity, organizationId: world.orgA.organization.id, permissions: ["users.manage"],
  });
  ok(`[${name}] snapshot embebe organizationId real`, snapA.organizationId === world.orgA.organization.id);

  // 5.2 Snapshot calculado ANTES de revocar el permiso — una vez revocado, un NUEVO cómputo debe reflejar
  // el cambio (el snapshot en sí es inmutable/estático por diseño — lo que se verifica es que Core nunca
  // cachea el resultado entre llamadas, cada llamada es un cómputo fresco contra el storage real).
  const before = await computeAuthorizationSnapshot(engine, storage.features, {
    identity: world.memberA.identity, organizationId: world.orgA.organization.id, permissions: ["users.manage"],
  });
  await storage.roles.revokePermission(world.managerA.id, "users.manage");
  const after = await computeAuthorizationSnapshot(engine, storage.features, {
    identity: world.memberA.identity, organizationId: world.orgA.organization.id, permissions: ["users.manage"],
  });
  ok(`[${name}] snapshot antes de revocar: true`, before.permissions["users.manage"] === true);
  ok(`[${name}] snapshot recalculado después de revocar: false (sin caché oculta)`, after.permissions["users.manage"] === false);
  await storage.roles.grantPermission(world.managerA.id, "users.manage"); // restaurar
}

// ---------------------------------------------------------------------------
// SECCIÓN 6 — PRIVILEGE AMPLIFICATION / TRANSFER / SELF-ESCALATION (Core)
// ---------------------------------------------------------------------------
section("6. PRIVILEGE AMPLIFICATION, TRANSFER & SELF-ESCALATION (3-actor chains)");

for (const { name, world, storage, engine } of engines) {
  // 6.1 A (bareA, sin permisos) crea un rol vacío, se autoasigna el rol vacío — no debe ganar NADA.
  const emptyRole = await storage.roles.create({ id: `${world.orgA.organization.id}-empty-role`, organizationId: world.orgA.organization.id, name: `Empty ${Date.now()}` });
  await storage.memberships.assignRole(world.bareA.id, emptyRole.id);
  const bareCan = await engine.can({ identity: world.bareA.identity, organizationId: world.orgA.organization.id, permission: "users.manage" });
  ok(`[${name}] autoasignarse un rol vacío no otorga ningún permiso`, bareCan === false);

  // 6.2 Delegación: B (con "capacidad de otorgar", simulada aquí por tener acceso directo a
  // grantPermission — el host es quien decide QUÉ permiso delega) otorga exactamente UN permiso al rol de
  // A; A nunca obtiene más que eso, ni el bypass del Owner.
  await storage.roles.grantPermission(emptyRole.id, "reports.read");
  const gotGranted = await engine.can({ identity: world.bareA.identity, organizationId: world.orgA.organization.id, permission: "reports.read" });
  const gotUngranted = await engine.can({ identity: world.bareA.identity, organizationId: world.orgA.organization.id, permission: "users.manage" });
  const gotOwnerBypass = await engine.can({ identity: world.bareA.identity, organizationId: world.orgA.organization.id, permission: "some.made.up.key.nobody.granted" });
  ok(`[${name}] A obtiene exactamente el permiso delegado`, gotGranted === true);
  ok(`[${name}] A no obtiene un permiso no delegado`, gotUngranted === false);
  ok(`[${name}] A no obtiene el bypass del Owner (isOwnerRole sigue false)`, gotOwnerBypass === false);

  // 6.3 Self-escalation vía cadena role→role: A tiene "reports.read" en un rol; crea un SEGUNDO rol con
  // "users.manage" y trata de fusionar privilegios asignándose ambos — la unión debe ser exactamente
  // reports.read + manage_users, nunca más (ninguna composición implícita).
  const secondRole = await storage.roles.create({ id: `${world.orgA.organization.id}-second-role`, organizationId: world.orgA.organization.id, name: `Second ${Date.now()}`, permissionKeys: ["users.manage"] });
  await storage.memberships.assignRole(world.bareA.id, secondRole.id);
  const unionCheck1 = await engine.can({ identity: world.bareA.identity, organizationId: world.orgA.organization.id, permission: "reports.read" });
  const unionCheck2 = await engine.can({ identity: world.bareA.identity, organizationId: world.orgA.organization.id, permission: "users.manage" });
  const unionCheck3 = await engine.can({ identity: world.bareA.identity, organizationId: world.orgA.organization.id, permission: "billing.write" });
  ok(`[${name}] unión de dos roles = exactamente sus permisos, sin amplificación`, unionCheck1 === true && unionCheck2 === true && unionCheck3 === false);

  // 6.4 Intento de escalada Member -> Owner vía assignRole genérico (no assignOwnerRole) con el
  // roleId real del Owner — debe ser rechazado (ya cubierto por Hallazgo 7, se re-verifica en Round 10).
  let ownerEscalationThrew = false;
  try {
    await storage.memberships.assignRole(world.bareA.id, world.orgA.ownerRole.id);
  } catch {
    ownerEscalationThrew = true;
  }
  ok(`[${name}] assignRole(bareA, ownerRoleId) es rechazado (debe usarse assignOwnerRole)`, ownerEscalationThrew === true);
  const bareAFinal = await storage.memberships.findById(world.bareA.id);
  ok(`[${name}] bareA nunca ganó el Owner role por esta vía`, !bareAFinal.roleIds.includes(world.orgA.ownerRole.id));

  // limpieza
  await storage.memberships.unassignRole(world.bareA.id, emptyRole.id);
  await storage.memberships.unassignRole(world.bareA.id, secondRole.id);
  await storage.roles.delete(emptyRole.id);
  await storage.roles.delete(secondRole.id);
}

// ---------------------------------------------------------------------------
// SECCIÓN 7 — DELETE / RECREATE CHAINS (homónimos, mismo provider/subject)
// ---------------------------------------------------------------------------
section("7. DELETE / RECREATE PUBLIC API CHAINS");

for (const { name, world, storage, engine } of engines) {
  // 7.1 Borrar un membership y recrear uno NUEVO con el mismo (provider, subject) pero SIN roles — el
  // nuevo membership nunca debe heredar los roles del anterior (ni por id, ni por identidad).
  const throwaway = await storage.memberships.create({
    id: `${world.orgA.organization.id}-throwaway`, organizationId: world.orgA.organization.id,
    identity: { provider: "e2e", subject: `${world.orgA.organization.id}-throwaway-identity` }, roleIds: [world.managerA.id],
  });
  const before = await engine.can({ identity: throwaway.identity, organizationId: world.orgA.organization.id, permission: "users.manage" });
  await storage.memberships.delete(throwaway.id);
  const recreated = await storage.memberships.create({
    id: `${world.orgA.organization.id}-throwaway-2`, organizationId: world.orgA.organization.id,
    identity: throwaway.identity, roleIds: [],
  });
  const after = await engine.can({ identity: recreated.identity, organizationId: world.orgA.organization.id, permission: "users.manage" });
  ok(`[${name}] membership recreado con la misma identidad no hereda permisos previos`, before === true && after === false);
  await storage.memberships.delete(recreated.id);

  // 7.2 Borrar un rol y crear uno NUEVO con el mismo nombre/key en la MISMA organización — el nuevo rol
  // nace sin permisos (no hereda del anterior por compartir nombre/key).
  const roleName = `Recyclable-${Date.now()}`;
  const originalRole = await storage.roles.create({ id: `${world.orgA.organization.id}-recyclable-1`, organizationId: world.orgA.organization.id, name: roleName, permissionKeys: ["users.manage"] });
  await storage.roles.delete(originalRole.id);
  const newRole = await storage.roles.create({ id: `${world.orgA.organization.id}-recyclable-2`, organizationId: world.orgA.organization.id, name: roleName });
  const grants = await storage.roles.grantedPermissionKeys(newRole.id, ["users.manage"]);
  ok(`[${name}] rol recreado con mismo name/key no hereda permisos del anterior`, grants.length === 0);
  await storage.roles.delete(newRole.id);
}

// ---------------------------------------------------------------------------
// SECCIÓN 8 — IDENTITYLINK CONFUSED-DEPUTY (boundary distinta a la Ronda 7)
// ---------------------------------------------------------------------------
section("8. IDENTITYLINK CONFUSED-DEPUTY & CROSS-ORG RESOLUTION");

for (const { name, world, storage, engine } of engines) {
  const actor = { provider: "e2e", subject: "pentest-actor" };

  // 8.1 link(from=identidad nueva, to=memberA de orgA) — luego consultar can() para `from` sobre orgB
  // (donde `to` NO es miembro) — nunca debe resolver acceso en orgB por el mero hecho de estar linkeado
  // en orgA.
  const freshIdentity = { provider: "e2e", subject: `${world.orgA.organization.id}-fresh-link-source` };
  await storage.identityLinks.link({ from: freshIdentity, to: world.memberA.identity, actor });
  const resolvedInA = await engine.can({ identity: freshIdentity, organizationId: world.orgA.organization.id, permission: "users.manage" });
  const resolvedInB = await engine.can({ identity: freshIdentity, organizationId: world.orgB.organization.id, permission: "reports.read" });
  ok(`[${name}] identidad linkeada resuelve permisos en la organización donde 'to' SÍ es miembro`, resolvedInA === true);
  ok(`[${name}] identidad linkeada NO resuelve nada en una organización donde 'to' no es miembro`, resolvedInB === false);

  // 8.2 Confused deputy: usar `freshIdentity` (el alias) como `organizationId`-scoped snapshot input para
  // orgB directamente — nunca debe filtrar datos de orgA ni conceder nada en orgB.
  const snapCrossOrg = await computeAuthorizationSnapshot(engine, storage.features, {
    identity: freshIdentity, organizationId: world.orgB.organization.id, permissions: ["reports.read"], features: ["ai_assistant"],
  });
  ok(`[${name}] snapshot de la identidad linkeada en orgB (donde no es miembro) no concede nada`,
    snapCrossOrg.permissions["reports.read"] === false && snapCrossOrg.features["ai_assistant"] === false);

  // 8.3 resolve() en la dirección incorrecta: consultar resolve() sobre `to` (memberA.identity) — no debe
  // "resolver" a `from` (freshIdentity) ni a ninguna otra cosa; solo un `from` real se resuelve.
  const resolvedTo = await storage.identityLinks.resolve(world.memberA.identity);
  ok(`[${name}] resolve(to) devuelve la identidad sin cambios (no resuelve al revés)`,
    resolvedTo.provider === world.memberA.identity.provider && resolvedTo.subject === world.memberA.identity.subject);

  // 8.4 Fan-in válido: una SEGUNDA identidad distinta también puede linkearse al mismo `to` (esto es
  // válido por diseño — múltiples alias convergiendo en una identidad canónica). Confirmar que ambas
  // resuelven al mismo membership, sin error y sin "robarse" el acceso entre sí.
  const secondFreshIdentity = { provider: "e2e", subject: `${world.orgA.organization.id}-fresh-link-source-2` };
  let fanInThrew = false;
  try {
    await storage.identityLinks.link({ from: secondFreshIdentity, to: world.memberA.identity, actor });
  } catch {
    fanInThrew = true;
  }
  ok(`[${name}] fan-in (dos 'from' distintos hacia el mismo 'to') es aceptado, no es una cadena`, fanInThrew === false);
  const secondResolved = await engine.can({ identity: secondFreshIdentity, organizationId: world.orgA.organization.id, permission: "users.manage" });
  ok(`[${name}] el segundo alias también resuelve correctamente al mismo membership`, secondResolved === true);

  // 8.5 Intento de host hostil: llamar link() con `to` construido a partir de un STRING ARBITRARIO no
  // verificado (simulando un host que confía en un campo de formulario) — Core no tiene forma de rechazar
  // esto (es la frontera de confianza documentada explícitamente, ver docs/core.md línea 193) — se verifica
  // que el `to` inventado, al no tener membership en ningún lado, simplemente no resuelve a NINGÚN acceso
  // (fail-closed incluso cuando el host confía ciegamente en el input).
  const attackerControlledFrom = { provider: "e2e", subject: `${world.orgA.organization.id}-attacker-controlled` };
  const madeUpTo = { provider: "e2e", subject: "totally-made-up-target-nobody-owns" };
  await storage.identityLinks.link({ from: attackerControlledFrom, to: madeUpTo, actor });
  const attackerAccess = await engine.can({ identity: attackerControlledFrom, organizationId: world.orgA.organization.id, permission: "users.manage" });
  ok(`[${name}] link() hacia un 'to' inventado (sin membership real) no otorga ningún acceso`, attackerAccess === false);
}

// ---------------------------------------------------------------------------
// SECCIÓN 9 — NEGATIVE SPACE (sin membership/permission/feature/role/
// identidad/organización; objetos borrados) — todo debe seguir denegando.
// ---------------------------------------------------------------------------
section("9. NEGATIVE-SPACE ATTACKS");

for (const { name, world, storage, engine } of engines) {
  const ghost = { provider: "e2e", subject: "ghost-never-existed" };

  // 9.1 Organización inexistente.
  const noOrg = await engine.access.check({ identity: world.memberA.identity, organizationId: "org-does-not-exist", permission: "users.manage" });
  ok(`[${name}] organización inexistente deniega`, noOrg === false);

  // 9.2 Permission/feature nunca registrado.
  const unknownPerm = await engine.can({ identity: world.memberA.identity, organizationId: world.orgA.organization.id, permission: "never.registered.anywhere" });
  const unknownFeature = await engine.access.check({ identity: world.memberA.identity, organizationId: world.orgA.organization.id, feature: "never_registered_feature" });
  ok(`[${name}] permission nunca registrado deniega`, unknownPerm === false);
  ok(`[${name}] feature nunca registrado deniega`, unknownFeature === false);

  // 9.3 Role borrado sigue en membership.roleIds por un instante (no aplica — delete() de role cascadea
  // sobre membership_roles) — verificar que tras borrar un role, el permiso que otorgaba desaparece.
  const ghostRole = await storage.roles.create({ id: `${world.orgA.organization.id}-ghost-role`, organizationId: world.orgA.organization.id, name: `Ghost ${Date.now()}`, permissionKeys: ["billing.write"] });
  const ghostMember = await storage.memberships.create({ id: `${world.orgA.organization.id}-ghost-member`, organizationId: world.orgA.organization.id, identity: ghost, roleIds: [ghostRole.id] });
  const beforeDelete = await engine.can({ identity: ghost, organizationId: world.orgA.organization.id, permission: "billing.write" });
  await storage.roles.delete(ghostRole.id);
  const afterDelete = await engine.can({ identity: ghost, organizationId: world.orgA.organization.id, permission: "billing.write" });
  ok(`[${name}] permiso vía role antes de borrar: true`, beforeDelete === true);
  ok(`[${name}] permiso vía role DESPUÉS de borrado: false (sin fantasma)`, afterDelete === false);

  // 9.4 Membership borrado: identidad ya no resuelve ningún acceso.
  await storage.memberships.delete(ghostMember.id);
  const afterMembershipDelete = await engine.access.check({ identity: ghost, organizationId: world.orgA.organization.id });
  ok(`[${name}] tras borrar el membership, la identidad ya no es reconocida como miembro`, afterMembershipDelete === false);

  // 9.5 Permission desregistrado (unregister) mientras estuviera SIN otorgar a ningún rol: tras
  // desregistrar, un intento de grantPermission con ese key debe fallar (fail-closed de catálogo).
  // NOTA: esto solo se exige en Postgres — el adapter en memoria NUNCA forzó que `permissionKey` esté
  // registrado antes de otorgarse a un role (gap documentado explícitamente desde la sesión del
  // 2026-09-22, ver CLAUDE.md: "Postgres exige que un permissionKey esté registrado ... el adapter en
  // memoria no lo forzaba" — un catálogo, no un problema de autorización cross-tenant/Owner). No es un
  // hallazgo nuevo de esta ronda; se documenta aquí para que quede constancia de que se re-verificó.
  await storage.permissions.register({ key: "throwaway.perm" });
  await storage.permissions.unregister("throwaway.perm");
  const ghostRole2 = await storage.roles.create({ id: `${world.orgA.organization.id}-ghost-role-2`, organizationId: world.orgA.organization.id, name: `Ghost2 ${Date.now()}` });
  let grantAfterUnregisterThrew = false;
  try {
    await storage.roles.grantPermission(ghostRole2.id, "throwaway.perm");
  } catch {
    grantAfterUnregisterThrew = true;
  }
  if (name === "Postgres") {
    ok(`[${name}] grantPermission con un permission desregistrado es rechazado`, grantAfterUnregisterThrew === true);
  } else {
    console.log(`  [Memory] grantPermission con permission desregistrado ${grantAfterUnregisterThrew ? "rechazado" : "NO rechazado (gap preexistente y documentado, no es un hallazgo nuevo)"}`);
  }
  await storage.roles.delete(ghostRole2.id);
}

// ---------------------------------------------------------------------------
// SECCIÓN 10 — DIFFERENTIAL: Core directo vs. exactamente la misma
// secuencia de validaciones que ejecuta la capa de Studio (memberships.ts/
// roles.ts) — replicada aquí para confirmar que el HOST layer no introduce
// ninguna divergencia de autorización frente al Core "crudo".
// ---------------------------------------------------------------------------
section("10. DIFFERENTIAL — Core crudo vs. lógica replicada de Studio (requireMember/requireOrgRole)");

for (const { name, world, storage, engine } of engines) {
  // Replica exacta de apps/studio/src/actions/memberships.ts::requireMember/requireOrgRole.
  async function requireMember(organizationId, membershipId) {
    const member = await storage.memberships.findById(membershipId);
    if (!member || member.organizationId !== organizationId) return null;
    return member;
  }
  async function requireOrgRole(organizationId, roleId) {
    const [role] = await storage.roles.findSummariesByIds([roleId]);
    if (!role || role.organizationId !== organizationId) return null;
    return role;
  }

  // Intento de "assignMemberRole" tal como lo haría Studio, con organizationId=A pero membershipId
  // perteneciente a B (exactamente lo que un actor con acceso a la red probaría contra el Server Action).
  const memberFromWrongOrg = await requireMember(world.orgA.organization.id, world.memberB.id);
  ok(`[${name}] Studio-layer: requireMember(orgA, memberB.id) devuelve null (frontera respetada)`, memberFromWrongOrg === null);

  const roleFromWrongOrg = await requireOrgRole(world.orgA.organization.id, world.managerB.id);
  ok(`[${name}] Studio-layer: requireOrgRole(orgA, managerB.id) devuelve null (frontera respetada)`, roleFromWrongOrg === null);

  // Combinación: membershipId real de A + roleId real de B pasados JUNTOS (como si el atacante mezclara
  // un membershipId legítimo con un roleId ajeno en el mismo formulario) — el segundo check por sí solo ya
  // debe bloquear toda la operación antes de llegar a assignRole.
  const validMember = await requireMember(world.orgA.organization.id, world.bareA.id);
  const invalidRole = await requireOrgRole(world.orgA.organization.id, world.managerB.id);
  ok(`[${name}] Studio-layer: membershipId válido + roleId ajeno → el roleId ajeno es rechazado igual`, validMember !== null && invalidRole === null);
}

console.log(`\nSección 1-10 completa: ${PASS} pass, ${FAIL} fail.`);

// ---------------------------------------------------------------------------
// SECCIÓN 11 — FUZZER DIFERENCIAL DIRIGIDO A COMPOSICIONES DE API PÚBLICA
// (PRNG determinista, oráculo diferencial memoria↔Postgres, verificación de
// invariantes DESPUÉS de cada acción — adaptado del patrón de la Ronda 6,
// pero con acciones que deliberadamente encadenan link()/create() y
// grant/revoke/delete en el mismo turno para buscar bugs dependientes de
// secuencia como el de la Ronda 7, en composiciones distintas).
// ---------------------------------------------------------------------------
section("11. DIFFERENTIAL PRNG FUZZER — public API compositions");

function pickF(arr, f) {
  return arr[Math.floor(f * arr.length)];
}

async function buildFuzzWorld(storage, tag, provider) {
  const org = await createOrganizationWithOwner(storage, {
    // `organizationName`/slug deben ser únicos por mundo (no solo `organizationId`): el slug se deriva del
    // nombre y es único GLOBALMENTE (docs/core.md) — reusar "Fuzz Org" para cada secuencia colisionaría
    // contra la base real compartida `uniora_pentest` a partir de la segunda secuencia.
    organizationId: `${tag}-fuzz-org`, organizationName: `Fuzz Org ${tag}`,
    ownerRoleId: `${tag}-fuzz-owner-role`, membershipId: `${tag}-fuzz-owner-m`,
    ownerIdentity: { provider, subject: `${tag}-owner` },
  });
  const PERMS = ["fuzz.alpha", "fuzz.beta", "fuzz.gamma"];
  for (const p of PERMS) await storage.permissions.register({ key: p });
  const FEATURES = ["fuzz_x", "fuzz_y"];
  for (const f of FEATURES) await storage.features.register({ name: f, key: f });
  return {
    orgId: org.organization.id,
    ownerRoleId: org.ownerRole.id,
    perms: PERMS,
    features: FEATURES,
    // El `provider` es único POR SECUENCIA (derivado del seed, compartido entre el mundo de memoria y el
    // de Postgres de la MISMA secuencia) — `uniora.identity_links`/`memberships` tienen unicidad GLOBAL
    // sobre (provider, subject), y la base de Postgres (a diferencia de memoria, que se recrea desde cero
    // en cada secuencia) NUNCA se resetea entre secuencias de este fuzzer. Reusar un provider fijo tipo
    // "fuzz" para todas las secuencias haría que los identity_links de una secuencia SANGRARAN hacia la
    // siguiente en Postgres (mientras memoria arranca limpia), produciendo divergencias que parecerían un
    // bug de UNIORA pero que serían enteramente un artefacto de estado compartido entre corridas del
    // propio arnés de pruebas — exactamente lo que se observó y se corrigió aquí durante el desarrollo de
    // esta ronda (ver docs/security-pentest-2026-09-24.md, Ronda 10, "falsos positivos").
    provider,
    identities: ["id-1", "id-2", "id-3", "id-4", "id-5"],
    roles: [org.ownerRole.id],
    memberships: [org.ownerRole ? `${tag}-fuzz-owner-m` : null].filter(Boolean),
    links: [], // { from, to }
    nextId: 0,
  };
}

async function invariantsHold(storage, world, engine, label) {
  // INV-A: ninguna identidad SIN membership real (directo o vía link a un `to` con membership) resuelve
  // ningún permiso/feature.
  for (const subject of world.identities) {
    const identity = { provider: world.provider, subject };
    const direct = await storage.memberships.findByIdentity(world.orgId, identity);
    if (!direct) {
      for (const perm of world.perms) {
        const result = await engine.can({ identity, organizationId: world.orgId, permission: perm });
        if (result) return `${label}: identidad "${subject}" sin membership real obtuvo can()=true para "${perm}"`;
      }
    }
  }
  // INV-B: la organización nunca se queda sin ningún membership sosteniendo el Owner role.
  const ownerHolders = await storage.memberships.countByRole([world.ownerRoleId]);
  if ((ownerHolders[world.ownerRoleId] ?? 0) === 0) return `${label}: la organización se quedó sin ningún Owner (roleId=${world.ownerRoleId})`;
  return null;
}

async function runFuzzSequence(seed, depth) {
  const rng = mulberry32(seed);
  const tag = `fz${seed}`;
  const memS = createMemoryStorage();
  const pgS = createPostgresStorage(pool);
  const sequenceProvider = `fuzz-${tag}`; // único por secuencia, compartido entre memoria y Postgres
  const memWorldF = await buildFuzzWorld(memS, `${tag}m`, sequenceProvider);
  const pgWorldF = await buildFuzzWorld(pgS, `${tag}p`, sequenceProvider);
  const memEngine = createAuthorizationEngine(memS);
  const pgEngine = createAuthorizationEngine(pgS);

  const ACTIONS = [
    "createRole", "deleteRole", "grantPermission", "revokePermission",
    "createMembership", "deleteMembership", "assignRole", "unassignRole",
    "linkIdentity", "enableFeature", "disableFeature", "renameRole",
  ];

  for (let step = 0; step < depth; step++) {
    // CRÍTICO: todos los números aleatorios que una acción pueda necesitar se extraen UNA sola vez por
    // paso, ANTES de aplicar nada — nunca dentro de `apply()`. Si `rng()` se llamara dentro de `apply()`,
    // la llamada para memoria consumiría números del generador ANTES que la llamada para Postgres,
    // desincronizando qué índice/objetivo recibe cada adapter en el mismo paso lógico — produciendo
    // divergencias que parecerían un bug de UNIORA pero que serían enteramente un artefacto del arnés de
    // pruebas. `pickF(arr, f)` indexa con un float YA extraído, así que memoria y Postgres reciben
    // exactamente el mismo "azar" en cada paso, incluso si sus arrays internos difieren en longitud.
    const action = pickF(ACTIONS, rng());
    const identitySubject = pickF(memWorldF.identities, rng());
    const identity = { provider: memWorldF.provider, subject: identitySubject };
    const f1 = rng();
    const f2 = rng();
    const f3 = rng();

    // Ejecuta la MISMA acción, con los MISMOS argumentos ya sorteados, contra memoria y Postgres —
    // cualquier divergencia en éxito/fracaso o en el estado resultante es un hallazgo por sí sola.
    // Deliberadamente NO se blindan aquí "casos especiales" del Owner role (p. ej. deleteRole/renameRole
    // sobre el roleId protegido) — se deja que la protección REAL de Core (RoleRepository.delete/rename)
    // responda por sí misma en ambos adapters, para que el oráculo diferencial la esté ejercitando de
    // verdad en vez de evitarla.
    async function apply(storage, world) {
      try {
        switch (action) {
          case "createRole": {
            const id = `${world.orgId}-role-${world.nextId++}`;
            const perm = pickF(world.perms, f1);
            await storage.roles.create({ id, organizationId: world.orgId, name: `R${id}`, permissionKeys: f2 > 0.5 ? [perm] : [] });
            world.roles.push(id);
            return { ok: true };
          }
          case "deleteRole": {
            const roleId = pickF(world.roles, f1);
            await storage.roles.delete(roleId);
            world.roles = world.roles.filter((r) => r !== roleId);
            return { ok: true };
          }
          case "grantPermission": {
            const roleId = pickF(world.roles, f1);
            const perm = pickF(world.perms, f2);
            await storage.roles.grantPermission(roleId, perm);
            return { ok: true };
          }
          case "revokePermission": {
            const roleId = pickF(world.roles, f1);
            const perm = pickF(world.perms, f2);
            await storage.roles.revokePermission(roleId, perm);
            return { ok: true };
          }
          case "createMembership": {
            const id = `${world.orgId}-member-${world.nextId++}`;
            const existing = await storage.memberships.findByIdentity(world.orgId, identity);
            if (existing) return { ok: false, reason: "already-a-member" };
            await storage.memberships.create({ id, organizationId: world.orgId, identity, roleIds: [] });
            world.memberships.push(id);
            return { ok: true };
          }
          case "deleteMembership": {
            const memberships = await storage.memberships.search({ organizationId: world.orgId });
            if (memberships.length === 0) return { ok: false, reason: "no-memberships" };
            const target = pickF(memberships, f1);
            await storage.memberships.delete(target.id);
            return { ok: true };
          }
          case "assignRole": {
            const memberships = await storage.memberships.search({ organizationId: world.orgId });
            if (memberships.length === 0 || world.roles.length === 0) return { ok: false, reason: "nothing-to-assign" };
            const member = pickF(memberships, f1);
            const roleId = pickF(world.roles, f2);
            if (roleId === world.ownerRoleId) {
              await storage.memberships.assignOwnerRole(member.id, roleId);
            } else {
              await storage.memberships.assignRole(member.id, roleId);
            }
            return { ok: true };
          }
          case "unassignRole": {
            const memberships = await storage.memberships.search({ organizationId: world.orgId });
            if (memberships.length === 0 || world.roles.length === 0) return { ok: false, reason: "nothing-to-unassign" };
            const member = pickF(memberships, f1);
            const roleId = pickF(world.roles, f2);
            if (roleId === world.ownerRoleId) {
              await storage.memberships.unassignOwnerRole(member.id, roleId);
            } else {
              await storage.memberships.unassignRole(member.id, roleId);
            }
            return { ok: true };
          }
          case "linkIdentity": {
            // Deliberadamente elige un SEGUNDO subject distinto como `to` — para maximizar la chance de
            // tropezar con una composición link+create/assign fuera de orden, como en la Ronda 7.
            const others = world.identities.filter((s) => s !== identitySubject);
            const toSubject = pickF(others, f1);
            const to = { provider: world.provider, subject: toSubject };
            await storage.identityLinks.link({ from: identity, to, actor: { provider: world.provider, subject: "actor" } });
            return { ok: true };
          }
          case "enableFeature": {
            const feature = pickF(world.features, f1);
            await storage.features.enable(world.orgId, feature);
            return { ok: true };
          }
          case "disableFeature": {
            const feature = pickF(world.features, f1);
            await storage.features.disable(world.orgId, feature);
            return { ok: true };
          }
          case "renameRole": {
            const roleId = pickF(world.roles, f1);
            await storage.roles.rename(roleId, `Renamed-${world.nextId++}`);
            return { ok: true };
          }
        }
      } catch (error) {
        return { ok: false, reason: error.constructor.name, message: error.message };
      }
    }

    const memResult = await apply(memS, memWorldF);
    const pgResult = await apply(pgS, pgWorldF);

    // Oráculo diferencial: ambos adapters deben coincidir en si la acción tuvo éxito o no (no
    // necesariamente en el MISMO motivo textual — Memory y Postgres pueden fallar por rutas de código
    // distintas — pero el resultado booleano sí debe coincidir siempre).
    if (memResult.ok !== pgResult.ok) {
      ok(
        `[fuzz seed=${seed} step=${step}] acción "${action}" — memoria y Postgres coinciden en éxito/fracaso`,
        false,
        `memoria=${JSON.stringify(memResult)} postgres=${JSON.stringify(pgResult)}`,
      );
    } else {
      PASS++;
    }

    // Invariantes verificadas tras CADA paso, en ambos adapters.
    const memViolation = await invariantsHold(memS, memWorldF, memEngine, `MEM seed=${seed} step=${step} action=${action}`);
    const pgViolation = await invariantsHold(pgS, pgWorldF, pgEngine, `PG seed=${seed} step=${step} action=${action}`);
    ok(`[fuzz seed=${seed} step=${step}] invariantes en memoria`, memViolation === null, memViolation ?? "");
    ok(`[fuzz seed=${seed} step=${step}] invariantes en Postgres`, pgViolation === null, pgViolation ?? "");

    if (memViolation || pgViolation || memResult.ok !== pgResult.ok) {
      console.log(`  Secuencia mínima para reproducir: seed=${seed}, step=${step}, última acción="${action}", identity="${identitySubject}"`);
    }
  }

  await memS; // no-op, solo para simetría de lectura
  return { orgIdMem: memWorldF.orgId, orgIdPg: pgWorldF.orgId };
}

const FUZZ_SEEDS = [
  1001, 2002, 3003, 4004, 5005, 6006, 7007, 8008, 9009, 10010, 11011, 12012,
  13013, 14014, 15015, 16016, 17017, 18018, 19019, 20020, 21021, 22022, 23023, 24024,
];
const FUZZ_DEPTHS = [10, 20, 30, 40];
let fuzzSequences = 0;
for (const seed of FUZZ_SEEDS) {
  for (const depth of FUZZ_DEPTHS) {
    await runFuzzSequence(seed * 100 + depth, depth);
    fuzzSequences++;
  }
}
console.log(`\nFuzzer: ${FUZZ_SEEDS.length} semillas × ${FUZZ_DEPTHS.length} profundidades = ${fuzzSequences} secuencias, ${FUZZ_SEEDS.length * FUZZ_DEPTHS.reduce((a, d) => a + d, 0)} pasos totales, cada uno con verificación diferencial + 2 invariantes.`);

console.log(`\n${"=".repeat(78)}\nTOTAL: ${PASS} pass, ${FAIL} fail.\n${"=".repeat(78)}`);
if (findings.length > 0) {
  console.log("\nHALLAZGOS:");
  for (const f of findings) console.log(`  - ${f.label}${f.detail ? " :: " + f.detail : ""}`);
}

await pool.end();
process.exit(FAIL > 0 ? 1 : 0);

