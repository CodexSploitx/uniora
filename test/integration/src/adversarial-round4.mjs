// PENTEST — Ronda 4: ultra agresiva, cadenas de explotación, TOCTOU,
// adapter parity, framework integration, mass assignment. TEMPORAL, no se
// commitea (script persistente para esta sesión de pentest, se modifica
// entre ataques, no se recrea de cero). Base aislada: uniora_pentest.
import pg from "pg";
import {
  createAuthorizationEngine,
  createOrganizationWithOwner,
  computeAuthorizationSnapshot,
  createMemoryStorage,
} from "@uniora/core";
import { applyMigrations, createPostgresStorage } from "@uniora/postgres";
import { assertCan, assertAccess } from "../../../packages/next/dist/guard.js";
import { authorizeRoute } from "../../../packages/next/dist/route.js";

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
// SETUP: dos organizaciones con datos claramente distinguibles, y un juego
// completo de identidades atacantes (A-J del prompt).
// ---------------------------------------------------------------------------
async function setup(storage, label) {
  const { organization: orgA, ownerRole: ownerRoleA } = await createOrganizationWithOwner(storage, {
    organizationId: `org-a-${label}`,
    organizationName: "ORG_A_SECRET",
    ownerRoleId: `role-owner-a-${label}`,
    membershipId: `m-owner-a-${label}`,
    ownerIdentity: { provider: "e2e", subject: `owner-a-${label}` },
  });
  const { organization: orgB, ownerRole: ownerRoleB } = await createOrganizationWithOwner(storage, {
    organizationId: `org-b-${label}`,
    organizationName: "ORG_B_SECRET",
    ownerRoleId: `role-owner-b-${label}`,
    membershipId: `m-owner-b-${label}`,
    ownerIdentity: { provider: "e2e", subject: `owner-b-${label}` },
  });

  await storage.permissions.register({ key: "secret.read" });
  await storage.permissions.register({ key: "secret.write" });
  await storage.features.register({ name: "Secret Feature", key: "secret_feature" });

  // B — admin (non-owner) de Org A, con un permiso concreto.
  const roleAdminA = await storage.roles.create({
    id: `role-admin-a-${label}`,
    organizationId: orgA.id,
    name: "Admin",
    permissionKeys: ["secret.read"],
  });
  const memberB = await storage.memberships.create({
    id: `m-admin-a-${label}`,
    organizationId: orgA.id,
    identity: { provider: "e2e", subject: `admin-a-${label}` },
    roleIds: [roleAdminA.id],
  });

  // C — member normal de Org A, SIN ningún permiso.
  const roleMemberA = await storage.roles.create({
    id: `role-member-a-${label}`,
    organizationId: orgA.id,
    name: "Member",
    permissionKeys: [],
  });
  const memberC = await storage.memberships.create({
    id: `m-member-a-${label}`,
    organizationId: orgA.id,
    identity: { provider: "e2e", subject: `member-a-${label}` },
    roleIds: [roleMemberA.id],
  });

  // D — outsider: identidad válida, SIN membership en ninguna organización.
  const outsiderD = { provider: "e2e", subject: `outsider-${label}` };

  // F — cross-org: pertenece a Org A (member, sin permisos) y a Org B (admin, con secret.write).
  const roleAdminB = await storage.roles.create({
    id: `role-admin-b-${label}`,
    organizationId: orgB.id,
    name: "AdminB",
    permissionKeys: ["secret.write"],
  });
  const memberF_inA = await storage.memberships.create({
    id: `m-crossA-${label}`,
    organizationId: orgA.id,
    identity: { provider: "e2e", subject: `crossorg-${label}` },
    roleIds: [],
  });
  const memberF_inB = await storage.memberships.create({
    id: `m-crossB-${label}`,
    organizationId: orgB.id,
    identity: { provider: "e2e", subject: `crossorg-${label}` },
    roleIds: [roleAdminB.id],
  });

  await storage.features.enable(orgA.id, "secret_feature");

  return {
    orgA,
    orgB,
    ownerRoleA,
    ownerRoleB,
    roleAdminA,
    roleMemberA,
    roleAdminB,
    memberB,
    memberC,
    memberF_inA,
    memberF_inB,
    identities: {
      ownerA: { provider: "e2e", subject: `owner-a-${label}` },
      ownerB: { provider: "e2e", subject: `owner-b-${label}` },
      adminA: { provider: "e2e", subject: `admin-a-${label}` },
      memberA: { provider: "e2e", subject: `member-a-${label}` },
      outsider: outsiderD,
      crossorg: { provider: "e2e", subject: `crossorg-${label}` },
    },
  };
}

