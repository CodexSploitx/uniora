import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOrganizationWithOwner } from "@uniora/core";
import { applyMigrations, getMigrationStatus, listMigrationIds } from "./migrate.js";
import { createSqliteStorage } from "./storage.js";

/**
 * SQLite admits ONE writer at a time, across processes, through file locks —
 * that is what replaces Postgres' SERIALIZABLE + `FOR UPDATE` here. Async tasks
 * sharing one connection can't exercise it, so these tests spawn real OS
 * processes against the same file, released at the same instant. They run the
 * BUILT adapter (`dist/`), like the CLI's tests do for its dependencies.
 */
const DIST = resolve(import.meta.dirname, "../dist/index.js");
const WORKER = resolve(import.meta.dirname, "test-support/worker.mjs");
const TRIALS = 6;

interface WorkerOutcome {
  ok: boolean;
  result?: unknown;
  error?: string;
}

function runWorkers(file: string, jobs: { operation: string; payload?: unknown }[]): Promise<WorkerOutcome[]> {
  const startAt = Date.now() + 1000; // enough for every child to boot and open the file first
  return Promise.all(
    jobs.map(
      (job) =>
        new Promise<WorkerOutcome>((resolvePromise, reject) => {
          const child = spawn(process.execPath, [WORKER, file, job.operation, JSON.stringify(job.payload ?? {}), String(startAt)], {
            stdio: ["ignore", "pipe", "pipe"],
          });
          let stdout = "";
          let stderr = "";
          child.stdout.on("data", (chunk) => (stdout += chunk));
          child.stderr.on("data", (chunk) => (stderr += chunk));
          child.on("error", reject);
          child.on("close", (code) => {
            if (code !== 0 || stdout === "") {
              reject(new Error(`worker "${job.operation}" exited ${code}: ${stderr || stdout}`));
              return;
            }
            resolvePromise(JSON.parse(stdout) as WorkerOutcome);
          });
        }),
    ),
  );
}

