// PENTEST — Ronda 9: State Reconstruction, Persistence Corruption &
// Recovery Warfare. ¿Puede UNIORA interpretar de forma insegura un
// estado que fue persistido, reconstruido, corrompido a mano, o
// alcanzado por una vía distinta a la API pública "feliz"? TEMPORAL,
// no se commitea. Base aislada: uniora_pentest.
import pg from "pg";
import { createAuthorizationEngine, createOrganizationWithOwner, computeAuthorizationSnapshot } from "@uniora/core";
import { applyMigrations, createPostgresStorage } from "@uniora/postgres";

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
function note(msg) {
  console.log("  · " + msg);
}

async function makeOrg(storage, suffix) {
  const created = await createOrganizationWithOwner(storage, {
    organizationId: `org-${suffix}`,
    organizationName: `Round9Org${suffix}`,
    ownerRoleId: `role-owner-${suffix}`,
    membershipId: `m-owner-${suffix}`,
    ownerIdentity: { provider: "e2e", subject: `owner-${suffix}` },
  });
  return created.organization;
}

// ===========================================================================
// SECCIÓN 1 — ROUND-TRIP / RECONSTRUCTION EQUIVALENCE (R1, R12)
// Construye un estado con múltiples orgs, roles, permisos, features e
// identity links; calcula un vector de decisiones de autorización.
// Después crea una instancia de storage COMPLETAMENTE NUEVA (pool nuevo,
// simulando un reinicio de proceso/reconexión) y recalcula el MISMO
// vector — deben coincidir exactamente, entrada por entrada.
// ===========================================================================
section("SECCIÓN 1 — Round-trip: ¿la autorización sobrevive idéntica a una instancia de storage completamente nueva?");
{
  const storage = createPostgresStorage(pool);
  const org = await makeOrg(storage, "roundtrip");
  await storage.permissions.register({ key: "rt.action" });
  await storage.features.register({ key: "rt_feature", name: "RT Feature" });
  const role = await storage.roles.create({ id: "role-rt", organizationId: org.id, name: "RT Role", permissionKeys: ["rt.action"] });
  await storage.features.enable(org.id, "rt_feature");
  const member = await storage.memberships.create({ id: "m-rt", organizationId: org.id, identity: { provider: "e2e", subject: "rt-user" }, roleIds: [role.id] });
  const alias = { provider: "legacy", subject: "rt-alias" };
  await storage.identityLinks.link({ from: alias, to: { provider: "e2e", subject: "rt-user" }, actor: { provider: "e2e", subject: "owner-roundtrip" } });

  const engineBefore = createAuthorizationEngine(storage);
  const vectorBefore = {
    canDirect: await engineBefore.can({ identity: { provider: "e2e", subject: "rt-user" }, organizationId: org.id, permission: "rt.action" }),
    canAlias: await engineBefore.can({ identity: alias, organizationId: org.id, permission: "rt.action" }),
    checkFeature: await engineBefore.access.check({ identity: { provider: "e2e", subject: "rt-user" }, organizationId: org.id, feature: "rt_feature" }),
    checkOwner: await engineBefore.can({ identity: { provider: "e2e", subject: "owner-roundtrip" }, organizationId: org.id, permission: "anything.goes" }),
    snapshot: await computeAuthorizationSnapshot(engineBefore, storage.features, { identity: alias, organizationId: org.id, permissions: ["rt.action"], features: ["rt_feature"] }),
  };

  // Nueva instancia de storage, nuevo Pool — nada de estado JS compartido
  // con la anterior (simula un proceso reiniciado que solo comparte la DB).
  const freshPool = new pg.Pool({ connectionString: "postgresql://postgres:uniora@localhost:55432/uniora_pentest" });
  const freshStorage = createPostgresStorage(freshPool);
  const engineAfter = createAuthorizationEngine(freshStorage);
  const vectorAfter = {
    canDirect: await engineAfter.can({ identity: { provider: "e2e", subject: "rt-user" }, organizationId: org.id, permission: "rt.action" }),
    canAlias: await engineAfter.can({ identity: alias, organizationId: org.id, permission: "rt.action" }),
    checkFeature: await engineAfter.access.check({ identity: { provider: "e2e", subject: "rt-user" }, organizationId: org.id, feature: "rt_feature" }),
    checkOwner: await engineAfter.can({ identity: { provider: "e2e", subject: "owner-roundtrip" }, organizationId: org.id, permission: "anything.goes" }),
    snapshot: await computeAuthorizationSnapshot(engineAfter, freshStorage.features, { identity: alias, organizationId: org.id, permissions: ["rt.action"], features: ["rt_feature"] }),
  };
  await freshPool.end();

  note(`Antes: ${JSON.stringify(vectorBefore)}`);
  note(`Después (instancia nueva): ${JSON.stringify(vectorAfter)}`);
  ok("R1 — reconstruction equivalence: el vector completo de decisiones es idéntico tras una instancia de storage nueva", JSON.stringify(vectorBefore) === JSON.stringify(vectorAfter));
}

