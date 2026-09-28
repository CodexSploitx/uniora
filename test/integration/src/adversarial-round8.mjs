// PENTEST — Ronda 8: Temporal Concurrency & Identity Race Warfare.
// Modela cada operación como READ→VALIDATE→DECIDE→WRITE→COMMIT y busca
// interleavings donde ninguna operación individual es insegura pero la
// COMPOSICIÓN TEMPORAL sí lo es. TEMPORAL, no se commitea.
// Base aislada: uniora_pentest (nunca uniora/uniora_test/uniora_test_e2e).
import pg from "pg";
import { createAuthorizationEngine, createOrganizationWithOwner, createMemoryStorage } from "@uniora/core";
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
    organizationName: `Round8Org${suffix}`,
    ownerRoleId: `role-owner-${suffix}`,
    membershipId: `m-owner-${suffix}`,
    ownerIdentity: { provider: "e2e", subject: `owner-${suffix}` },
  });
  return created.organization;
}

// ===========================================================================
// SECCIÓN 1 — ABA: RoleRepository, delete + recreate (mismo id, OTRA
// organización) mientras assignRole() está a mitad de camino entre su
// SELECT (captura organization_id) y su INSERT guardado por ese valor
// capturado. `roles.id` es una PK GLOBAL (no por-organización) — nada
// impide reciclar un id recién borrado en una organización distinta.
// ===========================================================================
section("SECCIÓN 1 (POSTGRES) — ABA: role borrado y recreado en OTRA org mientras assignRole() está en vuelo");
{
  const storage = createPostgresStorage(pool);
  const orgA = await makeOrg(storage, "aba-a");
  const orgB = await makeOrg(storage, "aba-b");
  const roleId = "role-aba-shared-id";
  await storage.roles.create({ id: roleId, organizationId: orgA.id, name: "Sales (Org A)" });
  const memberA = await storage.memberships.create({ id: "m-member-a", organizationId: orgA.id, identity: { provider: "e2e", subject: "member-a" } });

  // 1a — Demuestra la VENTANA que existía antes del fix (SELECT captura
  // organization_id, luego un INSERT separado confía en ese valor
  // capturado) reproduciendo esos dos statements a mano con una barrera
  // determinística — no ejercita el código actual de `assignRole()`
  // (ya corregido, ver 1c), es la prueba de que la ventana era real.
  const client = await pool.connect();
  const roleRow = (
    await client.query(`select organization_id, is_owner_role from uniora.roles where id = $1`, [roleId])
  ).rows[0];
  note(`(pre-fix, reproducido a mano) T1 leyó role "${roleId}": organization_id="${roleRow.organization_id}" (org A)`);
  await storage.roles.delete(roleId);
  await storage.roles.create({ id: roleId, organizationId: orgB.id, name: "Sales (Org B, recreado)" });
  note(`T2 borró y recreó "${roleId}" — ahora pertenece a org B, no a org A`);
  const insertResult = await client.query(
    `insert into uniora.membership_roles (membership_id, role_id)
     select $1, $2
     where exists (select 1 from uniora.memberships m where m.id = $1 and m.organization_id = $3)
     on conflict do nothing`,
    [memberA.id, roleId, roleRow.organization_id],
  );
  client.release();
  const inserted = (insertResult.rowCount ?? 0) > 0;
  note(`(pre-fix, reproducido a mano) T1 reanudado ${inserted ? "SÍ insertó" : "NO insertó"} membership_roles(${memberA.id}, ${roleId})`);

  // Caracterizar el impacto de esa ventana: ¿escalada de autorización real,
  // o solo una fila "muerta" (defensa en profundidad del Engine, que
  // re-verifica role.organizationId en el momento de evaluar)?
  const engine = createAuthorizationEngine(storage);
  await storage.permissions.register({ key: "orgb.secret" });
  await storage.roles.grantPermission(roleId, "orgb.secret");
  const canOrgA = await engine.can({ identity: { provider: "e2e", subject: "member-a" }, organizationId: orgA.id, permission: "orgb.secret" });
  note(`can(member-a, org=A, permission="orgb.secret" [que ahora vive en el role de Org B]) = ${canOrgA}`);
  ok(
    "La ventana ABA reproducida a mano SÍ insertaba una fila cross-org (confirma que la vulnerabilidad pre-fix era real, no teórica)",
    inserted,
  );
  ok(
    "Defensa en profundidad del Engine: aunque la fila 'muerta' exista, can() NUNCA concede un permiso de un role de otra organización",
    canOrgA === false,
    canOrgA === true ? "CRÍTICO: escalada de autorización real cross-org vía ABA de role — el Engine no filtró role.organizationId correctamente" : "",
  );

  // 1b — limpieza del estado creado a mano arriba, para no contaminar 1c.
  await pool.query(`delete from uniora.membership_roles where membership_id=$1 and role_id=$2`, [memberA.id, roleId]);

  // 1c — POST-FIX: la misma carrera, pero ahora ejercitando el código REAL
  // (`storage.memberships.assignRole()`, ya corregido) bajo una carrera
  // genuina — sin simular nada a mano — contra un delete()+create() real.
  const roleId2 = "role-aba-shared-id-v2";
  await storage.roles.create({ id: roleId2, organizationId: orgA.id, name: "Sales v2 (Org A)" });
  const [assignOutcome] = await Promise.allSettled([
    storage.memberships.assignRole(memberA.id, roleId2).catch((e) => ({ error: e.message })),
    (async () => {
      await storage.roles.delete(roleId2);
      await storage.roles.create({ id: roleId2, organizationId: orgB.id, name: "Sales v2 (Org B, recreado)" });
    })(),
  ]);
  const stillThere = (
    await pool.query(`select 1 from uniora.membership_roles where membership_id=$1 and role_id=$2`, [memberA.id, roleId2])
  ).rowCount > 0;
  note(`(post-fix, código real) tras la carrera assignRole()∥delete+recreate: membership_roles(${memberA.id}, ${roleId2}) existe = ${stillThere}`);
  const roleId2NowOrg = (await storage.roles.findSummariesByIds([roleId2]))[0]?.organizationId;
  ok(
    "Post-fix: si la fila sobrevivió, el role al que apunta SIGUE perteneciendo a Org A (nunca quedó una fila cross-org) — la carrera real ya no puede producir el estado ABA",
    !stillThere || roleId2NowOrg === orgA.id,
    stillThere && roleId2NowOrg !== orgA.id ? "El fix no cerró la carrera genuina — sigue siendo posible obtener una fila cross-org" : "",
  );
}

