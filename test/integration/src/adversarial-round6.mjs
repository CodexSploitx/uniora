// PENTEST — Ronda 6: campaña autónoma. Fuzzer dirigido con generación de
// secuencias aleatorias (semilla determinística, reproducible), state-space
// exploration, differential testing memoria-vs-Postgres como oráculo, y
// verificación de invariantes DESPUÉS DE CADA ACCIÓN (no solo al final).
// TEMPORAL, no se commitea. Base aislada: uniora_pentest.
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

// --- PRNG determinístico (mulberry32) — reproducible con la misma semilla ---
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

// ---------------------------------------------------------------------------
// ENGINE A — STATE MODEL: 2 organizaciones, 6 identidades (algunas
// compartidas entre orgs), catálogo global de 6 permisos y 4 features.
// ---------------------------------------------------------------------------
async function buildWorld(storage) {
  const orgA = await createOrganizationWithOwner(storage, {
    organizationId: "org-a", organizationName: "FuzzOrgA",
    ownerRoleId: "role-owner-a", membershipId: "m-owner-a",
    ownerIdentity: { provider: "e2e", subject: "identity-1" },
  });
  const orgB = await createOrganizationWithOwner(storage, {
    organizationId: "org-b", organizationName: "FuzzOrgB",
    ownerRoleId: "role-owner-b", membershipId: "m-owner-b",
    ownerIdentity: { provider: "e2e", subject: "identity-2" },
  });
  const PERMS = ["fuzz.a", "fuzz.b", "fuzz.c", "fuzz.d", "fuzz.e", "fuzz.f"];
  for (const p of PERMS) await storage.permissions.register({ key: p });
  const FEATURES = ["feat_a", "feat_b", "feat_c", "feat_d"];
  for (const f of FEATURES) await storage.features.register({ name: f, key: f });
  const IDENTITIES = ["identity-1", "identity-2", "identity-3", "identity-4", "identity-5", "identity-6"];

  return {
    orgs: [orgA.organization.id, orgB.organization.id],
    ownerRoles: { [orgA.organization.id]: orgA.ownerRole.id, [orgB.organization.id]: orgB.ownerRole.id },
    identities: IDENTITIES,
    perms: PERMS,
    features: FEATURES,
    // Tracking mutable, mantenido en paralelo al storage real (nunca se
    // confía ciegamente — se re-consulta el storage real para verificar,
    // esto solo ayuda a elegir targets válidos para las próximas acciones).
    roles: { [orgA.organization.id]: [orgA.ownerRole.id], [orgB.organization.id]: [orgB.ownerRole.id] },
    memberships: { [orgA.organization.id]: ["m-owner-a"], [orgB.organization.id]: ["m-owner-b"] },
    nextId: 0,
  };
}