// ===========================================================================
// SECCIÓN 2 — NULL / ABSENT / TYPE-CONFUSION contra el Engine (bypass de
// TypeScript deliberado — igual que rondas 4/5, pero enfocado
// específicamente en qué CREE cada componente que significan estos valores).
// ===========================================================================
section("SECCIÓN 2 — Null/absent/type-confusion directos contra AuthorizationEngine/computeAuthorizationSnapshot");
{
  const storage = createPostgresStorage(pool);
  const org = await makeOrg(storage, "nullattack");
  await storage.permissions.register({ key: "null.test" });
  const role = await storage.roles.create({ id: "role-null", organizationId: org.id, name: "NullRole", permissionKeys: ["null.test"] });
  await storage.memberships.create({ id: "m-null", organizationId: org.id, identity: { provider: "e2e", subject: "null-user" }, roleIds: [role.id] });
  const engine = createAuthorizationEngine(storage);
  const realIdentity = { provider: "e2e", subject: "null-user" };

  async function safeCall(label, fn) {
    try {
      const result = await fn();
      note(`${label} → ${JSON.stringify(result)}`);
      ok(`${label}: nunca resuelve a allow/true bajo input malformado`, result !== true, result === true ? "CRÍTICO: input malformado produjo allow" : "");
    } catch (error) {
      note(`${label} → lanzó: ${error.constructor.name}: ${error.message}`);
      ok(`${label}: fallar con una excepción es fail-closed (correcto)`, true);
    }
  }

  await safeCall("can({organizationId: null})", () => engine.can({ identity: realIdentity, organizationId: null, permission: "null.test" }));
  await safeCall("can({permission: null})", () => engine.can({ identity: realIdentity, organizationId: org.id, permission: null }));
  await safeCall("can({identity: null})", () => engine.can({ identity: null, organizationId: org.id, permission: "null.test" }));
  await safeCall("can({identity: {provider: null, subject: 'null-user'}})", () => engine.can({ identity: { provider: null, subject: "null-user" }, organizationId: org.id, permission: "null.test" }));
  await safeCall("can({identity: {provider: 'e2e', subject: null}})", () => engine.can({ identity: { provider: "e2e", subject: null }, organizationId: org.id, permission: "null.test" }));
  await safeCall("can({organizationId: undefined})", () => engine.can({ identity: realIdentity, organizationId: undefined, permission: "null.test" }));
  await safeCall("can({permission: []})", () => engine.can({ identity: realIdentity, organizationId: org.id, permission: [] }));
  await safeCall("can({permission: {}})", () => engine.can({ identity: realIdentity, organizationId: org.id, permission: {} }));
  await safeCall("can({permission: 0})", () => engine.can({ identity: realIdentity, organizationId: org.id, permission: 0 }));
  await safeCall("can({organizationId: {}})", () => engine.can({ identity: realIdentity, organizationId: {}, permission: "null.test" }));
  await safeCall("access.check({}) — ni permission ni feature, organizationId real, identidad SIN membership", () =>
    engine.access.check({ identity: { provider: "nobody", subject: "nobody" }, organizationId: org.id }),
  );
  await safeCall("computeAuthorizationSnapshot({permissions: null})", () =>
    computeAuthorizationSnapshot(engine, storage.features, { identity: realIdentity, organizationId: org.id, permissions: null }),
  );
  await safeCall("computeAuthorizationSnapshot({features: 'not-an-array'})", () =>
    computeAuthorizationSnapshot(engine, storage.features, { identity: realIdentity, organizationId: org.id, features: "not-an-array" }),
  );
}

