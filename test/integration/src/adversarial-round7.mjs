// PENTEST — Ronda 7: Compositional Attack / Security Boundary Collapse.
// Metodología distinta a rondas 1-6: no atacar un componente aislado, sino
// buscar composiciones de operaciones INDIVIDUALMENTE seguras/autorizadas
// que produzcan un estado de seguridad no permitido. TEMPORAL, no se
// commitea. Base aislada: uniora_pentest (nunca uniora/uniora_test/uniora_test_e2e).
import pg from "pg";
import { createAuthorizationEngine, createOrganizationWithOwner, createMemoryStorage, computeAuthorizationSnapshot } from "@uniora/core";
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

async function setupWorld(storage, suffix) {
  const created = await createOrganizationWithOwner(storage, {
    organizationId: `org-${suffix}`,
    organizationName: `Round7Org${suffix}`,
    ownerRoleId: `role-owner-${suffix}`,
    membershipId: `m-owner-${suffix}`,
    ownerIdentity: { provider: "e2e", subject: `owner-${suffix}` },
  });
  const org = created.organization;
  await storage.permissions.register({ key: "sensitive.action" });
  const adminRole = await storage.roles.create({
    id: `role-admin-${suffix}`,
    organizationId: org.id,
    name: "Admin",
    permissionKeys: ["sensitive.action"],
  });
  const viewerRole = await storage.roles.create({
    id: `role-viewer-${suffix}`,
    organizationId: org.id,
    name: "Viewer",
    permissionKeys: [],
  });
  return { org: { organizationId: org.id }, adminRole, viewerRole, ownerIdentity: { provider: "e2e", subject: `owner-${suffix}` } };
}

// ===========================================================================
// SECCIÓN 1 — TRUST BOUNDARY: link()'s anti-hijack guard vs membership.create()
// ===========================================================================
// `IdentityLinkRepository.link()` rechaza expresamente cuando `from` YA tiene
// membership directo, con este mensaje textual:
//   "Cannot link: the 'from' identity already owns a membership directly.
//    Linking it would create an ambiguous/hijackable lookup."
// Esa es una afirmación de invariante: "un identity que es 'from' de un link
// NUNCA debe tener también un membership directo en la MISMA organización
// donde el link resolvería". Pero el invariante SOLO se aplica dentro de
// link(). membership.create() nunca consulta identity_links. Si el orden se
// invierte (link() primero, membership.create() después), el estado que
// link() dice "sería ambiguo/hijackable" se vuelve alcanzable de todos modos
// — vía dos primitivas, cada una individualmente autorizada y correcta por
// sí sola.
async function attackAmbiguousResolution(storage, label, suffix) {
  section(`SECCIÓN 1 (${label}) — Ambiguous resolution vía orden invertido (link → create directo)`);

  const { org, adminRole, viewerRole, ownerIdentity } = await setupWorld(storage, suffix);

  // Y = identidad legítima con membership ALTO privilegio (Admin) en la org.
  const y = { provider: "legacy", subject: `y-${suffix}` };
  const membershipY = await storage.memberships.create({
    id: `m-y-${suffix}`,
    organizationId: org.organizationId,
    identity: y,
    roleIds: [adminRole.id],
  });

  // X = identidad nueva, sin membership propio todavía. link() debe aceptarlo
  // (X no tiene membership directo en NINGUNA org todavía).
  const x = { provider: "new-provider", subject: `x-${suffix}` };
  const link = await storage.identityLinks.link({ from: x, to: y, actor: ownerIdentity });
  ok(`${label}: link(X→Y) aceptado (precondición del ataque)`, link.from.subject === x.subject);

  // Confirmar ANTES del ataque: X (vía el link) hereda el Admin de Y.
  const engine = createAuthorizationEngine(storage);
  const beforeDirect = await engine.can({ identity: x, organizationId: org.organizationId, permission: "sensitive.action" });
  ok(`${label}: X hereda sensitive.action de Y ANTES del membership directo`, beforeDirect === true);

  // Ahora, un admin DISTINTO — sin saber que X ya es un alias de Y (el link
  // vive en una tabla global, sin relación visible desde la vista de una
  // sola organización) — crea un membership DIRECTO para X en la MISMA
  // organización, con Viewer (bajo privilegio): exactamente el estado que
  // link() dice que "sería ambiguo/hijackable" si se construyera al revés.
  // membership.create() no consulta identity_links — nada lo impide.
  let directCreateSucceeded = false;
  let membershipX;
  try {
    membershipX = await storage.memberships.create({
      id: `m-x-${suffix}`,
      organizationId: org.organizationId,
      identity: x,
      roleIds: [viewerRole.id],
    });
    directCreateSucceeded = true;
  } catch (error) {
    note(`membership.create(X) rechazado: ${error.message}`);
  }
  ok(
    `${label}: membership.create(X) directo en la MISMA org que Y NO debería suceder silenciosamente (invariante de link() cruzado)`,
    !directCreateSucceeded,
    directCreateSucceeded ? "el invariante de link() (\"ambiguous/hijackable lookup\") es unidireccional — create() nunca lo revisa" : "",
  );

  if (!directCreateSucceeded) return; // el resto del análisis solo aplica si el estado ambiguo existe

  // El estado ambiguo ahora existe: dos filas de membership resuelven,
  // lógicamente, para la MISMA identidad X en la MISMA organización:
  //   - m-x-<suffix>: identity=X directo, roleIds=[Viewer]  (bajo privilegio)
  //   - m-y-<suffix>: identity=Y, alcanzable desde X vía el link, roleIds=[Admin] (alto privilegio)
  // ¿Cuál gana realmente en la decisión de autorización?
  const afterDirect = await engine.can({ identity: x, organizationId: org.organizationId, permission: "sensitive.action" });
  const resolvedMembership = await storage.memberships.findByIdentity(org.organizationId, x);

  note(`can(X, sensitive.action) tras crear el membership directo (Viewer) = ${afterDirect}`);
  note(`findByIdentity(org, X) resolvió a membership.id = "${resolvedMembership?.id}" (m-x=directo/Viewer, m-y=vía link/Admin)`);

  // El hallazgo real: independientemente de CUÁL fila gane, el sistema
  // ahora tiene DOS fuentes de verdad conflictivas para la misma identidad
  // en la misma organización, y quien mira `findById(m-x-<suffix>)` ve
  // "Viewer" mientras la decisión REAL de can() puede estar usando Admin
  // (vía Y) — o viceversa. Documentamos el comportamiento observado.
  return {
    label,
    suffix,
    x,
    y,
    org: org.organizationId,
    membershipXId: membershipX.id,
    membershipYId: membershipY.id,
    afterDirect,
    resolvedMembershipId: resolvedMembership?.id,
    engine,
  };
}