const memCtx = await setup(mem_storage, "mem");
const pgCtx = await setup(pg_storage, "pg");

// ---------------------------------------------------------------------------
// ATAQUE 1 — Re-verificación exhaustiva de Hallazgo 1/4 en las 4 ramas de
// access.check(), en AMBOS adapters, y a través del engine + snapshot +
// @uniora/next (assertAccess/authorizeRoute) — no confiar en que el fix de
// engine.ts se propagó correctamente a todo lo que lo envuelve.
// ---------------------------------------------------------------------------
section("ATAQUE 1 — access.check() en sus 4 combinaciones, todas las capas, ambos adapters");

async function attack1(engine, ctx, adapterLabel) {
  const outsider = ctx.identities.outsider;
  const orgAId = ctx.orgA.id;

  // outsider (D), sin membership en NINGUNA organización.
  const neither = await engine.access.check({ identity: outsider, organizationId: orgAId });
  ok(`[${adapterLabel}] outsider sin membership, access.check() sin permission/feature`, neither === false, `resultado=${neither}`);

  const featureOnly = await engine.access.check({ identity: outsider, organizationId: orgAId, feature: "secret_feature" });
  ok(`[${adapterLabel}] outsider sin membership, feature-only (habilitada en la org)`, featureOnly === false, `resultado=${featureOnly}`);

  const permOnly = await engine.access.check({ identity: outsider, organizationId: orgAId, permission: "secret.read" });
  ok(`[${adapterLabel}] outsider sin membership, permission-only`, permOnly === false, `resultado=${permOnly}`);

  const both = await engine.access.check({ identity: outsider, organizationId: orgAId, permission: "secret.read", feature: "secret_feature" });
  ok(`[${adapterLabel}] outsider sin membership, permission+feature`, both === false, `resultado=${both}`);

  // F — cross-org: pertenece a B, pregunta por A (feature-only, ya que A
  // tiene secret_feature habilitada pero F no es miembro de A).
  const crossFeatureOnly = await engine.access.check({ identity: ctx.identities.ownerB, organizationId: orgAId, feature: "secret_feature" });
  ok(`[${adapterLabel}] Owner de Org B (SIN membership en A) pregunta feature-only sobre A`, crossFeatureOnly === false, `resultado=${crossFeatureOnly}`);

  // Miembro real de A (memberA, sin permisos) — feature-only debe dar true (feature habilitada + membership real).
  const legitFeature = await engine.access.check({ identity: ctx.identities.memberA, organizationId: orgAId, feature: "secret_feature" });
  ok(`[${adapterLabel}] miembro real de A, feature-only (control positivo)`, legitFeature === true, `resultado=${legitFeature}`);
}
await attack1(memEngine, memCtx, "memory");
await attack1(pgEngine, pgCtx, "postgres");

section("ATAQUE 1b — mismo patrón en computeAuthorizationSnapshot()");

async function attack1b(engine, storage, ctx, adapterLabel) {
  const snap = await computeAuthorizationSnapshot(engine, storage.features, {
    identity: ctx.identities.ownerB,
    organizationId: ctx.orgA.id,
    permissions: ["secret.read"],
    features: ["secret_feature"],
  });
  ok(
    `[${adapterLabel}] snapshot: Owner de B (SIN membership en A) pidiendo permission+feature de A`,
    snap.permissions["secret.read"] === false && snap.features["secret_feature"] === false,
    JSON.stringify(snap),
  );

  const snapFeatOnly = await computeAuthorizationSnapshot(engine, storage.features, {
    identity: ctx.identities.outsider,
    organizationId: ctx.orgA.id,
    features: ["secret_feature"],
  });
  ok(
    `[${adapterLabel}] snapshot: outsider, features-only (sin permissions pedidos)`,
    snapFeatOnly.features["secret_feature"] === false,
    JSON.stringify(snapFeatOnly),
  );
}
await attack1b(memEngine, mem_storage, memCtx, "memory");
await attack1b(pgEngine, pg_storage, pgCtx, "postgres");

