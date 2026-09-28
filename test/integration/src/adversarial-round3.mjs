// PENTEST — Ronda 3: cadenas de explotación combinando comportamientos
// individualmente seguros. TEMPORAL, no se commitea (script persistente,
// se modifica entre rondas, no se recrea de cero).
import pg from "pg";
import { createOrganizationWithOwner } from "@uniora/core";
import { applyMigrations, createPostgresStorage } from "@uniora/postgres";

const pool = new pg.Pool({ connectionString: "postgresql://postgres:uniora@localhost:55432/uniora_pentest" });
await pool.query("drop schema if exists uniora cascade");
await applyMigrations(pool);
const storage = createPostgresStorage(pool);

console.log("=".repeat(70));
console.log("CADENA 1 — IdentityLink.link() sin auditoría a pesar de exigir 'actor'");
console.log("=".repeat(70));

const { organization: orgA } = await createOrganizationWithOwner(storage, {
  organizationId: "org-a", organizationName: "ORG_A_SECRET",
  ownerRoleId: "role-owner-a", membershipId: "membership-owner-a",
  ownerIdentity: { provider: "supabase", subject: "victim-real-identity" },
});

const before = await storage.auditLogs.listRecent({ limit: 50 });
console.log(`Audit log entries ANTES del link(): ${before.length}`);

await storage.identityLinks.link({
  from: { provider: "attacker-controlled", subject: "attacker-throwaway" },
  to: { provider: "supabase", subject: "victim-real-identity" },
  actor: { provider: "supabase", subject: "victim-real-identity" }, // "mandatory audit trail" según el JSDoc
});

const after = await storage.auditLogs.listRecent({ limit: 50 });
console.log(`Audit log entries DESPUÉS del link(): ${after.length}`);
if (after.length === before.length) {
  console.log("!!VULNERABLE!! link() no dejó NINGUNA entrada de audit log pese a exigir 'actor' para ese propósito.");
} else {
  console.log("[SAFE] — se registró una entrada.");
}

console.log("\n" + "=".repeat(70));
console.log("CADENA 2 — 'no chains' en IdentityLink burlado por orden de construcción");
console.log("=".repeat(70));

const identityA = { provider: "e2e", subject: "attacker-account-A" };
const identityB = { provider: "e2e", subject: "attacker-account-B" };
const identityC = { provider: "e2e", subject: "unrelated-victim-C" };

// Paso 1: A -> B (legítimo en aislamiento: alguien migra de A a B)
await storage.identityLinks.link({ from: identityA, to: identityB, actor: identityB });
console.log("Paso 1 OK: A -> B creado (A es ahora un alias de B).");

// Paso 2: intentar crear B -> C. El chequeo "no chains" solo mira si B es
// un `from` existente (no lo es) y si B tiene membership propio (no lo
// tiene) — NUNCA revisa si B ya es el `to` de otro link.
let chainCreated = false;
try {
  await storage.identityLinks.link({ from: identityB, to: identityC, actor: identityC });
  chainCreated = true;
} catch (e) {
  console.log(`Paso 2 rechazado correctamente: ${e.message}`);
}

if (chainCreated) {
  console.log("!!VULNERABLE!! Se creó una cadena A -> B -> C pese a que el JSDoc dice 'no chains in V1'.");
  const resolvedA = await storage.identityLinks.resolve(identityA);
  const resolvedB = await storage.identityLinks.resolve(identityB);
  console.log(`resolve(A) = ${JSON.stringify(resolvedA)} (solo sigue 1 hop -> B, nunca llega a C)`);
  console.log(`resolve(B) = ${JSON.stringify(resolvedB)} (B ahora resuelve directamente a C)`);
} else {
  console.log("[SAFE] — la cadena fue rechazada.");
}

console.log("\n" + "=".repeat(70));
console.log("CADENA 3 — assignRole() no distinguía 'role cualquiera' de 'role Owner'");
console.log("=".repeat(70));

// Simula exactamente el patrón de host descrito: un actor con el permiso
// genérico "roles.assign" (aquí simplemente invocando el primitivo
// directamente, como lo haría ese host) intenta auto-asignarse el Owner role
// de org-a a través del MISMO método genérico que usaría para asignar
// cualquier role normal.
const attackerMembership = await storage.memberships.create({
  id: "membership-attacker-escalation",
  organizationId: orgA.id,
  identity: { provider: "attacker-controlled", subject: "escalator" },
});

let escalatedViaGenericAssignRole = false;
try {
  await storage.memberships.assignRole(attackerMembership.id, "role-owner-a");
  escalatedViaGenericAssignRole = true;
} catch (e) {
  console.log(`assignRole() genérico rechazado correctamente: ${e.message}`);
}

if (escalatedViaGenericAssignRole) {
  console.log("!!VULNERABLE!! assignRole() genérico concedió el Owner role — cualquier host gateado con un permiso genérico 'roles.assign' quedaba expuesto a escalada total.");
} else {
  console.log("[SAFE] — assignRole() nunca concede el Owner role; hace falta invocar explícitamente assignOwnerRole().");
}

// Confirmar que el camino explícito SÍ funciona (para un actor que de verdad
// esté autorizado a transferir ownership, vía el método dedicado).
await storage.memberships.assignOwnerRole(attackerMembership.id, "role-owner-a");
console.log("assignOwnerRole() explícito sí funciona (camino legítimo, sin cambios de comportamiento).");

await pool.end();