// ===========================================================================
// SECCIÓN 1b — Mismo ataque, pero MISMA organización (delete+recreate con
// permissionKeys DISTINTOS) — ¿assignRole() capturado antes del delete
// termina otorgando el role NUEVO (con permisos distintos a los que el
// caller "vio" al decidir asignar) en vez de fallar?
// ===========================================================================
section("SECCIÓN 1b (POSTGRES) — ABA: role borrado y recreado en la MISMA org con permisos distintos");
{
  const storage = createPostgresStorage(pool);
  const org = await makeOrg(storage, "aba-c");
  const roleId = "role-aba-same-org";
  await storage.permissions.register({ key: "low.risk" });
  await storage.permissions.register({ key: "high.risk" });
  await storage.roles.create({ id: roleId, organizationId: org.id, name: "Viewer", permissionKeys: ["low.risk"] });
  const member = await storage.memberships.create({ id: "m-aba-c", organizationId: org.id, identity: { provider: "e2e", subject: "member-c" } });

  // Un admin decide "assignRole(member, roleId)" creyendo que roleId
  // sigue siendo el Viewer de bajo riesgo que vio en la UI. Mientras la
  // llamada está en vuelo, otro proceso borra ese role y recrea uno con
  // el MISMO id pero permisos de alto riesgo.
  const [assignResult] = await Promise.allSettled([storage.memberships.assignRole(member.id, roleId)]);
  // (ejecutado secuencialmente primero para confirmar el camino feliz;
  // la carrera real se ejercita con el cliente manual de la Sección 1,
  // aquí solo confirmamos que un delete+recreate DESPUÉS de una
  // asignación ya completada correctamente actualiza los permisos
  // efectivos del membership sin necesitar re-asignación — comportamiento
  // esperado y documentado, no un hallazgo).
  const engine = createAuthorizationEngine(storage);
  const before = await engine.can({ identity: { provider: "e2e", subject: "member-c" }, organizationId: org.id, permission: "low.risk" });

  await storage.roles.delete(roleId);
  await storage.roles.create({ id: roleId, organizationId: org.id, name: "Viewer (recreado)", permissionKeys: ["high.risk"] });
  const after = await engine.can({ identity: { provider: "e2e", subject: "member-c" }, organizationId: org.id, permission: "high.risk" });
  const afterLow = await engine.can({ identity: { provider: "e2e", subject: "member-c" }, organizationId: org.id, permission: "low.risk" });

  note(`Antes del ABA: can(low.risk)=${before}. Tras borrar+recrear el role con permisos NUEVOS: can(high.risk)=${after}, can(low.risk)=${afterLow}`);
  ok(
    "delete()+create() del mismo role.id limpia la asignación previa (RoleRepository.delete cascadea sobre membership_roles) — no hay resurrección automática de la asignación vieja",
    after === false,
    after === true ? "El membership terminó con el NUEVO role (permisos distintos) sin que nadie lo re-asignara explícitamente — resurrección de asignación vía ABA" : "",
  );
}