const memStorage1 = createMemoryStorage();
const resultMem = await attackAmbiguousResolution(memStorage1, "MEMORIA", "mem1");

const pgStorage1 = createPostgresStorage(pool);
const resultPg = await attackAmbiguousResolution(pgStorage1, "POSTGRES", "pg1");

// ---------------------------------------------------------------------------
// 1b — Determinismo: repetir la MISMA consulta muchas veces contra Postgres
// para ver si la fila ganadora es estable o varía (sin ORDER BY explícito
// en `findByIdentity`, el orden de `rows[0]` no está garantizado por SQL).
// ---------------------------------------------------------------------------
if (resultPg) {
  section("SECCIÓN 1b (POSTGRES) — ¿La resolución ambigua es determinística o varía entre llamadas?");
  const seen = new Set();
  for (let i = 0; i < 50; i++) {
    const m = await pgStorage1.memberships.findByIdentity(resultPg.org, resultPg.x);
    seen.add(m?.id);
  }
  note(`50 llamadas repetidas a findByIdentity(org, X) devolvieron membership.id ∈ {${[...seen].join(", ")}}`);
  ok(
    "POSTGRES: la resolución ambigua es al menos ESTABLE dentro de un mismo proceso/conexión (aunque no esté garantizada por SQL)",
    seen.size === 1,
    seen.size > 1 ? "la fila ganadora VARÍA entre llamadas — autorización genuinamente no determinística" : "",
  );

  // Forzar un plan distinto: insertar y borrar filas no relacionadas para
  // perturbar el layout físico/estadísticas, luego re-consultar.
  await pool.query(`insert into uniora.organizations (id, slug, name) values ('noise-org', 'noise-org', 'Noise') on conflict do nothing`);
  for (let i = 0; i < 200; i++) {
    await pool.query(
      `insert into uniora.memberships (id, organization_id, provider, subject) values ($1, 'noise-org', 'noise', $1) on conflict do nothing`,
      [`noise-${i}`],
    );
  }
  await pool.query("analyze uniora.memberships");
  const afterNoise = await pgStorage1.memberships.findByIdentity(resultPg.org, resultPg.x);
  note(`Tras insertar 200 filas de ruido + ANALYZE: findByIdentity(org, X) → "${afterNoise?.id}" (antes: "${resultPg.resolvedMembershipId}")`);
  ok(
    "POSTGRES: la fila ganadora sigue siendo la misma tras perturbar el plan/estadísticas (documentado, no garantizado por el schema)",
    afterNoise?.id === resultPg.resolvedMembershipId,
    afterNoise?.id !== resultPg.resolvedMembershipId ? "LA FILA GANADORA CAMBIÓ tras ANALYZE — confirma que la resolución depende del plan, no de una regla explícita" : "",
  );
}