section("ATAQUE 1c — @uniora/next: assertAccess / authorizeRoute (misma clase de bug, capa de framework)");

async function attack1c(engine, ctx, adapterLabel) {
  let threw = false;
  try {
    await assertAccess(engine, { identity: ctx.identities.ownerB, organizationId: ctx.orgA.id, feature: "secret_feature" });
  } catch {
    threw = true;
  }
  ok(`[${adapterLabel}] assertAccess: Owner de B (SIN membership en A) pidiendo feature-only de A debe lanzar`, threw === true);

  const response = await authorizeRoute(engine, { identity: ctx.identities.ownerB, organizationId: ctx.orgA.id, feature: "secret_feature" });
  ok(`[${adapterLabel}] authorizeRoute: mismo caso debe devolver Response (denegado), no null`, response !== null && response.status === 403);

  let sawUnauthorizedCan = false;
  try {
    await assertCan(engine, { identity: ctx.identities.outsider, organizationId: ctx.orgA.id, permission: "secret.read" });
  } catch {
    sawUnauthorizedCan = true;
  }
  ok(`[${adapterLabel}] assertCan: outsider sin permission debe lanzar`, sawUnauthorizedCan === true);
}
await attack1c(memEngine, memCtx, "memory");
await attack1c(pgEngine, pgCtx, "postgres");

// ---------------------------------------------------------------------------
// ATAQUE 2 — TOCTOU: dos Owners de la MISMA organización se demueven
// mutuamente en paralelo (multi-owner válido por diseño). El guard atómico
// existente protege "una fila contra sí misma", pero ¿protege contra dos
// filas DISTINTAS del mismo role_id compitiendo entre sí? (versión rápida
// sobre memoria; la versión seria/repetida contra Postgres real es 2b.)
// ---------------------------------------------------------------------------
section("ATAQUE 2 — TOCTOU: dos Owners se demuelen mutuamente en paralelo (race de last-owner, memoria)");

{
  const secondOwnerIdentity = { provider: "e2e", subject: "second-owner-mem" };
  const secondOwnerMembership = await mem_storage.memberships.create({
    id: "m-second-owner-mem",
    organizationId: memCtx.orgA.id,
    identity: secondOwnerIdentity,
  });
  await mem_storage.memberships.assignOwnerRole(secondOwnerMembership.id, memCtx.ownerRoleA.id);

  const originalOwnerMembership = await mem_storage.memberships.findByIdentity(memCtx.orgA.id, memCtx.identities.ownerA);
  const ownersBefore = await mem_storage.memberships.countByRole([memCtx.ownerRoleA.id]);
  ok("[memory] setup: org tiene 2 Owners antes del ataque", ownersBefore[memCtx.ownerRoleA.id] === 2, `owners=${ownersBefore[memCtx.ownerRoleA.id]}`);

  const p1 = mem_storage.memberships.unassignOwnerRole(originalOwnerMembership.id, memCtx.ownerRoleA.id).then(() => "ok").catch((e) => `rejected:${e.message}`);
  const p2 = mem_storage.memberships.unassignOwnerRole(secondOwnerMembership.id, memCtx.ownerRoleA.id).then(() => "ok").catch((e) => `rejected:${e.message}`);
  const [r1, r2] = await Promise.all([p1, p2]);

  const ownersAfter = await mem_storage.memberships.countByRole([memCtx.ownerRoleA.id]);
  const count = ownersAfter[memCtx.ownerRoleA.id];
  console.log(`  [memory] r1=${r1} r2=${r2} owners_finales=${count}`);
  ok("[memory] tras la race, la org NUNCA se queda con 0 Owners", count >= 1, `owners restantes=${count} (esperado >= 1)`);
}