// ===========================================================================
// SECCIÓN 3 — CONTROLLED DATABASE CORRUPTION: construir estados
// "imposibles" vía SQL directo (bypaseando el Core por completo) y
// verificar que el sistema falla cerrado ante cada uno.
// ===========================================================================
section("SECCIÓN 3 — Corrupción controlada de la base: ¿el sistema falla cerrado ante estados inalcanzables por la API pública?");
{
  const storage = createPostgresStorage(pool);
  const orgA = await makeOrg(storage, "corrupt-a");
  const orgB = await makeOrg(storage, "corrupt-b");
  const engine = createAuthorizationEngine(storage);

  // 3a — membership_roles cruzado (role de Org B asignado a membership de Org A) — regresión de Ronda 4, re-confirmado bajo esta metodología.
  {
    const roleB = await storage.roles.create({ id: "role-corrupt-b", organizationId: orgB.id, name: "Secret B" });
    await storage.permissions.register({ key: "corrupt.secret" });
    await storage.roles.grantPermission(roleB.id, "corrupt.secret");
    const memberA = await storage.memberships.create({ id: "m-corrupt-a", organizationId: orgA.id, identity: { provider: "e2e", subject: "corrupt-a-user" } });
    await pool.query(`insert into uniora.membership_roles (membership_id, role_id) values ($1, $2)`, [memberA.id, roleB.id]);
    const can = await engine.can({ identity: { provider: "e2e", subject: "corrupt-a-user" }, organizationId: orgA.id, permission: "corrupt.secret" });
    note(`3a: membership_roles(orgA member, orgB role) insertado a mano vía SQL. can()=${can}`);
    ok("3a: el Engine nunca concede un permiso de un role cross-org, incluso con la fila insertada a mano", can === false);
  }

  // 3b — segundo Owner role para la misma organización, insertado a mano (bypaseando createOwnerRole()'s chequeo de aplicación) — ¿lo detiene el índice único parcial real?
  {
    let blocked = false;
    try {
      await pool.query(
        `insert into uniora.roles (id, organization_id, name, key, is_owner_role) values ($1, $2, $3, $4, true)`,
        ["role-second-owner", orgA.id, "Second Owner", "second-owner"],
      );
    } catch (error) {
      blocked = true;
      note(`3b: segundo Owner role insertado a mano vía SQL → rechazado por Postgres: ${error.message}`);
    }
    ok("3b: el índice único parcial (organization_id) where is_owner_role bloquea un segundo Owner incluso vía SQL directo", blocked);
  }

  // 3c — role_permissions apuntando a un permission_key NUNCA registrado — ¿lo detiene la FK real?
  {
    let blocked = false;
    try {
      await pool.query(`insert into uniora.role_permissions (role_id, permission_key) values ($1, $2)`, ["role-corrupt-b", "never.registered"]);
    } catch (error) {
      blocked = true;
      note(`3c: role_permissions→permission nunca registrado → rechazado: ${error.message}`);
    }
    ok("3c: la FK real de role_permissions.permission_key bloquea un permiso nunca registrado, incluso vía SQL directo", blocked);
  }

  // 3d — membership duplicado para la misma identidad en la misma org, insertado a mano — ¿lo detiene el unique constraint real?
  {
    let blocked = false;
    try {
      await pool.query(
        `insert into uniora.memberships (id, organization_id, provider, subject) values ($1, $2, $3, $4)`,
        ["m-corrupt-a-dup", orgA.id, "e2e", "corrupt-a-user"],
      );
    } catch (error) {
      blocked = true;
      note(`3d: membership duplicado insertado a mano vía SQL → rechazado: ${error.message}`);
    }
    ok("3d: el unique(organization_id, provider, subject) bloquea un duplicado incluso vía SQL directo", blocked);
  }

  // 3e — Organización SIN ningún Owner (alcanzable vía API pública real:
  // llamar organizations.create() sin pasar por createOrganizationWithOwner).
  // No es "corrupción" — es un estado LEGÍTIMO y ya documentado (CLI doctor
  // lo detecta con un warning). Verificar que el Engine sigue denegando
  // correctamente a TODOS para esa organización (fail-closed, sin owner
  // fantasma ni bypass accidental).
  {
    const orgNoOwner = await storage.organizations.create({ id: "org-no-owner", name: "Sin Owner" });
    const anyoneCan = await engine.can({ identity: { provider: "e2e", subject: "nobody-in-particular" }, organizationId: orgNoOwner.id, permission: "corrupt.secret" });
    const evenOwnerFromOtherOrgCan = await engine.can({ identity: { provider: "e2e", subject: "owner-corrupt-a" }, organizationId: orgNoOwner.id, permission: "corrupt.secret" });
    note(`3e: organización creada sin owner (vía organizations.create() puro, sin createOrganizationWithOwner). can() para cualquiera=${anyoneCan}, can() para el Owner de OTRA org=${evenOwnerFromOtherOrgCan}`);
    ok("3e: una organización sin owner deniega correctamente a todos — sin owner fantasma ni fallback privilegiado", anyoneCan === false && evenOwnerFromOtherOrgCan === false);
  }

  // 3f — identity_links con un 'to' que NUNCA tuvo membership en ningún
  // lado (alcanzable hoy vía la API real, ya que link() no exige que 'to'
  // tenga membership) — confirmar que resolver esa identidad simplemente
  // no produce ningún acceso, en ninguna organización.
  {
    const ghostAlias = { provider: "legacy", subject: "ghost-alias" };
    const ghostTarget = { provider: "legacy", subject: "ghost-target-never-existed" };
    await storage.identityLinks.link({ from: ghostAlias, to: ghostTarget, actor: { provider: "e2e", subject: "owner-corrupt-a" } });
    const can = await engine.can({ identity: ghostAlias, organizationId: orgA.id, permission: "corrupt.secret" });
    note(`3f: link a un 'to' que nunca tuvo membership. can(ghostAlias)=${can}`);
    ok("3f: un link a una identidad fantasma nunca produce acceso", can === false);
  }
}