describe("@uniora/sqlite — procesos concurrentes sobre el mismo archivo", () => {
  let directory: string;
  let counter = 0;

  beforeAll(() => {
    if (!existsSync(DIST)) {
      throw new Error("Falta dist/ — estos tests usan el adaptador compilado. Corre `pnpm --filter @uniora/sqlite build` primero.");
    }
    directory = mkdtempSync(join(tmpdir(), "uniora-sqlite-"));
  });

  afterAll(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  function freshDatabaseFile(): string {
    return join(directory, `db-${++counter}.sqlite`);
  }

  /** Opens a prepared database, lets `seed` populate it, and closes it so only the workers hold it. */
  async function seeded(seed: (storage: ReturnType<typeof createSqliteStorage>) => Promise<void>): Promise<string> {
    const file = freshDatabaseFile();
    const db = new Database(file);
    db.pragma("journal_mode = WAL");
    applyMigrations(db);
    await seed(createSqliteStorage(db));
    db.close();
    return file;
  }

  it("varios migradores a la vez aplican cada migración exactamente una vez", async () => {
    const file = freshDatabaseFile();

    const outcomes = await runWorkers(file, Array.from({ length: 4 }, () => ({ operation: "migrate" })));

    expect(outcomes.every((outcome) => outcome.ok)).toBe(true);
    expect(outcomes.reduce((total, outcome) => total + (outcome.result as number), 0)).toBe(listMigrationIds().length);

    const db = new Database(file, { readonly: true });
    expect(getMigrationStatus(db).applied).toHaveLength(listMigrationIds().length);
    db.close();
  }, 60_000);

  it(`dos Owners que se quitan mutuamente a la vez nunca dejan la organización sin Owner (${TRIALS} intentos)`, async () => {
    let bothRemoved = 0;

    for (let trial = 0; trial < TRIALS; trial++) {
      const file = await seeded(async (storage) => {
        await createOrganizationWithOwner(storage, {
          organizationId: "org-1",
          organizationName: "Acme",
          ownerRoleId: "role-owner",
          membershipId: "m-a",
          ownerIdentity: { provider: "p", subject: "a" },
        });
        await storage.memberships.create({ id: "m-b", organizationId: "org-1", identity: { provider: "p", subject: "b" } });
        await storage.memberships.assignOwnerRole("m-b", "role-owner");
      });

      const outcomes = await runWorkers(file, [
        { operation: "unassignOwnerRole", payload: { membershipId: "m-a", roleId: "role-owner" } },
        { operation: "unassignOwnerRole", payload: { membershipId: "m-b", roleId: "role-owner" } },
      ]);

      const db = new Database(file, { readonly: true });
      const owners = (db.prepare("select count(*) as n from uniora_membership_roles where role_id = 'role-owner'").get() as { n: number }).n;
      db.close();

      if (outcomes.every((outcome) => outcome.ok)) bothRemoved++;
      expect(owners).toBe(1);
      expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
      expect(outcomes.find((outcome) => !outcome.ok)?.error).toMatch(/last Owner/);
    }

    expect(bothRemoved).toBe(0);
  }, 120_000);

  it(`deleteMembership concurrente de los dos únicos Owners deja siempre uno (${TRIALS} intentos)`, async () => {
    for (let trial = 0; trial < TRIALS; trial++) {
      const file = await seeded(async (storage) => {
        await createOrganizationWithOwner(storage, {
          organizationId: "org-1",
          organizationName: "Acme",
          ownerRoleId: "role-owner",
          membershipId: "m-a",
          ownerIdentity: { provider: "p", subject: "a" },
        });
        await storage.memberships.create({ id: "m-b", organizationId: "org-1", identity: { provider: "p", subject: "b" } });
        await storage.memberships.assignOwnerRole("m-b", "role-owner");
      });

      const outcomes = await runWorkers(file, [
        { operation: "deleteMembership", payload: { membershipId: "m-a" } },
        { operation: "deleteMembership", payload: { membershipId: "m-b" } },
      ]);

      const db = new Database(file, { readonly: true });
      const owners = (db.prepare("select count(*) as n from uniora_membership_roles where role_id = 'role-owner'").get() as { n: number }).n;
      db.close();

      expect(owners).toBe(1);
      expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
    }
  }, 120_000);

  it(`link() y create() de la misma identidad desde procesos distintos nunca tienen éxito ambos (${TRIALS} intentos)`, async () => {
    const x = { provider: "new-provider", subject: "x" };
    const y = { provider: "legacy", subject: "y" };
    const actor = { provider: "supabase", subject: "actor" };

    for (let trial = 0; trial < TRIALS; trial++) {
      const file = await seeded(async (storage) => {
        await storage.organizations.create({ id: "org-1", name: "Acme" });
        await storage.memberships.create({ id: "m-y", organizationId: "org-1", identity: y });
      });

      const outcomes = await runWorkers(file, [
        { operation: "link", payload: { from: x, to: y, actor } },
        { operation: "createMembership", payload: { id: "m-x", organizationId: "org-1", identity: x } },
      ]);

      expect(outcomes.every((outcome) => outcome.ok)).toBe(false);
      expect(outcomes.some((outcome) => outcome.ok)).toBe(true);
    }
  }, 120_000);

  it(`link(B→A) y link(C→B) a la vez nunca forman una cadena, y el audit log coincide con lo persistido (${TRIALS} intentos)`, async () => {
    const A = { provider: "legacy", subject: "chain-a" };
    const B = { provider: "legacy", subject: "chain-b" };
    const C = { provider: "legacy", subject: "chain-c" };
    const actor = { provider: "supabase", subject: "actor" };

    for (let trial = 0; trial < TRIALS; trial++) {
      const file = await seeded(async (storage) => {
        await storage.organizations.create({ id: "org-1", name: "Acme" });
        await storage.memberships.create({ id: "m-a", organizationId: "org-1", identity: A });
      });

      const outcomes = await runWorkers(file, [
        { operation: "link", payload: { from: B, to: A, actor } },
        { operation: "link", payload: { from: C, to: B, actor } },
      ]);
      const succeeded = outcomes.filter((outcome) => outcome.ok).length;

      const db = new Database(file, { readonly: true });
      const links = (db.prepare("select count(*) as n from uniora_identity_links").get() as { n: number }).n;
      const audits = (db.prepare("select count(*) as n from uniora_audit_logs where action = 'identity_link.created'").get() as { n: number }).n;
      db.close();

      expect(succeeded).toBe(1);
      expect(links).toBe(succeeded);
      expect(audits).toBe(succeeded);
    }
  }, 120_000);

  it(`cuatro procesos creando claves de API a la vez nunca superan el tope de dos activas (${TRIALS} intentos)`, async () => {
    for (let trial = 0; trial < TRIALS; trial++) {
      const file = freshDatabaseFile();
      const seed = new Database(file);
      seed.pragma("journal_mode = WAL");
      applyMigrations(seed);
      seed.exec(`insert into uniora_api_clients (id, name, name_normalized, scopes, all_organizations, organization_ids, created_at, created_by_provider, created_by_subject, updated_at)
                 values ('apc_1', 'worker', 'worker', '["check"]', 1, '[]', '2026-10-10T00:00:00.000Z', 'uniora-cli', 'test', '2026-10-10T00:00:00.000Z')`);
      seed.close();

      const outcomes = await runWorkers(file, Array.from({ length: 4 }, () => ({ operation: "createApiKey", payload: { clientId: "apc_1" } })));

      const db = new Database(file, { readonly: true });
      const active = (db.prepare("select count(*) as n from uniora_api_keys where revoked_at is null").get() as { n: number }).n;
      db.close();
      expect(active).toBe(2);
      expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(2);
      for (const failed of outcomes.filter((outcome) => !outcome.ok)) expect(failed.error).toMatch(/at most 2 active keys/);
    }
  }, 120_000);
});