// ---------------------------------------------------------------------------
// 1c — Caracterizar el IMPACTO exacto de seguridad en cada adapter: ¿la
// identidad X termina con MÁS privilegio del que su propio membership
// directo le otorga (stealth escalation vía el link), o MENOS (su propio
// grant directo queda silenciosamente ignorado)?
// ---------------------------------------------------------------------------
section("SECCIÓN 1c — Caracterización del impacto: ¿escalada silenciosa o denegación silenciosa?");
for (const result of [resultMem, resultPg].filter(Boolean)) {
  if (result.resolvedMembershipId === result.membershipXId) {
    note(`${result.label}: gana el membership DIRECTO de X (Viewer) — el link queda "enmascarado"; can()=${result.afterDirect} (esperado false, Viewer no tiene sensitive.action)`);
    ok(`${result.label}: cuando gana el directo, can() refleja Viewer (no escalada, pero el grant de Owner O queda invisible)`, result.afterDirect === false);
  } else if (result.resolvedMembershipId === result.membershipYId) {
    note(`${result.label}: gana la fila DE Y (vía el link) — X hereda Admin de Y pese a que su PROPIO membership dice Viewer; can()=${result.afterDirect}`);
    ok(
      `${result.label}: ESCALADA SILENCIOSA — X opera con el privilegio de Y (Admin) mientras su propio registro de membership (auditable) dice Viewer`,
      result.afterDirect === false,
      result.afterDirect === true ? "CONFIRMADO: can(X, sensitive.action)=true aunque el membership propio de X (auditable) solo tiene Viewer — stealth privilege via identity link" : "",
    );
  }
}

// ---------------------------------------------------------------------------
// 1d — Variante reversa: X recibe el membership directo de ALTO privilegio
// (Admin), y el link apunta a un Y de BAJO privilegio (Viewer). ¿El grant
// directo de Admin a X queda silenciosamente ANULADO por el link?
// ---------------------------------------------------------------------------
section("SECCIÓN 1d — Variante reversa: grant directo de Admin a X, Y es solo Viewer — ¿se anula silenciosamente?");
async function attackReverseAmbiguous(storage, label, suffix) {
  const { org, adminRole, viewerRole, ownerIdentity } = await setupWorld(storage, suffix);
  const y = { provider: "legacy", subject: `y-${suffix}` };
  await storage.memberships.create({ id: `m-y-${suffix}`, organizationId: org.organizationId, identity: y, roleIds: [viewerRole.id] });
  const x = { provider: "new-provider", subject: `x-${suffix}` };
  await storage.identityLinks.link({ from: x, to: y, actor: ownerIdentity });

  // Un admin DISTINTO otorga Admin a X directamente, creyendo que X es un
  // miembro nuevo e independiente — no sabe que X ya está linkeado.
  let created = false;
  try {
    await storage.memberships.create({ id: `m-x-${suffix}`, organizationId: org.organizationId, identity: x, roleIds: [adminRole.id] });
    created = true;
  } catch {
    // ya reportado en la sección 1 para el caso simétrico
  }
  if (!created) return;

  const engine = createAuthorizationEngine(storage);
  const canAdmin = await engine.can({ identity: x, organizationId: org.organizationId, permission: "sensitive.action" });
  note(`${label}: X tiene membership directo con Admin explícitamente otorgado. can(X, sensitive.action) = ${canAdmin}`);
  ok(
    `${label}: un grant EXPLÍCITO y directo de Admin a X no debería ser silenciosamente ignorado por un link preexistente`,
    canAdmin === true,
    canAdmin === false ? "CONFIRMADO: el Admin recién otorgado A X DIRECTAMENTE es completamente ignorado — can() enruta a Y (Viewer) en su lugar, pese al audit log diciendo \"Admin assigned to X\"" : "",
  );
}
await attackReverseAmbiguous(createMemoryStorage(), "MEMORIA", "mem2");
await attackReverseAmbiguous(createPostgresStorage(pool), "POSTGRES", "pg2");