// ---------------------------------------------------------------------------
// ATAQUE 2b — TOCTOU más limpio y directo: EXACTAMENTE 2 Owners, cada uno
// intenta remover al OTRO en el mismo instante, sin ningún ruido adicional.
// Repetido varias veces contra Postgres real para maximizar la ventana de
// carrera.
// ---------------------------------------------------------------------------
section("ATAQUE 2b — TOCTOU limpio: exactamente 2 Owners, remoción mutua simultánea (repetido x5, Postgres real)");

for (let round = 0; round < 5; round++) {
  const orgId = `org-toctou-${round}`;
  const { organization, ownerRole, membership: owner1 } = await createOrganizationWithOwner(pg_storage, {
    organizationId: orgId,
    organizationName: `TOCTOU_ORG_${round}`,
    ownerRoleId: `role-owner-toctou-${round}`,
    membershipId: `m-owner1-toctou-${round}`,
    ownerIdentity: { provider: "e2e", subject: `owner1-toctou-${round}` },
  });
  const owner2 = await pg_storage.memberships.create({
    id: `m-owner2-toctou-${round}`,
    organizationId: orgId,
    identity: { provider: "e2e", subject: `owner2-toctou-${round}` },
  });
  await pg_storage.memberships.assignOwnerRole(owner2.id, ownerRole.id);

  // Disparar SIN await intermedio para maximizar la superposición real de
  // las dos conexiones de red hacia Postgres.
  const p1 = pg_storage.memberships.unassignOwnerRole(owner1.id, ownerRole.id).then(() => "removed1").catch((e) => `rejected1:${e.message}`);
  const p2 = pg_storage.memberships.unassignOwnerRole(owner2.id, ownerRole.id).then(() => "removed2").catch((e) => `rejected2:${e.message}`);
  const [r1, r2] = await Promise.all([p1, p2]);

  const finalCount = (await pg_storage.memberships.countByRole([ownerRole.id]))[ownerRole.id];
  const bothSucceeded = r1.startsWith("removed") && r2.startsWith("removed");
  console.log(`  ronda ${round}: r1=${r1} r2=${r2} owners_finales=${finalCount}`);
  if (finalCount === 0) {
    FAIL++;
    findings.push(`TOCTOU last-owner: ronda ${round} dejó la organización SIN NINGÚN OWNER (bothSucceeded=${bothSucceeded})`);
    console.log(`  !!VULN!! ronda ${round}: la organización quedó con 0 Owners — invariante roto por race condition.`);
  } else {
    PASS++;
  }
}

// ---------------------------------------------------------------------------
// ATAQUE 3 — TOCTOU en IdentityLink: A->B y B->C creados EN PARALELO,
// burlando el chequeo simétrico "no chains" (Hallazgo 6) por pura
// condición de carrera (dos SELECTs + INSERT sin lock).
// ---------------------------------------------------------------------------
section("ATAQUE 3 — TOCTOU: cadena de IdentityLink (A->B, B->C) creada por condición de carrera");

async function attack3(storage, adapterLabel) {
  const A = { provider: "chain", subject: `A-${adapterLabel}` };
  const B = { provider: "chain", subject: `B-${adapterLabel}` };
  const C = { provider: "chain", subject: `C-${adapterLabel}` };

  const p1 = storage.identityLinks.link({ from: A, to: B, actor: B }).then(() => "ok").catch((e) => `rejected:${e.message}`);
  const p2 = storage.identityLinks.link({ from: B, to: C, actor: C }).then(() => "ok").catch((e) => `rejected:${e.message}`);
  const [r1, r2] = await Promise.all([p1, p2]);
  console.log(`  [${adapterLabel}] A->B: ${r1} | B->C: ${r2}`);

  const bothCreated = r1 === "ok" && r2 === "ok";
  ok(`[${adapterLabel}] 'no chains' resiste la creación concurrente de A->B y B->C`, !bothCreated, `A->B=${r1}, B->C=${r2}`);
}
await attack3(mem_storage, "memory");
await attack3(pg_storage, "postgres");

// ---------------------------------------------------------------------------
// ATAQUE 4 — delete role -> recreate con el MISMO id: ¿sobreviven permisos
// o asignaciones fantasma?
// ---------------------------------------------------------------------------
section("ATAQUE 4 — delete role + recreate con el mismo id: sin grants fantasma");