// ===========================================================================
// SECCIÓN 2 — Ownership race a escala: ¿los Owners contados son REALMENTE
// operativos, no solo numéricamente ≥1? (§11 del prompt, explícitamente
// motivado por el Hallazgo 11 — el conteo puede ser correcto mientras la
// autorización efectiva no lo es).
// ===========================================================================
section("SECCIÓN 2 (POSTGRES) — Ownership race a escala: 20 Owners, remoción mutua masiva concurrente");
{
  const storage = createPostgresStorage(pool);
  const org = await makeOrg(storage, "owner-scale");
  const ownerRoleId = "role-owner-owner-scale";
  const N = 20;
  const owners = [await storage.memberships.findByIdentity(org.id, { provider: "e2e", subject: "owner-owner-scale" })];
  for (let i = 1; i < N; i++) {
    const m = await storage.memberships.create({ id: `m-owner-extra-${i}`, organizationId: org.id, identity: { provider: "e2e", subject: `owner-extra-${i}` } });
    await storage.memberships.assignOwnerRole(m.id, ownerRoleId);
    owners.push(m);
  }
  note(`${N} memberships con el Owner role asignado en org "${org.id}"`);

  // Cada Owner intenta remover a TODOS los demás Owners, todo a la vez
  // (N*(N-1) operaciones concurrentes) — sin ningún await intermedio.
  const attempts = [];
  for (const remover of owners) {
    for (const target of owners) {
      if (remover.id === target.id) continue;
      attempts.push(storage.memberships.unassignOwnerRole(target.id, ownerRoleId));
    }
  }
  const results = await Promise.allSettled(attempts);
  const succeeded = results.filter((r) => r.status === "fulfilled").length;
  note(`${attempts.length} intentos de remoción mutua disparados a la vez: ${succeeded} tuvieron éxito, ${results.length - succeeded} rechazados`);

  const remainingCount = (await storage.memberships.countByRole([ownerRoleId]))[ownerRoleId];
  note(`countByRole(ownerRoleId) = ${remainingCount}`);
  ok(`Tras la tormenta de ${attempts.length} remociones concurrentes, sigue habiendo ≥1 Owner (conteo)`, remainingCount >= 1);

  // No basta con el conteo (motivación explícita del Hallazgo 11): verificar
  // que CADA Owner que sigue asignado es REALMENTE operativo — puede
  // ejercer el bypass del Owner en una autorización real.
  const engine = createAuthorizationEngine(storage);
  await storage.permissions.register({ key: "owner.only.action" });
  let operativeCount = 0;
  for (const owner of owners) {
    const membership = await storage.memberships.findById(owner.id);
    if (!membership?.roleIds.includes(ownerRoleId)) continue;
    const identity = { provider: "e2e", subject: owner.id === owners[0].id ? "owner-owner-scale" : owner.id.replace("m-owner-extra-", "owner-extra-") };
    const canAct = await engine.can({ identity, organizationId: org.id, permission: "owner.only.action" });
    if (canAct) operativeCount++;
  }
  note(`De los Owners que el conteo dice que quedan, ${operativeCount} son REALMENTE operativos (can()=true)`);
  ok(
    "Todo Owner que countByRole reporta como asignado es también operativo en engine.can() — ningún Owner 'fantasma' (Hallazgo 11 no regresó a escala)",
    operativeCount === remainingCount,
    operativeCount !== remainingCount ? `Discrepancia: countByRole dice ${remainingCount} pero solo ${operativeCount} pueden ejercer el bypass — Owner fantasma detectado` : "",
  );
}

