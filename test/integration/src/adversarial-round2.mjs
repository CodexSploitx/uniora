// PENTEST — Ronda 2, no confiar en el reporte anterior. TEMPORAL, no se commitea.
import pg from "pg";
import { createAuthorizationEngine, createOrganizationWithOwner } from "@uniora/core";
import { applyMigrations, createPostgresStorage } from "@uniora/postgres";

const pool = new pg.Pool({ connectionString: "postgresql://postgres:uniora@localhost:55432/uniora_pentest" });
await pool.query("drop schema if exists uniora cascade"); // reset para poder re-correr el script sin recrear la DB
await applyMigrations(pool);
const storage = createPostgresStorage(pool);
const engine = createAuthorizationEngine(storage);

await storage.features.register({ key: "ai_assistant", name: "AI Assistant" });
await storage.features.register({ key: "beta_dashboard", name: "Beta Dashboard" });

const { organization: orgA } = await createOrganizationWithOwner(storage, {
  organizationId: "org-a", organizationName: "ORG_A_SECRET",
  ownerRoleId: "role-owner-a", membershipId: "membership-owner-a", ownerIdentity: { provider: "e2e", subject: "owner-a" },
});
await createOrganizationWithOwner(storage, {
  organizationId: "org-b", organizationName: "ORG_B_SECRET",
  ownerRoleId: "role-owner-b", membershipId: "membership-owner-b", ownerIdentity: { provider: "e2e", subject: "owner-b" },
});

await storage.features.enable(orgA.id, "ai_assistant");
await storage.features.enable(orgA.id, "beta_dashboard");
// org-a NUNCA le dio membership a nadie más que a su owner.

console.log("=".repeat(70));
console.log("ATTACK — access.check({ feature }) SIN permission, sin membership");
console.log("=".repeat(70));

const outsider = { provider: "attacker-controlled", subject: crypto.randomUUID() };
const ownerB = { provider: "e2e", subject: "owner-b" };

const r1 = await engine.access.check({ identity: outsider, organizationId: orgA.id, feature: "ai_assistant" });
const r2 = await engine.access.check({ identity: ownerB, organizationId: orgA.id, feature: "beta_dashboard" });

console.log(`outsider sin membership en ningún lado -> access.check(orgA, feature: ai_assistant) = ${r1}`);
console.log(`Owner LEGÍTIMO de Org B (cross-tenant)  -> access.check(orgA, feature: beta_dashboard) = ${r2}`);

if (r1 === true || r2 === true) {
  console.log("\n!!VULNERABLE!! — un identity SIN membership en org-a pasa un gate solo-de-feature.");
} else {
  console.log("\n[SAFE] — ambos denegados.");
}

await pool.end();