// ===========================================================================
// SECCIÓN 1e — Snapshot: ¿computeAuthorizationSnapshot hereda el mismo bug?
// (Cobertura, no se espera un hallazgo nuevo — usa engine.can() sin cambios.)
// ===========================================================================
section("SECCIÓN 1e — computeAuthorizationSnapshot() bajo el mismo estado ambiguo (cobertura)");
{
  const storage = createPostgresStorage(pool);
  const { org, adminRole, viewerRole, ownerIdentity } = await setupWorld(storage, "snap1");
  const y = { provider: "legacy", subject: "y-snap1" };
  await storage.memberships.create({ id: "m-y-snap1", organizationId: org.organizationId, identity: y, roleIds: [adminRole.id] });
  const x = { provider: "new-provider", subject: "x-snap1" };
  await storage.identityLinks.link({ from: x, to: y, actor: ownerIdentity });
  let ambiguousStateBuilt = false;
  try {
    await storage.memberships.create({ id: "m-x-snap1", organizationId: org.organizationId, identity: x, roleIds: [viewerRole.id] });
    ambiguousStateBuilt = true;
  } catch (error) {
    note(`(post-fix) membership.create(X) rechazado como se espera: ${error.message}`);
  }
  ok("Post-fix: la sección 1e ya no puede construir el estado ambiguo (regresión de la Sección 1)", !ambiguousStateBuilt);

  const engine = createAuthorizationEngine(storage);
  const snapshot = await computeAuthorizationSnapshot(engine, storage.features, {
    identity: x,
    organizationId: org.organizationId,
    permissions: ["sensitive.action"],
  });
  const directResult = await engine.can({ identity: x, organizationId: org.organizationId, permission: "sensitive.action" });
  note(`Snapshot para X: permissions.sensitive.action = ${snapshot.permissions["sensitive.action"]}; engine.can() directo = ${directResult}`);
  ok(
    "El snapshot es consistente con engine.can() bajo el mismo estado ambiguo (no hay una segunda implementación que diverja)",
    snapshot.permissions["sensitive.action"] === directResult,
  );
}

// ===========================================================================
// SECCIÓN 2 — TOCTOU multicomponente: ¿el estado ambiguo también es
// alcanzable por una CARRERA (link() y membership.create() concurrentes),
// no solo por orden secuencial? Esto además ejercita si la comprobación
// anti-hijack de link() (SELECT sin índice sobre provider+subject SIN
// organization_id) puede fallar en detectar la carrera bajo SERIALIZABLE.
// ===========================================================================
section("SECCIÓN 2 (POSTGRES) — TOCTOU: link(X→Y) y membership.create(X) disparados concurrentemente");
{
  const storage = createPostgresStorage(pool);
  const { org, adminRole, ownerIdentity } = await setupWorld(storage, "race1");
  const y = { provider: "legacy", subject: "y-race1" };
  await storage.memberships.create({ id: "m-y-race1", organizationId: org.organizationId, identity: y, roleIds: [adminRole.id] });
  const x = { provider: "new-provider", subject: "x-race1" };

  const [linkResult, createResult] = await Promise.allSettled([
    storage.identityLinks.link({ from: x, to: y, actor: ownerIdentity }),
    storage.memberships.create({ id: "m-x-race1", organizationId: org.organizationId, identity: x, roleIds: [] }),
  ]);

  note(`link() concurrente: ${linkResult.status}${linkResult.status === "rejected" ? " — " + linkResult.reason.message : ""}`);
  note(`create() concurrente: ${createResult.status}${createResult.status === "rejected" ? " — " + createResult.reason.message : ""}`);

  const bothSucceeded = linkResult.status === "fulfilled" && createResult.status === "fulfilled";
  ok(
    "Bajo concurrencia real, AL MENOS uno de los dos (link o create) debería fallar para evitar el estado ambiguo — o el sistema debe documentar explícitamente que ambos pueden ganar",
    !bothSucceeded,
    bothSucceeded ? "AMBOS tuvieron éxito bajo concurrencia real — la carrera reproduce el mismo estado ambiguo que la Sección 1, ahora vía TOCTOU en vez de orden secuencial" : "",
  );

  // Verificación adicional: repetir la carrera muchas veces para confirmar
  // que el fix (create() ahora lee identity_links, dándole a SERIALIZABLE
  // el ciclo rw que necesitaba para detectar el conflicto) cierra la
  // ventana de forma consistente, no solo "a veces".
  let raceStillAmbiguous = 0;
  const RACE_TRIALS = 25;
  for (let i = 0; i < RACE_TRIALS; i++) {
    const storage2 = createPostgresStorage(pool);
    const suffix = `race-repeat-${i}`;
    const { org: org2, adminRole: adminRole2, ownerIdentity: ownerIdentity2 } = await setupWorld(storage2, suffix);
    const y2 = { provider: "legacy", subject: `y-${suffix}` };
    await storage2.memberships.create({ id: `m-y-${suffix}`, organizationId: org2.organizationId, identity: y2, roleIds: [adminRole2.id] });
    const x2 = { provider: "new-provider", subject: `x-${suffix}` };
    const [l, c] = await Promise.allSettled([
      storage2.identityLinks.link({ from: x2, to: y2, actor: ownerIdentity2 }),
      storage2.memberships.create({ id: `m-x-${suffix}`, organizationId: org2.organizationId, identity: x2, roleIds: [] }),
    ]);
    if (l.status === "fulfilled" && c.status === "fulfilled") raceStillAmbiguous++;
  }
  note(`Repetido ${RACE_TRIALS} veces tras el fix: ${raceStillAmbiguous}/${RACE_TRIALS} carreras dejaron el estado ambiguo`);
  ok(`Post-fix: 0/${RACE_TRIALS} carreras link()∥create() dejan el estado ambiguo`, raceStillAmbiguous === 0);
}