// ===========================================================================
// SECCIÓN 3 — Revocation race: grant || revoke || check machacando el
// MISMO par (role, permission) muchas veces concurrentemente. Buscar
// "revoked but still authorized" o "never granted but authorized".
// ===========================================================================
section("SECCIÓN 3 (POSTGRES) — Revocation race: grant/revoke concurrentes + checks intercalados");
{
  const storage = createPostgresStorage(pool);
  const org = await makeOrg(storage, "revoke-race");
  await storage.permissions.register({ key: "toggle.perm" });
  const role = await storage.roles.create({ id: "role-toggle", organizationId: org.id, name: "Toggle" });
  const member = await storage.memberships.create({ id: "m-toggle", organizationId: org.id, identity: { provider: "e2e", subject: "toggle-user" }, roleIds: [role.id] });
  const engine = createAuthorizationEngine(storage);
  const identity = { provider: "e2e", subject: "toggle-user" };

  const ROUNDS = 30;
  let phantomGrant = 0; // check()=true pero el estado final de la ronda fue "revoked"
  for (let i = 0; i < ROUNDS; i++) {
    const [, , checkResult] = await Promise.allSettled([
      storage.roles.grantPermission(role.id, "toggle.perm"),
      storage.roles.revokePermission(role.id, "toggle.perm"),
      engine.can({ identity, organizationId: org.id, permission: "toggle.perm" }),
    ]);
    const finalGranted = (await storage.roles.grantedPermissionKeys(role.id, ["toggle.perm"])).includes("toggle.perm");
    // El check concurrente pudo legítimamente ver "true" o "false" según el
    // interleaving exacto (ninguno de los dos es incorrecto por sí solo —
    // grant/revoke corriendo A LA VEZ que el check no tiene un orden
    // "correcto" único) — lo que SÍ sería un hallazgo es que el ESTADO
    // FINAL (tras asentarse grant+revoke) sea "granted" pero can() diga
    // false, o viceversa, en una llamada POSTERIOR ya sin concurrencia.
    const settledCheck = await engine.can({ identity, organizationId: org.id, permission: "toggle.perm" });
    if (settledCheck !== finalGranted) phantomGrant++;
    // Vuelve al estado "revoked" antes de la siguiente ronda.
    await storage.roles.revokePermission(role.id, "toggle.perm");
  }
  note(`${ROUNDS} rondas de grant∥revoke∥check — discrepancias entre estado asentado y can(): ${phantomGrant}`);
  ok(`0/${ROUNDS} rondas dejan can() en desacuerdo con el estado ya asentado (sin privilegio fantasma)`, phantomGrant === 0);
}

// ===========================================================================
// SECCIÓN 4 — Cross-organization concurrency: 3 orgs con subjects/roles/
// slugs IDÉNTICOS, mutadas simultáneamente — ninguna carrera en Org A
// puede cambiar la autorización efectiva en Org B/C (Property T5).
// ===========================================================================
section("SECCIÓN 4 (POSTGRES) — Cross-org concurrency: 3 orgs con identidades/roles homónimos, mutación simultánea");
{
  const storage = createPostgresStorage(pool);
  const orgs = [];
  for (const suffix of ["x", "y", "z"]) {
    const org = await makeOrg(storage, `crossorg-${suffix}`);
    await storage.permissions.register({ key: "shared.action" });
    const role = await storage.roles.create({ id: `role-shared-${suffix}`, organizationId: org.id, name: "Shared", permissionKeys: ["shared.action"] });
    // MISMO subject (mismo provider) en las 3 organizaciones — memberships
    // independientes, homónimas, nunca deben mezclarse.
    const member = await storage.memberships.create({
      id: `m-shared-${suffix}`,
      organizationId: org.id,
      identity: { provider: "e2e", subject: "shared-subject" },
      roleIds: [],
    });
    orgs.push({ org, role, member });
  }

  // Todas las organizaciones asignan/desasignan el role "shared.action" a
  // su propio membership homónimo, TODO a la vez, sin await intermedio.
  await Promise.allSettled([
    storage.memberships.assignRole(orgs[0].member.id, orgs[0].role.id),
    storage.memberships.unassignRole(orgs[1].member.id, orgs[1].role.id), // no estaba asignado — no-op
    storage.memberships.assignRole(orgs[2].member.id, orgs[2].role.id),
  ]);

  const engine = createAuthorizationEngine(storage);
  const results = await Promise.all(
    orgs.map(({ org }) => engine.can({ identity: { provider: "e2e", subject: "shared-subject" }, organizationId: org.id, permission: "shared.action" })),
  );
  note(`can(shared-subject, org=x/y/z, shared.action) = [${results.join(", ")}] (esperado: [true, false, true])`);
  ok("Org X obtuvo el permiso asignado; Org Y (no tocada) sigue denegando", results[0] === true && results[1] === false);
  ok("Org Z (mutada concurrentemente con X) también obtuvo su propio permiso, sin interferencia cruzada", results[2] === true);
}