async function attack4(storage, ctx, adapterLabel) {
  const doomedRole = await storage.roles.create({
    id: `role-doomed-${adapterLabel}`,
    organizationId: ctx.orgA.id,
    name: `Doomed ${adapterLabel}`,
    permissionKeys: ["secret.read", "secret.write"],
  });
  const victim = await storage.memberships.create({
    id: `m-doomed-victim-${adapterLabel}`,
    organizationId: ctx.orgA.id,
    identity: { provider: "e2e", subject: `doomed-victim-${adapterLabel}` },
    roleIds: [doomedRole.id],
  });

  await storage.roles.delete(doomedRole.id);

  // Recrear un role NUEVO con el mismo id, SIN permisos.
  const recreated = await storage.roles.create({
    id: `role-doomed-${adapterLabel}`,
    organizationId: ctx.orgA.id,
    name: `Recreated ${adapterLabel}`,
    permissionKeys: [],
  });

  const victimAfter = await storage.memberships.findById(victim.id);
  ok(
    `[${adapterLabel}] el membership no queda apuntando al role recreado sin haberlo pedido`,
    !victimAfter.roleIds.includes(recreated.id),
    `roleIds=${JSON.stringify(victimAfter.roleIds)}`,
  );

  const canReadNow = await (adapterLabel === "memory" ? memEngine : pgEngine).can({
    identity: { provider: "e2e", subject: `doomed-victim-${adapterLabel}` },
    organizationId: ctx.orgA.id,
    permission: "secret.read",
  });
  ok(`[${adapterLabel}] el permiso del role borrado NO sobrevive tras recrear con el mismo id`, canReadNow === false);
}
await attack4(mem_storage, memCtx, "memory");
await attack4(pg_storage, pgCtx, "postgres");

// ---------------------------------------------------------------------------
// ATAQUE 5 — Orphan state vía SQL directo: un membership_roles apuntando a
// un role de OTRA organización (bypass del adapter). ¿can() lo filtra
// igual que si viniera por la API normal?
// ---------------------------------------------------------------------------
section("ATAQUE 5 — orphan state: membership_roles con role de otra organización (SQL directo, solo Postgres)");

{
  const victim = await pg_storage.memberships.create({
    id: "m-orphan-victim",
    organizationId: pgCtx.orgA.id,
    identity: { provider: "e2e", subject: "orphan-victim" },
  });
  // Inserción directa, saltándose por completo el guard de assignRole/create.
  await pool.query(`insert into uniora.membership_roles (membership_id, role_id) values ($1, $2)`, [
    victim.id,
    pgCtx.ownerRoleB.id, // el Owner role de la OTRA organización
  ]);

  const canAsOwnerOfA = await pgEngine.can({
    identity: { provider: "e2e", subject: "orphan-victim" },
    organizationId: pgCtx.orgA.id,
    permission: "secret.read",
  });
  ok(
    "una fila fantasma que enlaza a un membership de A con el Owner role de B NO concede acceso en A",
    canAsOwnerOfA === false,
    `resultado=${canAsOwnerOfA}`,
  );

  const canAsOwnerOfB = await pgEngine.can({
    identity: { provider: "e2e", subject: "orphan-victim" },
    organizationId: pgCtx.orgB.id,
    permission: "secret.write",
  });
  ok(
    "esa misma fila fantasma tampoco concede acceso en B (el membership en sí vive en A, no en B)",
    canAsOwnerOfB === false,
    `resultado=${canAsOwnerOfB}`,
  );
}

// ---------------------------------------------------------------------------
// ATAQUE 6 — Mass assignment: intentar inyectar isOwnerRole / organizationId
// / ids alternativos vía los inputs públicos de create().
// ---------------------------------------------------------------------------
section("ATAQUE 6 — mass assignment contra CreateRoleInput / CreateMembershipInput");

