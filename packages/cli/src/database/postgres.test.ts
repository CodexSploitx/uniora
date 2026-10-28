import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureDatabase, testDatabaseUrl } from "../test-database.js";
import { rowLevelSecurityCheck, rowLevelSecurityResult } from "./postgres.js";

describe("rowLevelSecurityResult", () => {
  const none = { bypasses: false, tables: 0, unforcedOwned: [], unforcedOwnedTotal: 0 };

  it("ok si la base no tiene tablas con RLS", () => {
    expect(rowLevelSecurityResult({ ...none, bypasses: true })).toMatchObject({ severity: "ok" });
  });

  it("ok si el rol no es dueño de tablas sin FORCE ni se salta la RLS", () => {
    expect(rowLevelSecurityResult({ ...none, tables: 3 })).toMatchObject({ severity: "ok" });
  });

  it("avisa de las tablas de las que el rol es dueño sin FORCE, con una muestra y el total", () => {
    const result = rowLevelSecurityResult({
      bypasses: false,
      tables: 8,
      unforcedOwned: ["public.vehicles", "public.reports"],
      unforcedOwnedTotal: 7,
    });
    expect(result.severity).toBe("warn");
    expect(result.message).toContain("7 tabla(s)");
    expect(result.message).toContain("public.vehicles, public.reports, …");
    expect(result.message).toContain("FORCE ROW LEVEL SECURITY");
  });

  it("avisa de un rol superusuario o BYPASSRLS, que ignora incluso FORCE", () => {
    const result = rowLevelSecurityResult({ ...none, bypasses: true, tables: 2 });
    expect(result.severity).toBe("warn");
    expect(result.message).toContain("BYPASSRLS");
  });
});

describe.skipIf(!testDatabaseUrl("x"))("rowLevelSecurityCheck (Postgres real)", () => {
  const role = "uniora_test_rls_owner";
  const password = "rls-owner-pass";
  let admin: pg.Pool;
  let owner: pg.Pool;

  beforeAll(async () => {
    const url = await ensureDatabase("uniora_test_cli_rls");
    admin = new pg.Pool({ connectionString: url });
    await admin.query(`drop schema if exists rls_check cascade`);
    await admin.query(`drop role if exists ${role}`);
    await admin.query(`create role ${role} login password '${password}' nosuperuser nobypassrls nocreaterole nocreatedb`);
    await admin.query(`create schema rls_check authorization ${role}`);
    await admin.query(`create table rls_check.vehicles (id int, organization_id text)`);
    await admin.query(`alter table rls_check.vehicles owner to ${role}`);
    await admin.query(`alter table rls_check.vehicles enable row level security`);

    const ownerUrl = new URL(url);
    ownerUrl.username = role;
    ownerUrl.password = password;
    owner = new pg.Pool({ connectionString: ownerUrl.toString() });
  });

  afterAll(async () => {
    await owner?.end();
    await admin?.query(`drop schema if exists rls_check cascade`);
    await admin?.query(`drop role if exists ${role}`);
    await admin?.end();
  });

  it("avisa cuando el dueño de una tabla con RLS (sin FORCE) es el rol de la conexión", async () => {
    const result = await rowLevelSecurityCheck(owner);
    expect(result.severity).toBe("warn");
    expect(result.message).toContain("rls_check.vehicles");
  });

  it("con FORCE ROW LEVEL SECURITY el dueño deja de ser un aviso", async () => {
    await admin.query(`alter table rls_check.vehicles force row level security`);
    expect(await rowLevelSecurityCheck(owner)).toMatchObject({ severity: "ok" });
  });
});