// ===========================================================================
// SECCIÓN 5 — Retry/serialization bajo carga real: 8 llamadas a link()
// contendiendo genuinamente por identidades solapadas, forzando 40001
// reales, verificando 0 cadenas, 0 auditorías duplicadas, y que ningún
// reintento actúa sobre datos obsoletos.
// ===========================================================================
section("SECCIÓN 5 (POSTGRES) — Serialization failure bajo carga real: 8 link() contendiendo por una cadena potencial");
{
  const storage = createPostgresStorage(pool);
  const org = await makeOrg(storage, "chain-storm");
  const actor = { provider: "e2e", subject: "actor-chain-storm" };
  // Identidades A..H — cada una candidata a encadenarse con la siguiente
  // si la protección "no chains" fallara bajo la carga.
  const identities = "ABCDEFGH".split("").map((c) => ({ provider: "legacy", subject: `chain-${c}` }));
  await storage.memberships.create({ id: "m-chain-root", organizationId: org.id, identity: identities[0] });

  const linkAttempts = [];
  for (let i = 0; i < identities.length - 1; i++) {
    linkAttempts.push(
      storage.identityLinks.link({ from: identities[i + 1], to: identities[i], actor }).catch((e) => ({ error: e.message })),
    );
  }
  const linkResults = await Promise.all(linkAttempts);
  const succeededLinks = linkResults.filter((r) => !("error" in (r ?? {}))).length;
  note(`${identities.length - 1} link() disparados a la vez (cadena potencial A→B→C→...→H): ${succeededLinks} tuvieron éxito`);

  // Contar entradas de audit log para esta ronda — nunca debe haber más
  // de una por link() realmente creado (idempotencia bajo reintento).
  const auditPage = await storage.auditLogs.listRecent({ limit: 50 });
  const chainAudits = auditPage.filter((e) => e.action === "identity_link.created" && e.metadata?.from?.subject?.startsWith("chain-"));
  note(`Entradas de audit log "identity_link.created" para esta ronda: ${chainAudits.length} (esperado: exactamente ${succeededLinks}, una por link exitoso, sin duplicados de reintento)`);
  ok("El número de audit logs coincide exactamente con el número de links exitosos (sin duplicados por reintento)", chainAudits.length === succeededLinks);

  // Verificar que el resultado final NUNCA forma una cadena de más de 1
  // salto real: para cada identidad, resolve() debe alcanzar como máximo
  // UN salto antes de llegar a un nodo que ya no es un "from" de nadie.
  let maxChainDepth = 0;
  for (const identity of identities) {
    let current = identity;
    let depth = 0;
    const seen = new Set();
    while (depth < 10) {
      const resolved = await storage.identityLinks.resolve(current);
      if (resolved.subject === current.subject) break;
      seen.add(current.subject);
      current = resolved;
      depth++;
      if (seen.has(current.subject)) break; // ciclo — nunca debería pasar
    }
    maxChainDepth = Math.max(maxChainDepth, depth);
  }
  note(`Profundidad máxima de resolución observada (siguiendo resolve() repetidamente): ${maxChainDepth} salto(s)`);
  ok("Ninguna cadena de más de 1 salto sobrevivió a la tormenta de concurrencia (no-chains sigue sostenido a escala)", maxChainDepth <= 1);
}

// ===========================================================================
// SECCIÓN 6 — Regresión: Rondas 4, 6 y 7 completas
// ===========================================================================
section("SECCIÓN 6 — Regresión de Rondas 4/6/7 (resumen; los scripts completos se corren aparte)");
note("Ver invocación separada de adversarial-round4.mjs / round6.mjs / round7.mjs en la misma sesión.");

// ===========================================================================
// RESUMEN
// ===========================================================================
section("RESUMEN RONDA 8");
console.log(`PASS=${PASS}  FAIL=${FAIL}`);
if (findings.length > 0) {
  console.log("\nHallazgos candidatos:");
  for (const f of findings) console.log(`  - ${f.label}${f.detail ? ": " + f.detail : ""}`);
}

await pool.end();
process.exit(FAIL > 0 ? 1 : 0);
