import pg from "pg";
import { createAuthorizationEngine, createOrganizationWithOwner, computeAuthorizationSnapshot } from "@uniora/core";
import { applyMigrations, createPostgresStorage } from "@uniora/postgres";

const pool = new pg.Pool({ connectionString: "postgresql://postgres:uniora@localhost:55432/uniora_pentest" });
await applyMigrations(pool); // se apoya en que round2.mjs ya sembró org-a/org-b/ai_assistant en esta corrida
const storage = createPostgresStorage(pool);
const engine = createAuthorizationEngine(storage);

const outsider = { provider: "attacker-controlled", subject: crypto.randomUUID() };

const snap = await computeAuthorizationSnapshot(engine, storage.features, {
  identity: outsider,
  organizationId: "org-a",
  features: ["ai_assistant"],
});

console.log("computeAuthorizationSnapshot para un outsider sin membership en org-a:", JSON.stringify(snap));
if (snap.features.ai_assistant === true) {
  console.log("!!VULNERABLE!! el snapshot reporta feature=true para una identidad sin membership en la organización.");
} else {
  console.log("[SAFE]");
}

await pool.end();