async function attack6(storage, ctx, adapterLabel) {
  const maliciousRole = await storage.roles.create({
    id: `role-mass-${adapterLabel}`,
    organizationId: ctx.orgA.id,
    name: `MassAssign ${adapterLabel}`,
    permissionKeys: ["secret.read"],
    // Campos que NO existen en CreateRoleInput pero que un atacante con
    // control sobre el JSON de una petición podría intentar colar.
    isOwnerRole: true,
    id2: "hijack",
  });
  ok(`[${adapterLabel}] isOwnerRole inyectado en CreateRoleInput es ignorado`, maliciousRole.isOwnerRole === false, `isOwnerRole=${maliciousRole.isOwnerRole}`);

  const maliciousMembership = await storage.memberships.create({
    id: `m-mass-${adapterLabel}`,
    organizationId: ctx.orgA.id,
    identity: { provider: "e2e", subject: `mass-${adapterLabel}` },
    roleIds: [],
    // Campo inventado que, si se leyera por accidente en vez de organizationId,
    // apuntaría al membership a otra organización.
    organization: ctx.orgB.id,
  });
  ok(`[${adapterLabel}] campo 'organization' (no 'organizationId') inyectado no mueve el membership a Org B`, maliciousMembership.organizationId === ctx.orgA.id, `organizationId=${maliciousMembership.organizationId}`);
}
await attack6(mem_storage, memCtx, "memory");
await attack6(pg_storage, pgCtx, "postgres");

// ---------------------------------------------------------------------------
// ATAQUE 7 — IDOR: roleId/membershipId de B usados en llamadas de bajo
// nivel dentro del contexto de A. Confirmamos qué SÍ filtra por organización
// (assignRole ya lo hace, confirmado antes) vs. qué es deliberadamente
// "lookup crudo, sin autorización" (findByIds).
// ---------------------------------------------------------------------------
section("ATAQUE 7 — IDOR cruzado: assignRole(membership de A, roleId de B)");

async function attack7(storage, ctx, adapterLabel) {
  let rejected = false;
  try {
    await storage.memberships.assignRole(ctx.memberC.id, ctx.roleAdminB.id);
  } catch {
    rejected = true;
  }
  ok(`[${adapterLabel}] assignRole rechaza un roleId de otra organización`, rejected === true);

  // Confirmar que, aunque se rechace, no queda NINGÚN rastro parcial.
  const membershipAfter = await storage.memberships.findById(ctx.memberC.id);
  ok(`[${adapterLabel}] tras el rechazo, el membership no ganó el roleId de B de ninguna forma`, !membershipAfter.roleIds.includes(ctx.roleAdminB.id));
}
await attack7(mem_storage, memCtx, "memory");
await attack7(pg_storage, pgCtx, "postgres");

// ---------------------------------------------------------------------------
// ATAQUE 8 — Transacción parcial: forzar un fallo a mitad de
// createOrganizationWithOwner y verificar que NADA queda a medio crear
// (Postgres real, rollback real).
// ---------------------------------------------------------------------------
section("ATAQUE 8 — fallo a mitad de una transacción multi-paso: sin estado privilegiado parcial");

{
  let threw = false;
  try {
    await createOrganizationWithOwner(pg_storage, {
      organizationId: "org-partial-fail",
      organizationName: "PARTIAL_FAIL",
      ownerRoleId: "role-owner-a-pg", // id YA usado por orgA — debe chocar y abortar toda la transacción
      membershipId: "m-partial-fail",
      ownerIdentity: { provider: "e2e", subject: "partial-fail-owner" },
    });
  } catch {
    threw = true;
  }
  ok("createOrganizationWithOwner con un id duplicado a mitad de camino lanza", threw === true);

  const orgExists = await pg_storage.organizations.findById("org-partial-fail");
  ok("la organización NO quedó creada a medias (rollback real)", orgExists === null, `orgExists=${orgExists}`);

  const membershipExists = await pg_storage.memberships.findById("m-partial-fail");
  ok("el membership fundador tampoco quedó creado a medias", membershipExists === null, `membershipExists=${membershipExists}`);
}

// ---------------------------------------------------------------------------
// ATAQUE 9 — Confusión de input: identidades con mismo valor lógico pero
// distinta representación (espacios, mayúsculas, unicode NFKD/NFC).
// ---------------------------------------------------------------------------
section("ATAQUE 9 — confusión de identidad: variantes de mayúsculas/espacios/unicode NO colisionan silenciosamente");