// ---------------------------------------------------------------------------
// ENGINE B — ACTION MODEL: cada acción es (nombre, fn(storage, world, rng)).
// fn devuelve { applied: boolean } — no lanza: los rechazos esperados
// (validación de dominio) se tratan como "no aplicado", nunca como un
// crash del fuzzer.
// ---------------------------------------------------------------------------
const ACTIONS = [
  async function createRole(storage, world, rng) {
    const org = pick(rng, world.orgs);
    const id = `role-fz-${world.nextId++}`;
    try {
      await storage.roles.create({ id, organizationId: org, name: `Role ${id}`, permissionKeys: [] });
      world.roles[org].push(id);
      return { applied: true };
    } catch {
      return { applied: false };
    }
  },
  async function deleteRole(storage, world, rng) {
    const org = pick(rng, world.orgs);
    const candidates = world.roles[org].filter((r) => r !== world.ownerRoles[org]);
    if (candidates.length === 0) return { applied: false };
    const roleId = pick(rng, candidates);
    try {
      await storage.roles.delete(roleId);
      world.roles[org] = world.roles[org].filter((r) => r !== roleId);
      return { applied: true };
    } catch {
      return { applied: false };
    }
  },
  async function renameRole(storage, world, rng) {
    const org = pick(rng, world.orgs);
    const candidates = world.roles[org].filter((r) => r !== world.ownerRoles[org]);
    if (candidates.length === 0) return { applied: false };
    const roleId = pick(rng, candidates);
    try {
      await storage.roles.rename(roleId, `Renamed-${world.nextId++}`);
      return { applied: true };
    } catch {
      return { applied: false };
    }
  },
  async function grantPermission(storage, world, rng) {
    const org = pick(rng, world.orgs);
    const candidates = world.roles[org].filter((r) => r !== world.ownerRoles[org]);
    if (candidates.length === 0) return { applied: false };
    const roleId = pick(rng, candidates);
    const perm = pick(rng, world.perms);
    try {
      await storage.roles.grantPermission(roleId, perm);
      return { applied: true };
    } catch {
      return { applied: false };
    }
  },
  async function revokePermission(storage, world, rng) {
    const org = pick(rng, world.orgs);
    const candidates = world.roles[org].filter((r) => r !== world.ownerRoles[org]);
    if (candidates.length === 0) return { applied: false };
    const roleId = pick(rng, candidates);
    const perm = pick(rng, world.perms);
    try {
      await storage.roles.revokePermission(roleId, perm);
      return { applied: true };
    } catch {
      return { applied: false };
    }
  },
  async function createMembership(storage, world, rng) {
    const org = pick(rng, world.orgs);
    const identity = { provider: "e2e", subject: pick(rng, world.identities) };
    const id = `m-fz-${world.nextId++}`;
    try {
      await storage.memberships.create({ id, organizationId: org, identity });
      world.memberships[org].push(id);
      return { applied: true };
    } catch {
      return { applied: false };
    }
  },
  async function deleteMembership(storage, world, rng) {
    const org = pick(rng, world.orgs);
    if (world.memberships[org].length === 0) return { applied: false };
    const membershipId = pick(rng, world.memberships[org]);
    try {
      await storage.memberships.delete(membershipId);
      world.memberships[org] = world.memberships[org].filter((m) => m !== membershipId);
      return { applied: true };
    } catch {
      return { applied: false };
    }
  },
  async function assignRole(storage, world, rng) {
    const org = pick(rng, world.orgs);
    if (world.memberships[org].length === 0) return { applied: false };
    const membershipId = pick(rng, world.memberships[org]);
    // Deliberadamente incluye el Owner role de VECES en veces como
    // candidato, y ocasionalmente un roleId de la OTRA organización —
    // ambos deben rechazarse (ver INV checks).
    const crossOrg = world.orgs.find((o) => o !== org);
    const pool = rng() < 0.15 ? world.roles[crossOrg] : world.roles[org];
    if (!pool || pool.length === 0) return { applied: false };
    const roleId = pick(rng, pool);
    try {
      await storage.memberships.assignRole(membershipId, roleId);
      return { applied: true };
    } catch {
      return { applied: false };
    }
  },
  async function unassignRole(storage, world, rng) {
    const org = pick(rng, world.orgs);
    if (world.memberships[org].length === 0) return { applied: false };
    const membershipId = pick(rng, world.memberships[org]);
    if (world.roles[org].length === 0) return { applied: false };
    const roleId = pick(rng, world.roles[org]);
    try {
      await storage.memberships.unassignRole(membershipId, roleId);
      return { applied: true };
    } catch {
      return { applied: false };
    }
  },
  async function assignOwnerRole(storage, world, rng) {
    const org = pick(rng, world.orgs);
    if (world.memberships[org].length === 0) return { applied: false };
    const membershipId = pick(rng, world.memberships[org]);
    try {
      await storage.memberships.assignOwnerRole(membershipId, world.ownerRoles[org]);
      return { applied: true };
    } catch {
      return { applied: false };
    }
  },
  async function unassignOwnerRole(storage, world, rng) {
    const org = pick(rng, world.orgs);
    if (world.memberships[org].length === 0) return { applied: false };
    const membershipId = pick(rng, world.memberships[org]);
    try {
      await storage.memberships.unassignOwnerRole(membershipId, world.ownerRoles[org]);
      return { applied: true };
    } catch {
      return { applied: false };
    }
  },
  async function enableFeature(storage, world, rng) {
    const org = pick(rng, world.orgs);
    const feat = pick(rng, world.features);
    try {
      await storage.features.enable(org, feat);
      return { applied: true };
    } catch {
      return { applied: false };
    }
  },
  async function disableFeature(storage, world, rng) {
    const org = pick(rng, world.orgs);
    const feat = pick(rng, world.features);
    try {
      await storage.features.disable(org, feat);
      return { applied: true };
    } catch {
      return { applied: false };
    }
  },
  async function linkIdentity(storage, world, rng) {
    const from = { provider: "e2e-alias", subject: `alias-${world.nextId++}` };
    const to = { provider: "e2e", subject: pick(rng, world.identities) };
    try {
      await storage.identityLinks.link({ from, to, actor: to });
      return { applied: true };
    } catch {
      return { applied: false };
    }
  },
];