// ===========================================================================
// SECCIÓN 4 — CASCADE ANALYSIS: verificar el comportamiento documentado de
// cada FK con on delete cascade, incluyendo la ruta de Organization
// (inalcanzable hoy vía API pública — no existe OrganizationRepository.delete
// — probada solo vía SQL directo, documentada como análisis prospectivo).
// ===========================================================================
section("SECCIÓN 4 — Cascade analysis: ¿el borrado de una organización (solo alcanzable vía SQL, no hay API pública) deja algo huérfano y explotable?");
{
  const storage = createPostgresStorage(pool);
  const org = await makeOrg(storage, "cascade-test");
  await storage.permissions.register({ key: "cascade.action" });
  const role = await storage.roles.create({ id: "role-cascade", organizationId: org.id, name: "CascadeRole", permissionKeys: ["cascade.action"] });
  const member = await storage.memberships.create({ id: "m-cascade", organizationId: org.id, identity: { provider: "e2e", subject: "cascade-user" }, roleIds: [role.id] });
  await storage.auditLogs.record({ id: "audit-cascade-1", actor: { provider: "e2e", subject: "cascade-user" }, action: "test.action", organizationId: org.id });

  let auditBlocked = false;
  try {
    await pool.query(`delete from uniora.organizations where id = $1`, [org.id]);
  } catch (error) {
    auditBlocked = true;
    note(`Borrar la organización (vía SQL directo — sin API pública) fue rechazado por Postgres: ${error.message}`);
  }
  ok("El audit log real (FK sin cascade a propósito) BLOQUEA el borrado de una organización con historial — documentado como intencional, no un hallazgo", auditBlocked);

  // Repetir sin audit logs de por medio, para confirmar que las DEMÁS
  // tablas sí cascadean correctamente como está documentado.
  const org2 = await makeOrg(storage, "cascade-test-2");
  const role2 = await storage.roles.create({ id: "role-cascade-2", organizationId: org2.id, name: "CascadeRole2" });
  const member2 = await storage.memberships.create({ id: "m-cascade-2", organizationId: org2.id, identity: { provider: "e2e", subject: "cascade-user-2" }, roleIds: [role2.id] });
  await pool.query(`delete from uniora.organizations where id = $1`, [org2.id]);
  const roleGone = (await pool.query(`select 1 from uniora.roles where id=$1`, [role2.id])).rowCount === 0;
  const memberGone = (await pool.query(`select 1 from uniora.memberships where id=$1`, [member2.id])).rowCount === 0;
  const membershipRoleGone = (await pool.query(`select 1 from uniora.membership_roles where membership_id=$1`, [member2.id])).rowCount === 0;
  note(`Tras borrar org2 (sin audit logs): role sobrevive=${!roleGone}, membership sobrevive=${!memberGone}, membership_roles sobrevive=${!membershipRoleGone}`);
  ok("El cascade real limpia roles/memberships/membership_roles de una organización borrada — sin estado huérfano explotable", roleGone && memberGone && membershipRoleGone);
}