// ===========================================================================
// SECCIÓN 3 — Regresión rápida: ¿siguen intactas las protecciones de
// Ronda 4 (last-owner TOCTOU) y Ronda 6 (adapter parity) bajo esta misma
// sesión, para descartar que el trabajo de esta ronda las haya tocado?
// ===========================================================================
section("SECCIÓN 3 — Regresión rápida: Ronda 4 (last-owner TOCTOU) y Ronda 6 (adapter parity)");
{
  const storage = createPostgresStorage(pool);
  const created = await createOrganizationWithOwner(storage, {
    organizationId: "org-regress4",
    organizationName: "Regress4",
    ownerRoleId: "role-owner-regress4",
    membershipId: "m-owner1-regress4",
    ownerIdentity: { provider: "e2e", subject: "owner1-regress4" },
  });
  const org = created.organization;
  const owner2 = await storage.memberships.create({
    id: "m-owner2-regress4",
    organizationId: org.id,
    identity: { provider: "e2e", subject: "owner2-regress4" },
    roleIds: [],
  });
  await storage.memberships.assignOwnerRole(owner2.id, "role-owner-regress4");

  const [r1, r2] = await Promise.allSettled([
    storage.memberships.unassignOwnerRole("m-owner1-regress4", "role-owner-regress4"),
    storage.memberships.unassignOwnerRole(owner2.id, "role-owner-regress4"),
  ]);
  const remaining = await storage.memberships.countByRole(["role-owner-regress4"]);
  note(`Tras remoción mutua concurrente: role-owner-regress4 count = ${remaining["role-owner-regress4"]}`);
  ok("Ronda 4 (last-owner TOCTOU) sigue protegida: nunca 0 owners tras remoción mutua concurrente", remaining["role-owner-regress4"] >= 1);

  let dup = false;
  try {
    await storage.memberships.create({
      id: "m-dup-regress6",
      organizationId: org.id,
      identity: { provider: "e2e", subject: "owner1-regress4" },
      roleIds: [],
    });
    dup = true;
  } catch {
    // esperado
  }
  ok("Ronda 6 (adapter parity, duplicate identity) sigue protegida en Postgres", !dup);

  const memStorage = createMemoryStorage();
  await createOrganizationWithOwner(memStorage, {
    organizationId: "org-regress6",
    organizationName: "Regress6",
    ownerRoleId: "role-owner-regress6",
    membershipId: "m-owner1-regress6",
    ownerIdentity: { provider: "e2e", subject: "owner1-regress6" },
  });
  let dupMem = false;
  try {
    await memStorage.memberships.create({
      id: "m-dup-regress6-mem",
      organizationId: "org-regress6",
      identity: { provider: "e2e", subject: "owner1-regress6" },
      roleIds: [],
    });
    dupMem = true;
  } catch {
    // esperado
  }
  ok("Ronda 6 (adapter parity, duplicate identity) sigue protegida en Memoria", !dupMem);
}

// ===========================================================================
// RESUMEN
// ===========================================================================
section("RESUMEN RONDA 7 — SECCIÓN 1 (Boundary Collapse: link() vs membership.create())");
console.log(`PASS=${PASS}  FAIL=${FAIL}`);
if (findings.length > 0) {
  console.log("\nHallazgos candidatos:");
  for (const f of findings) console.log(`  - ${f.label}${f.detail ? ": " + f.detail : ""}`);
}

await pool.end();
process.exit(FAIL > 0 ? 1 : 0);
