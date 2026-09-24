import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyMigrations } from "@uniora/postgres";
import pg from "pg";
import { ensureDatabase, resetUnioraSchema, testDatabaseUrl } from "../test-database.js";
import { checkGitignore, checkNodeRuntime, checkStudio, runDoctor } from "./doctor.js";

describe("checkNodeRuntime", () => {
  it("reporta ok en el runtime actual (expone process.loadEnvFile, ya usado en todo el paquete)", () => {
    expect(checkNodeRuntime()).toMatchObject({ name: "Node.js", severity: "ok" });
  });
});

describe("checkGitignore", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "uniora-cli-doctor-gitignore-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("warn si no existe .gitignore", () => {
    expect(checkGitignore(dir)).toMatchObject({ severity: "warn" });
  });

  it("warn si .gitignore existe pero no ignora .env", () => {
    writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
    expect(checkGitignore(dir)).toMatchObject({ severity: "warn" });
  });

  it("ok si .gitignore ya ignora .env", () => {
    writeFileSync(join(dir, ".gitignore"), "node_modules/\n.env\n");
    expect(checkGitignore(dir)).toMatchObject({ severity: "ok" });
  });

  it("con --env comprueba .env.<nombre>: ignorar solo .env no basta", () => {
    writeFileSync(join(dir, ".gitignore"), ".env\n");
    expect(checkGitignore(dir, "production")).toMatchObject({ severity: "warn" });

    writeFileSync(join(dir, ".gitignore"), ".env\n.env.production\n");
    expect(checkGitignore(dir, "production")).toMatchObject({ severity: "ok" });

    writeFileSync(join(dir, ".gitignore"), ".env.*\n");
    expect(checkGitignore(dir, "staging")).toMatchObject({ severity: "ok" });
  });
});

describe("runDoctor", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "uniora-cli-doctor-"));
    process.exitCode = undefined;
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it("reporta la config como fail (exitCode 1) sin intentar conectarse a la base de datos", async () => {
    await runDoctor(dir);

    expect(process.exitCode).toBe(1);
    const logged = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(logged).toContain("Configuración");
    expect(logged).not.toContain("Conexión a la base de datos");
  });

  it.skipIf(!process.env.DATABASE_URL)(
    "no falla cuando la config y la conexión son válidas, sin importar el estado de las migraciones",
    async () => {
      writeFileSync(
        join(dir, "uniora.config.mjs"),
        'export default { database: { provider: "postgresql", url: process.env.DATABASE_URL } };\n',
      );

      await runDoctor(dir);

      expect(process.exitCode).toBeUndefined();
      const logged = vi.mocked(console.log).mock.calls.flat().join("\n");
      expect(logged).toContain("Conexión a la base de datos");
      expect(logged).toContain("Migraciones");
    },
  );

  describe.skipIf(!testDatabaseUrl("x"))("chequeos profundos (base propia)", () => {
    let url: string;

    beforeEach(async () => {
      url = await ensureDatabase("uniora_test_cli_doctor");
      await resetUnioraSchema(url);
      writeFileSync(
        join(dir, "uniora.config.mjs"),
        `export default { database: { provider: "postgresql", url: ${JSON.stringify(url)} } };\n`,
      );
    });

    async function report(): Promise<{ ok: boolean; checks: { name: string; severity: string; message: string }[] }> {
      vi.mocked(console.log).mockClear();
      process.exitCode = undefined;
      await runDoctor(dir, { json: true });
      return JSON.parse(vi.mocked(console.log).mock.calls.flat().join("\n"));
    }

    it("reporta la versión de PostgreSQL y migraciones pendientes (warn, no fail) en una base virgen", async () => {
      const { ok, checks } = await report();

      expect(ok).toBe(true);
      expect(checks.find((c) => c.name === "PostgreSQL")?.severity).toBe("ok");
      expect(checks.find((c) => c.name === "Migraciones")).toMatchObject({ severity: "warn" });
      expect(checks.find((c) => c.name === "Owners")).toBeUndefined(); // sin schema completo no se consulta
    });

    it("detecta organizaciones sin ningún owner (warn) y aprueba cuando todas lo tienen", async () => {
      const pool = new pg.Pool({ connectionString: url });
      await applyMigrations(pool);
      await pool.query("insert into uniora.organizations (id, name, slug) values ('org-1', 'Acme', 'acme')");

      const missing = await report();
      expect(missing.checks.find((c) => c.name === "Migraciones")?.severity).toBe("ok");
      expect(missing.checks.find((c) => c.name === "Owners")).toMatchObject({ severity: "warn" });
      expect(missing.checks.find((c) => c.name === "Owners")?.message).toContain("org-1");

      await pool.query(
        `insert into uniora.roles (id, organization_id, name, key, is_owner_role) values ('r1', 'org-1', 'Owner', 'owner', true);
         insert into uniora.memberships (id, organization_id, provider, subject) values ('m1', 'org-1', 'supabase', 'u1');
         insert into uniora.membership_roles (membership_id, role_id) values ('m1', 'r1');`,
      );
      const fixed = await report();
      expect(fixed.checks.find((c) => c.name === "Owners")).toMatchObject({ severity: "ok" });
      await pool.end();
    });

    it("falla (exit 1) si una migración aplicada fue modificada", async () => {
      const pool = new pg.Pool({ connectionString: url });
      await applyMigrations(pool);
      await pool.query("update uniora.schema_migrations set checksum = 'tampered' where id = '0001_init'");
      await pool.end();

      const { ok, checks } = await report();
      expect(ok).toBe(false);
      expect(process.exitCode).toBe(1);
      expect(checks.find((c) => c.name === "Migraciones")).toMatchObject({ severity: "fail" });
    });

    it("con --env pide .env.<nombre> y falla si no existe", async () => {
      process.exitCode = undefined;
      vi.mocked(console.log).mockClear();
      await runDoctor(dir, { json: true, envName: "production" });
      const out = JSON.parse(vi.mocked(console.log).mock.calls.flat().join("\n"));
      expect(out.ok).toBe(false);
      expect(out.checks.find((c: { name: string }) => c.name === "Configuración").message).toContain(".env.production");
    });
  });
});

describe("checkStudio", () => {
  it("es warn (nunca fail) si Studio no está compilado: solo afecta a `uniora studio`", () => {
    expect(["ok", "warn"]).toContain(checkStudio().severity);
  });
});