// ---------------------------------------------------------------------------
// ENGINE D — PROPERTY CHECKING: invariantes verificados tras CADA acción.
// ---------------------------------------------------------------------------
async function checkInvariants(storage, engine, world, label, seed, step) {
  const violations = [];

  // INV-A: toda organización que llegó a tener un Owner sigue teniendo ≥1.
  for (const org of world.orgs) {
    const count = (await storage.memberships.countByRole([world.ownerRoles[org]]))[world.ownerRoles[org]];
    if (count === 0) violations.push(`INV-A (0 Owners en ${org})`);
  }

  // INV-B/INV-C: ninguna identidad está autorizada en una organización de
  // la que no es miembro real, para NINGÚN permission/feature del catálogo
  // (cross-org leak).
  for (const identitySubject of world.identities) {
    const identity = { provider: "e2e", subject: identitySubject };
    for (const org of world.orgs) {
      const membership = await storage.memberships.findByIdentity(org, identity);
      if (membership) continue; // es miembro real: cualquier resultado es válido, no se verifica aquí
      for (const perm of world.perms) {
        const allowed = await engine.can({ identity, organizationId: org, permission: perm });
        if (allowed) violations.push(`INV-C (${identitySubject} sin membership en ${org} autorizado para ${perm})`);
      }
      for (const feat of world.features) {
        const allowed = await engine.access.check({ identity, organizationId: org, feature: feat });
        if (allowed) violations.push(`INV-C-feature (${identitySubject} sin membership en ${org} autorizado para feature ${feat})`);
      }
    }
  }

  if (violations.length > 0) {
    console.log(`\n  !!INVARIANTE ROTO!! [${label}] semilla=${seed} paso=${step}:`);
    for (const v of violations) console.log(`    - ${v}`);
  }
  return violations;
}

// ---------------------------------------------------------------------------
// EJECUCIÓN: N secuencias aleatorias de profundidad D, aplicadas EN
// PARALELO a memoria y Postgres (mismo seed, misma acción elegida cada
// vez — differential testing como oráculo), verificando invariantes tras
// cada paso en AMBOS storages.
// ---------------------------------------------------------------------------
section("ENGINE A+B+C+D — fuzzing dirigido: secuencias aleatorias, invariantes tras cada paso, memoria vs Postgres");

const SEEDS = 120;
const DEPTH = 35;
let totalSteps = 0;
let divergences = 0;
const brokenSeeds = [];

