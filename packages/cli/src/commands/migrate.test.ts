import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMigrationStatus, listMigrationIds } from "@uniora/postgres";
import pg from "pg";
import { ensureDatabase, resetUnioraSchema, testDatabaseUrl } from "../test-database.js";
import { runMigrate } from "./migrate.js";

describe("runMigrate", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "uniora-cli-migrate-"));
    process.exitCode = undefined;
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it("falla (exitCode 1) si no hay archivo de configuración, sin tocar ninguna base de datos", async () => {
    await runMigrate(dir);
    expect(process.exitCode).toBe(1);
  });

  it.skipIf(!process.env.DATABASE_URL)(
    "aplica las migraciones contra una base de datos real cuando DATABASE_URL está disponible",
    async () => {
      writeFileSync(
        join(dir, "uniora.config.mjs"),
        'export default { database: { provider: "postgresql", url: process.env.DATABASE_URL } };\n',
      );

      await runMigrate(dir);

      expect(process.exitCode).toBeUndefined();
    },
  );

  describe.skipIf(!testDatabaseUrl("x"))("ledger (base propia, schema vacío)", () => {
    const DATABASE = "uniora_test_cli_migrate";
    let url: string;

    beforeEach(async () => {
      url = await ensureDatabase(DATABASE);
      await resetUnioraSchema(url);
      writeFileSync(
        join(dir, "uniora.config.mjs"),
        `export default { database: { provider: "postgresql", url: ${JSON.stringify(url)} } };\n`,
      );
    });

    async function jsonOf(options: Parameters<typeof runMigrate>[1]): Promise<Record<string, unknown>> {
      vi.mocked(console.log).mockClear();
      process.exitCode = undefined;
      await runMigrate(dir, { ...options, json: true });
      return JSON.parse(vi.mocked(console.log).mock.calls.flat().join("\n"));
    }

    async function schemaExists(): Promise<boolean> {
      const client = new pg.Client({ connectionString: url });
      await client.connect();
      try {
        const result = await client.query("select to_regnamespace('uniora') is not null as present");
        return result.rows[0].present;
      } finally {
        await client.end();
      }
    }

    it("--dry-run lista lo que aplicaría, sale 0 y NO crea nada en la base", async () => {
      const output = await jsonOf({ dryRun: true });

      expect(process.exitCode).toBeUndefined();
      expect(output).toMatchObject({ ok: true, mode: "dry-run", pending: listMigrationIds() });
      expect(await schemaExists()).toBe(false);
    });

    it("--status sale 1 mientras haya pendientes y 0 cuando la base está al día", async () => {
      const before = await jsonOf({ status: true });
      expect(process.exitCode).toBe(1);
      expect(before).toMatchObject({ ok: false, mode: "status" });

      const applied = await jsonOf({});
      expect(process.exitCode).toBeUndefined();
      expect(applied).toMatchObject({ ok: true, mode: "apply", applied: listMigrationIds() });

      const after = await jsonOf({ status: true });
      expect(process.exitCode).toBeUndefined();
      expect(after).toMatchObject({ ok: true, pending: [] });
    });

    it("una segunda ejecución no aplica nada", async () => {
      await jsonOf({});
      const second = await jsonOf({});
      expect(second).toMatchObject({ ok: true, applied: [], skipped: listMigrationIds() });
    });

    it("se niega (exit 1, sin aplicar nada) si una migración ya aplicada fue modificada", async () => {
      await jsonOf({});
      const client = new pg.Client({ connectionString: url });
      await client.connect();
      await client.query("delete from uniora.schema_migrations where id = $1", [listMigrationIds().at(-1)]);
      await client.query("update uniora.schema_migrations set checksum = 'tampered' where id = '0001_init'");
      await client.end();

      const output = await jsonOf({});
      expect(process.exitCode).toBe(1);
      expect(output.ok).toBe(false);
      expect(JSON.stringify(output)).toContain("0001_init");

      const pool = new pg.Pool({ connectionString: url });
      expect((await getMigrationStatus(pool)).pending).toEqual([listMigrationIds().at(-1)]);
      await pool.end();
    });

    it("--dry-run refleja que migrate se negaría cuando hay migraciones modificadas", async () => {
      await jsonOf({});
      const client = new pg.Client({ connectionString: url });
      await client.connect();
      await client.query("update uniora.schema_migrations set checksum = 'tampered' where id = '0001_init'");
      await client.end();

      const output = await jsonOf({ dryRun: true });
      expect(process.exitCode).toBe(1);
      expect(output.ok).toBe(false);
    });
  });
});