// ===========================================================================
// SECCIÓN 5 — ID REUSE sistematizado: membership.id reciclado en OTRA
// organización/identidad — ¿el fix genérico de la Ronda 8 (correlacionado,
// sin valores capturados) también cierra esto para membershipId, no solo
// roleId?
// ===========================================================================
section("SECCIÓN 5 — ID reuse: membership.id reciclado mientras assignRole() está en vuelo");
{
  const storage = createPostgresStorage(pool);
  const orgA = await makeOrg(storage, "idreuse-a");
  const orgB = await makeOrg(storage, "idreuse-b");
  const roleA = await storage.roles.create({ id: "role-idreuse-a", organizationId: orgA.id, name: "RoleA" });
  await storage.memberships.create({ id: "m-idreuse-shared", organizationId: orgA.id, identity: { provider: "e2e", subject: "idreuse-user-a" } });

  const client = await pool.connect();
  // Simula: assignRole ya resolvió is_owner_role=false para roleA (irrelevante
  // aquí, lo importante es el membershipId reciclado) — captura nada sobre
  // el membership, así que el fix de Ronda 8 (correlacionado contra
  // uniora.memberships FRESCO, no un valor capturado) debe protegerlo
  // igual sin cambios adicionales.
  await pool.query(`delete from uniora.memberships where id = $1`, ["m-idreuse-shared"]);
  await storage.memberships.create({ id: "m-idreuse-shared", organizationId: orgB.id, identity: { provider: "e2e", subject: "idreuse-user-b" } });
  client.release();

  let rejected = false;
  try {
    await storage.memberships.assignRole("m-idreuse-shared", roleA.id);
  } catch {
    rejected = true;
  }
  note(`assignRole(membershipId reciclado ahora en orgB, roleA de orgA) → ${rejected ? "rechazado" : "ACEPTADO"}`);
  ok("El guard correlacionado de la Ronda 8 protege también contra membership.id reciclado en otra organización, sin cambios adicionales", rejected);
}

// ===========================================================================
// RESUMEN
// ===========================================================================
section("RESUMEN RONDA 9");
console.log(`PASS=${PASS}  FAIL=${FAIL}`);
if (findings.length > 0) {
  console.log("\nHallazgos candidatos:");
  for (const f of findings) console.log(`  - ${f.label}${f.detail ? ": " + f.detail : ""}`);
}

await pool.end();
process.exit(FAIL > 0 ? 1 : 0);