for (let seedIndex = 0; seedIndex < SEEDS; seedIndex++) {
  const seed = 1000 + seedIndex;
  const rng = mulberry32(seed);

  await pool.query("drop schema if exists uniora cascade");
  await applyMigrations(pool);
  const pgStorage = createPostgresStorage(pool);
  const pgEngine = createAuthorizationEngine(pgStorage);
  const memStorage = createMemoryStorage();
  const memEngine = createAuthorizationEngine(memStorage);

  const worldPg = await buildWorld(pgStorage);
  const worldMem = await buildWorld(memStorage);

  let seedBroken = false;
  for (let step = 0; step < DEPTH; step++) {
    totalSteps++;
    const actionIndex = Math.floor(rng() * ACTIONS.length);
    // IMPORTANTE: clonamos el estado del rng ANTES de que cada storage lo
    // consuma de forma potencialmente distinta (algunas acciones consumen
    // una cantidad variable de rng() según ramas) — para que ambos
    // storages reciban EXACTAMENTE la misma elección de actor/org/target,
    // usamos un rng clonado con el mismo estado para cada lado.
    const rngStatePg = mulberry32(seed + step * 7919 + 1); // determinístico por (seed, step)
    const rngStateMem = mulberry32(seed + step * 7919 + 1); // idéntico al de pg

    const action = ACTIONS[actionIndex];
    const resultPg = await action(pgStorage, worldPg, rngStatePg).catch((e) => ({ applied: false, crashed: true, error: e }));
    const resultMem = await action(memStorage, worldMem, rngStateMem).catch((e) => ({ applied: false, crashed: true, error: e }));

    if (resultPg.crashed || resultMem.crashed) {
      ok(
        `[seed=${seed} step=${step}] acción "${action.name}" no debe lanzar una excepción no controlada`,
        false,
        `pg_crashed=${!!resultPg.crashed} mem_crashed=${!!resultMem.crashed}`,
      );
      seedBroken = true;
    }

    // DIFFERENTIAL: la misma acción, con el mismo rng, debe tener el MISMO
    // resultado applied/rejected en ambos adapters — una divergencia
    // significa que uno de los dos valida algo que el otro no (adapter
    // differential, prioridad alta según el prompt).
    if (resultPg.applied !== resultMem.applied) {
      divergences++;
      console.log(
        `  [DIVERGENCIA] seed=${seed} step=${step} acción="${action.name}": pg.applied=${resultPg.applied} mem.applied=${resultMem.applied}`,
      );
    }

    const violationsPg = await checkInvariants(pgStorage, pgEngine, worldPg, "postgres", seed, step);
    const violationsMem = await checkInvariants(memStorage, memEngine, worldMem, "memory", seed, step);
    if (violationsPg.length > 0 || violationsMem.length > 0) {
      seedBroken = true;
      brokenSeeds.push({ seed, step, action: action.name, violationsPg, violationsMem });
    }
  }
  if (seedBroken) console.log(`  seed ${seed}: ROTO (ver detalle arriba)`);
}

ok(`${SEEDS} secuencias × ${DEPTH} pasos (${totalSteps} acciones totales) sin ningún invariante roto`, brokenSeeds.length === 0, `secuencias rotas=${brokenSeeds.length}`);
ok(`memoria y Postgres coinciden en applied/rejected para cada acción (adapter parity bajo fuzzing)`, divergences === 0, `divergencias=${divergences}`);

console.log(`\nCobertura: ${SEEDS} semillas × ${DEPTH} pasos = ${totalSteps} acciones ejecutadas en paralelo sobre 2 adapters (${totalSteps * 2} llamadas de acción reales), ${ACTIONS.length} tipos de acción distintos, 2 organizaciones, 6 identidades, 6 permission keys, 4 feature keys por semilla.`);

section("RESUMEN RONDA 6 (Engine A-D: fuzzing dirigido)");
console.log(`PASS=${PASS}  FAIL=${FAIL}`);
if (findings.length > 0) {
  console.log("\nHallazgos:");
  for (const f of findings) console.log(`  - ${f.label} ${f.detail}`);
}

await pool.end();
