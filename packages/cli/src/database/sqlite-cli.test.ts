import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listMigrationIds } from "@uniora/sqlite";
import { runCli } from "../cli/main.js";
import { runCheck } from "../commands/check.js";
import { runDoctor } from "../commands/doctor.js";
import { runMigrate } from "../commands/migrate.js";

/**
 * Los comandos del CLI contra SQLite de verdad (un archivo en un directorio
 * temporal). A diferencia de los de Postgres, no necesitan ningún servicio ni
 * variable de entorno: corren siempre.
 */
describe("CLI con provider sqlite", () => {
  let dir: string;
  let dbFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "uniora-cli-sqlite-"));
    dbFile = join(dir, "data", "uniora.db");
    mkdirSync(join(dir, "data"));
    writeFileSync(
      join(dir, "uniora.config.mjs"),
      'export default { database: { provider: "sqlite", url: "sqlite:./data/uniora.db" } };\n',
    );
    process.exitCode = undefined;
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  async function json<T = Record<string, any>>(run: () => Promise<void>): Promise<T> {
    vi.mocked(console.log).mockClear();
    process.exitCode = undefined;
    await run();
    return JSON.parse(vi.mocked(console.log).mock.calls.flat().join("\n")) as T;
  }

  const migrate = (options: Parameters<typeof runMigrate>[1] = {}) => json(() => runMigrate(dir, { ...options, json: true }));
  const doctor = () => json<{ ok: boolean; checks: { name: string; severity: string; message: string }[] }>(() => runDoctor(dir, { json: true }));

  describe("migrate", () => {
    it("--dry-run y --status NO crean el archivo: mirar nunca deja una base vacía", async () => {
      const dry = await migrate({ dryRun: true });
      expect(dry).toMatchObject({ ok: true, mode: "dry-run", provider: "sqlite", pending: listMigrationIds() });
      expect(existsSync(dbFile)).toBe(false);

      const status = await migrate({ status: true });
      expect(process.exitCode).toBe(1); // pendientes → gate de CI
      expect(status).toMatchObject({ ok: false, mode: "status" });
      expect(existsSync(dbFile)).toBe(false);
    });

    it("aplica creando el archivo (ruta relativa resuelta contra el proyecto), y después queda al día", async () => {
      const applied = await migrate();
      expect(process.exitCode).toBeUndefined();
      expect(applied).toMatchObject({ ok: true, mode: "apply", provider: "sqlite", applied: listMigrationIds(), target: dbFile });
      expect(statSync(dbFile).isFile()).toBe(true);

      const status = await migrate({ status: true });
      expect(process.exitCode).toBeUndefined();
      expect(status).toMatchObject({ ok: true, pending: [] });

      const second = await migrate();
      expect(second).toMatchObject({ ok: true, applied: [], skipped: listMigrationIds() });
    });

    it("se niega (exit 1, sin tocar nada) si una migración ya aplicada fue modificada", async () => {
      await migrate();
      const db = new Database(dbFile);
      db.prepare("update uniora_schema_migrations set checksum = 'tampered' where id = '0001_init'").run();
      db.close();

      const output = await migrate();
      expect(process.exitCode).toBe(1);
      expect(output.ok).toBe(false);
      expect(JSON.stringify(output)).toContain("0001_init");

      const dry = await migrate({ dryRun: true });
      expect(process.exitCode).toBe(1);
      expect(dry.ok).toBe(false);
    });

    it("el directorio de destino inexistente falla con un error claro (no crea carpetas por su cuenta)", async () => {
      writeFileSync(
        join(dir, "uniora.config.mjs"),
        'export default { database: { provider: "sqlite", url: "sqlite:./no-existe/uniora.db" } };\n',
      );

      const output = await migrate();

      expect(process.exitCode).toBe(1);
      expect(output.ok).toBe(false);
      expect(existsSync(join(dir, "no-existe"))).toBe(false);
    });
  });

  describe("check", () => {
    it("con el archivo ausente avisa (warn) sin fallar y sin crearlo", async () => {
      const { ok, checks } = await json<{ ok: boolean; checks: { name: string; severity: string; message: string }[] }>(() =>
        runCheck(dir, { json: true }),
      );

      expect(ok).toBe(true);
      expect(process.exitCode).toBeUndefined();
      expect(checks.find((c) => c.name === "Conexión a la base de datos")).toMatchObject({ severity: "warn" });
      expect(existsSync(dbFile)).toBe(false);
    });

    it("conecta a la base existente y dice a qué archivo", async () => {
      await migrate();

      const { checks } = await json<{ checks: { name: string; severity: string; message: string }[] }>(() => runCheck(dir, { json: true }));

      expect(checks.find((c) => c.name === "Conexión a la base de datos")).toMatchObject({
        severity: "ok",
        message: `conectado a ${dbFile}`,
      });
    });

    it("falla si la ruta no es un archivo SQLite válido", async () => {
      writeFileSync(dbFile, "esto no es una base de datos sqlite, es texto plano suficientemente largo para no ser vacío".repeat(20));

      await json(() => runCheck(dir, { json: true }));

      expect(process.exitCode).toBe(1);
    });
  });

  describe("doctor", () => {
    it("en una base ausente: todo pendiente (warn), sin motor que diagnosticar y sin crear el archivo", async () => {
      const { ok, checks } = await doctor();

      expect(ok).toBe(true);
      expect(checks.find((c) => c.name === "Conexión a la base de datos")).toMatchObject({ severity: "warn" });
      expect(checks.find((c) => c.name === "Migraciones")).toMatchObject({ severity: "warn" });
      expect(checks.find((c) => c.name === "SQLite")).toBeUndefined();
      expect(checks.find((c) => c.name === "Owners")).toBeUndefined();
      expect(existsSync(dbFile)).toBe(false);
    });

    it("tras migrar: versión del motor, WAL, integridad y migraciones OK", async () => {
      await migrate();

      const { ok, checks } = await doctor();

      expect(ok).toBe(true);
      for (const name of ["SQLite", "Journal", "Integridad", "Migraciones", "Owners"]) {
        expect(checks.find((c) => c.name === name), name).toMatchObject({ severity: "ok" });
      }
    });

    it("avisa si el journal no es WAL y no lo cambia (doctor es de solo lectura)", async () => {
      const db = new Database(dbFile);
      db.pragma("journal_mode = DELETE");
      db.close();
      // Aplicar a mano sin pasar por el CLI (que activaría WAL).
      const { applyMigrations } = await import("@uniora/sqlite");
      const raw = new Database(dbFile);
      applyMigrations(raw);
      raw.close();

      const { checks } = await doctor();

      expect(checks.find((c) => c.name === "Journal")).toMatchObject({ severity: "warn" });
      const after = new Database(dbFile, { readonly: true });
      expect(after.pragma("journal_mode", { simple: true })).toBe("delete");
      after.close();
    });

    it("detecta organizaciones sin owner (warn) y aprueba cuando todas lo tienen", async () => {
      await migrate();
      const db = new Database(dbFile);
      db.exec("insert into uniora_organizations (id, name, slug) values ('org-1', 'Acme', 'acme')");

      const missing = await doctor();
      expect(missing.checks.find((c) => c.name === "Owners")).toMatchObject({ severity: "warn" });
      expect(missing.checks.find((c) => c.name === "Owners")?.message).toContain("org-1");

      db.exec(`
        insert into uniora_roles (id, organization_id, name, name_normalized, key, is_owner_role) values ('r1', 'org-1', 'Owner', 'owner', 'owner', 1);
        insert into uniora_memberships (id, organization_id, provider, subject) values ('m1', 'org-1', 'supabase', 'u1');
        insert into uniora_membership_roles (membership_id, role_id) values ('m1', 'r1');
      `);
      db.close();
      const fixed = await doctor();
      expect(fixed.checks.find((c) => c.name === "Owners")).toMatchObject({ severity: "ok" });
    });

    it("falla (exit 1) si una migración aplicada fue modificada", async () => {
      await migrate();
      const db = new Database(dbFile);
      db.prepare("update uniora_schema_migrations set checksum = 'tampered' where id = '0001_init'").run();
      db.close();

      const { ok, checks } = await doctor();

      expect(ok).toBe(false);
      expect(process.exitCode).toBe(1);
      expect(checks.find((c) => c.name === "Migraciones")).toMatchObject({ severity: "fail" });
    });
  });

  describe("flujo completo desde runCli", () => {
    it("init --provider sqlite → migrate → check → doctor, sin tocar nada fuera del proyecto", async () => {
      const fresh = mkdtempSync(join(tmpdir(), "uniora-cli-flow-"));
      try {
        await runCli(["init", "--provider", "sqlite"], fresh);
        const config = readFileSync(join(fresh, "uniora.config.mjs"), "utf8");
        expect(config).toContain('provider: "sqlite"');
        expect(config).toContain("process.env.DATABASE_URL");
        expect(readFileSync(join(fresh, ".env.example"), "utf8")).toContain("DATABASE_URL=sqlite:./uniora.db");
        expect(readFileSync(join(fresh, ".gitignore"), "utf8").split("\n")).toEqual(expect.arrayContaining([".env", "uniora.db*"]));

        // El "usuario" copia .env.example a .env.
        writeFileSync(join(fresh, ".env"), "DATABASE_URL=sqlite:./uniora.db\n");
        const saved = process.env.DATABASE_URL;
        delete process.env.DATABASE_URL;
        try {
          await runCli(["migrate"], fresh);
          expect(process.exitCode).toBeUndefined();
          expect(existsSync(join(fresh, "uniora.db"))).toBe(true);

          await runCli(["check"], fresh);
          await runCli(["doctor"], fresh);
          expect(process.exitCode).toBeUndefined();
        } finally {
          if (saved === undefined) delete process.env.DATABASE_URL;
          else process.env.DATABASE_URL = saved;
        }
      } finally {
        rmSync(fresh, { recursive: true, force: true });
      }
    });

    it("init con un --provider inválido es un error de uso (exit 2) y no escribe nada", async () => {
      const fresh = mkdtempSync(join(tmpdir(), "uniora-cli-flow-"));
      try {
        await runCli(["init", "--provider", "mysql"], fresh);

        expect(process.exitCode).toBe(2);
        expect(existsSync(join(fresh, "uniora.config.mjs"))).toBe(false);
      } finally {
        rmSync(fresh, { recursive: true, force: true });
      }
    });
  });
});
