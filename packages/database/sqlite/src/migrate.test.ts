import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, getMigrationStatus, listMigrationIds, MigrationError } from "./migrate.js";

describe("migration ledger", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  function tables(): string[] {
    return (db.prepare("select name from sqlite_master where type = 'table' order by name").all() as { name: string }[]).map(
      (row) => row.name,
    );
  }

  it("los archivos sql/ aplicados a mano dejan el mismo esquema que el migrador, y applyMigrations los acepta después", () => {
    const sqlDir = join(dirname(fileURLToPath(import.meta.url)), "..", "sql");
    const schema = (database: Database.Database) =>
      database
        .prepare("select type, name, sql from sqlite_master where name not like 'sqlite_%' and name <> 'uniora_schema_migrations' order by type, name")
        .all();
    for (const id of listMigrationIds()) db.exec(readFileSync(join(sqlDir, `${id}.sql`), "utf8"));
    const byHand = schema(db);

    const reference = new Database(":memory:");
    applyMigrations(reference);
    expect(schema(reference)).toEqual(byHand);
    reference.close();
  });

  it("status es de solo lectura: no crea nada en una base virgen y reporta todo pendiente", () => {
    const status = getMigrationStatus(db);

    expect(status.ledgerPresent).toBe(false);
    expect(status.pending).toEqual(listMigrationIds());
    expect(status.applied).toEqual([]);
    expect(tables()).toEqual([]);
  });

  it("aplica todo la primera vez, lo registra, y la segunda vez no re-ejecuta nada", () => {
    const first = applyMigrations(db);
    expect(first.applied).toEqual(listMigrationIds());
    expect(first.skipped).toEqual([]);

    const status = getMigrationStatus(db);
    expect(status).toMatchObject({ ledgerPresent: true, pending: [], modified: [], unknown: [] });
    expect(status.applied.map((migration) => migration.id)).toEqual(listMigrationIds());
    expect(status.applied[0]!.appliedAt.getTime()).toBeGreaterThan(Date.now() - 60_000);

    const second = applyMigrations(db);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual(listMigrationIds());
  });

  it("crea todas las tablas de UNIORA con el prefijo uniora_ y nada fuera de él", () => {
    applyMigrations(db);

    expect(tables().filter((name) => !name.startsWith("uniora_") && !name.startsWith("sqlite_"))).toEqual([]);
    expect(tables()).toEqual(
      expect.arrayContaining([
        "uniora_audit_logs",
        "uniora_feature_definitions",
        "uniora_features",
        "uniora_identity_links",
        "uniora_invitation_roles",
        "uniora_invitations",
        "uniora_membership_roles",
        "uniora_memberships",
        "uniora_organizations",
        "uniora_permissions",
        "uniora_role_permissions",
        "uniora_roles",
        "uniora_schema_migrations",
      ]),
    );
  });

  it("convive con las tablas de la propia aplicación (mismos nombres sin prefijo) sin tocarlas", () => {
    db.exec("create table organizations (id text primary key, secret text); insert into organizations values ('x', 'keep me')");

    applyMigrations(db);

    expect(db.prepare("select secret from organizations").get()).toEqual({ secret: "keep me" });
  });

  it("detecta una migración modificada tras aplicarse y se niega a seguir", () => {
    applyMigrations(db);
    db.prepare("update uniora_schema_migrations set checksum = 'tampered' where id = '0001_init'").run();

    expect(getMigrationStatus(db).modified).toEqual(["0001_init"]);
    expect(() => applyMigrations(db)).toThrow(MigrationError);
  });

  it("reporta migraciones desconocidas (base más nueva que el código) sin bloquear", () => {
    applyMigrations(db);
    db.prepare("insert into uniora_schema_migrations (id, checksum) values ('9999_from_the_future', 'x')").run();

    const status = getMigrationStatus(db);
    expect(status.unknown).toEqual(["9999_from_the_future"]);
    expect(status.modified).toEqual([]);

    expect(applyMigrations(db)).toMatchObject({ applied: [] });
  });

  it("es todo-o-nada: una migración que falla a medias no deja tablas ni ledger", () => {
    // Simula una base con un objeto en conflicto: la migración falla a mitad de camino.
    db.exec("create view uniora_features as select 1 as x");

    expect(() => applyMigrations(db)).toThrow();

    expect(tables()).toEqual([]);
    expect(getMigrationStatus(db).ledgerPresent).toBe(false);
  });
});