async function attack9(storage, ctx, adapterLabel) {
  const real = ctx.identities.ownerA; // { provider: "e2e", subject: "owner-a-<label>" }
  const variants = [
    { provider: real.provider.toUpperCase(), subject: real.subject },
    { provider: real.provider, subject: real.subject.toUpperCase() },
    { provider: real.provider, subject: ` ${real.subject}` },
    { provider: real.provider, subject: `${real.subject} ` },
    // "é" (U+00E9, precomposed/NFC) vs "e" + combining acute accent
    // (U+0065 U+0301, decomposed/NFD) render IDENTICALLY but are different
    // byte sequences — a real Unicode-normalization confusion test, unlike
    // comparing an ASCII string to itself.
    { provider: real.provider, subject: `${real.subject}-café`.normalize("NFC") },
  ];
  const nfcVariant = `${real.subject}-café`.normalize("NFC");
  const nfdVariant = `${real.subject}-café`.normalize("NFD");
  for (const variant of variants) {
    const membership = await storage.memberships.findByIdentity(ctx.orgA.id, variant);
    ok(
      `[${adapterLabel}] variante "${variant.provider}:${JSON.stringify(variant.subject)}" NO resuelve al Owner real`,
      membership === null,
      membership ? `matcheó membership ${membership.id}` : "sin match (correcto)",
    );
  }

  // Crear un membership real con el subject en forma NFC, y confirmar que
  // buscarlo con la forma NFD (mismo texto visible, distintos bytes) NO
  // colisiona silenciosamente con él ni con nada más.
  const nfcMember = await storage.memberships.create({
    id: `m-nfc-${adapterLabel}`,
    organizationId: ctx.orgA.id,
    identity: { provider: "e2e", subject: nfcVariant },
    roleIds: [],
  });
  const foundViaNfd = await storage.memberships.findByIdentity(ctx.orgA.id, { provider: "e2e", subject: nfdVariant });
  ok(
    `[${adapterLabel}] buscar por la variante NFD de un subject creado en NFC no colisiona por normalización implícita`,
    foundViaNfd === null || foundViaNfd.id === nfcMember.id,
    foundViaNfd ? `resolvió a ${foundViaNfd.id} (esperado: null o el propio ${nfcMember.id}, nunca otro membership)` : "sin match",
  );
}
await attack9(mem_storage, memCtx, "memory");
await attack9(pg_storage, pgCtx, "postgres");

// ---------------------------------------------------------------------------
// ATAQUE 10 — Valores vacíos/ambiguos en permission/feature.
// ---------------------------------------------------------------------------
section("ATAQUE 10 — permission/feature vacíos, null-ish, no producen ALLOW accidental");

async function attack10(engine, ctx, adapterLabel) {
  const emptyPerm = await engine.can({ identity: ctx.identities.memberA, organizationId: ctx.orgA.id, permission: "" });
  ok(`[${adapterLabel}] can() con permission="" deniega`, emptyPerm === false, `resultado=${emptyPerm}`);

  const emptyFeature = await engine.access.check({ identity: ctx.identities.memberA, organizationId: ctx.orgA.id, feature: "" });
  ok(`[${adapterLabel}] access.check() con feature="" deniega`, emptyFeature === false, `resultado=${emptyFeature}`);

  // El caso MAS critico: access.check() (no can() directo) con permission=""
  // -- este es el que de verdad usan assertAccess/authorizeRoute/Studio.
  const emptyPermViaCheck = await engine.access.check({ identity: ctx.identities.memberA, organizationId: ctx.orgA.id, permission: "" });
  ok(`[${adapterLabel}] access.check() con permission="" deniega (no solo can() directo)`, emptyPermViaCheck === false, `resultado=${emptyPermViaCheck}`);
}
await attack10(memEngine, memCtx, "memory");
await attack10(pgEngine, pgCtx, "postgres");

// ---------------------------------------------------------------------------
// RESUMEN
// ---------------------------------------------------------------------------
section("RESUMEN RONDA 4");
console.log(`PASS=${PASS}  FAIL=${FAIL}`);
if (findings.length > 0) {
  console.log("\nHallazgos a investigar:");
  for (const f of findings) console.log(`  - ${f}`);
}

await pool.end();
