import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations } from "./migrate.js";
import { createPostgresStorage } from "./storage.js";

/** Base de datos PROPIA (ver migrate.test.ts): crea un rol y le concede y retira privilegios. */
const DATABASE_NAME = "uniora_test_retention";
const ROLE = "uniora_ret_probe";

function urlFor(database: string): string {
  const base = process.env.TEST_DATABASE_URL;
  if (!base) throw new Error("TEST_DATABASE_URL no está definida (ver .env.example).");
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

async function ensureDatabase(): Promise<void> {
  const admin = new Client({ connectionString: urlFor("postgres") });
  await admin.connect();
  try {
    const existing = await admin.query("select 1 from pg_database where datname = $1", [DATABASE_NAME]);
    if (existing.rowCount === 0) {
      for (let attempt = 0; ; attempt++) {
        try {
          await admin.query(`create database "${DATABASE_NAME}"`);
          break;
        } catch (error) {
          const code = (error as { code?: string }).code;
          if (code === "42P04" || code === "23505") break;
          if (code === "55006" && attempt < 6) {
            await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
            continue;
          }
          throw error;
        }
      }
    }
    const role = await admin.query("select 1 from pg_roles where rolname = $1", [ROLE]);
    if (role.rowCount === 0) {
      try {
        await admin.query(`create role ${ROLE} nologin nosuperuser nocreaterole nocreatedb`);
      } catch (error) {
        if ((error as { code?: string }).code !== "42710") throw error;
      }
    }
  } finally {
    await admin.end();
  }
}

const actor = { provider: "supabase", subject: "retention-job" };
const pause = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("uniora.prune_audit_logs — quién puede podar el audit log", () => {
  let pool: Pool;

  beforeAll(async () => {
    await ensureDatabase();
    pool = new Pool({ connectionString: urlFor(DATABASE_NAME) });
    await applyMigrations(pool);
    await pool.query(`grant usage on schema uniora to ${ROLE}`);
    await pool.query(`revoke all on uniora.audit_logs, uniora.audit_log_checkpoints from ${ROLE}`);
    await pool.query(`revoke execute on function uniora.prune_audit_logs(timestamptz, text, text, text) from ${ROLE}`);
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
  });

  async function seed(prefix: string, count: number): Promise<void> {
    await pool.query("truncate uniora.audit_logs, uniora.audit_log_checkpoints");
    const storage = createPostgresStorage(pool);
    for (let n = 0; n < count; n++) {
      await storage.auditLogs.record({ id: `${prefix}-${n}`, actor, action: "role.created" });
    }
    await pause();
  }

  async function asRole<T>(sql: string, params: unknown[] = [], setup: string[] = []): Promise<T[]> {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(`set local role ${ROLE}`);
      for (const statement of setup) await client.query(statement);
      return (await client.query(sql, params)).rows as T[];
    } finally {
      await client.query("rollback");
      client.release();
    }
  }

  const prune = "select * from uniora.prune_audit_logs(now(), $1, $2, $3)";
  const count = async () => Number((await pool.query("select count(*) as n from uniora.audit_logs")).rows[0].n);

  it("sin EXECUTE concedido, ningún rol puede llamar a la función (está revocada de public)", async () => {
    await seed("a", 3);
    await expect(asRole(prune, [actor.provider, actor.subject, "p-1"])).rejects.toMatchObject({ code: "42501" });
    expect(await count()).toBe(3);
  });

  it("con EXECUTE el rol poda sin tener ningún privilegio sobre las tablas (security definer)", async () => {
    await seed("b", 3);
    await pool.query(`grant execute on function uniora.prune_audit_logs(timestamptz, text, text, text) to ${ROLE}`);
    try {
      const [row] = await asRole<{ removed: string }>(prune, [actor.provider, actor.subject, "p-2"]);
      // A rolled-back probe: the real effect is checked in the next test; here only that the call succeeds.
      expect(Number(row?.removed)).toBe(2);
      await expect(asRole("select count(*) from uniora.audit_logs")).rejects.toMatchObject({ code: "42501" });
    } finally {
      await pool.query(`revoke execute on function uniora.prune_audit_logs(timestamptz, text, text, text) from ${ROLE}`);
    }
  });

  it("un rol con DELETE sobre la tabla (una app mal configurada) sigue sin poder borrar, ni siquiera activando la bandera", async () => {
    await seed("c", 3);
    await pool.query(`grant select, delete on uniora.audit_logs to ${ROLE}`);
    try {
      await expect(
        asRole("delete from uniora.audit_logs", [], ["select set_config('uniora.audit_pruning', 'on', true)"]),
      ).rejects.toMatchObject({ code: "42501", message: expect.stringContaining("append-only") });
      await expect(asRole("delete from uniora.audit_logs")).rejects.toMatchObject({ code: "42501" });
      expect(await count()).toBe(3);
    } finally {
      await pool.query(`revoke all on uniora.audit_logs from ${ROLE}`);
    }
  });

  it("la tabla de checkpoints también es append-only", async () => {
    await seed("d", 3);
    await pool.query("select * from uniora.prune_audit_logs(now(), $1, $2, $3)", [actor.provider, actor.subject, "p-4"]);
    await expect(pool.query("update uniora.audit_log_checkpoints set removed = 99")).rejects.toMatchObject({ code: "42501" });
    await expect(pool.query("delete from uniora.audit_log_checkpoints")).rejects.toMatchObject({ code: "42501" });
  });

  it("la función exige un corte pasado y un actor", async () => {
    await seed("e", 3);
    await expect(
      pool.query("select * from uniora.prune_audit_logs(now() + interval '1 day', $1, $2, $3)", [actor.provider, actor.subject, "p-5"]),
    ).rejects.toMatchObject({ code: "22023" });
    await expect(pool.query(prune, ["", actor.subject, "p-6"])).rejects.toMatchObject({ code: "22023" });
    expect(await count()).toBe(3);
  });
});
