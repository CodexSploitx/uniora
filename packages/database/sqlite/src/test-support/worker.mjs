// Child process for multiprocess.test.ts: opens the SAME database file the test
// opened, waits for a shared start time, then performs ONE operation through the
// real, built adapter and reports the outcome as JSON on stdout. Real processes
// (not async tasks on one connection) are the only way to exercise SQLite's
// file-level locking, which is what serializes writers across processes.
import Database from "better-sqlite3";
import { generateApiKey } from "@uniora/core";
import { applyMigrations, createSqliteApiCredentialStorage, createSqliteStorage } from "../../dist/index.js";

const [file, operation, payloadJson, startAtText] = process.argv.slice(2);
const payload = JSON.parse(payloadJson);

const db = new Database(file);
// Several workers switch a brand-new file to WAL at the same moment; SQLite answers SQLITE_BUSY at once (the
// busy timeout is not consulted for that switch), so retry a few times instead of failing the whole test.
for (let attempt = 0; ; attempt++) {
  try {
    db.pragma("journal_mode = WAL");
    break;
  } catch (error) {
    if (error?.code !== "SQLITE_BUSY" || attempt >= 50) throw error;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

try {
  const storage = createSqliteStorage(db);

  // Barrier: every worker spins to the same wall-clock instant, so their
  // statements genuinely overlap instead of running one after another.
  const startAt = Number(startAtText);
  while (Date.now() < startAt) {
    /* spin */
  }

  let result;
  switch (operation) {
    case "migrate":
      result = applyMigrations(db).applied.length;
      break;
    case "unassignOwnerRole":
      await storage.memberships.unassignOwnerRole(payload.membershipId, payload.roleId);
      break;
    case "deleteMembership":
      await storage.memberships.delete(payload.membershipId);
      break;
    case "link":
      await storage.identityLinks.link(payload);
      break;
    case "createMembership":
      await storage.memberships.create(payload);
      break;
    case "createApiKey": {
      // The credential storage over the same connection: the cap of two active keys must hold across processes.
      const generated = generateApiKey();
      await createSqliteApiCredentialStorage(db).apiKeys.create({
        id: generated.id,
        clientId: payload.clientId,
        secretHash: generated.secretHash,
        hint: generated.hint,
        createdBy: { provider: "uniora-cli", subject: "test" },
        now: new Date(),
      });
      break;
    }
    default:
      throw new Error(`unknown operation ${operation}`);
  }
  process.stdout.write(JSON.stringify({ ok: true, result }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
} finally {
  db.close();
}
