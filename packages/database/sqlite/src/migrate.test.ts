import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, getMigrationStatus, listMigrationIds, listMigrations, MigrationError } from "./migrate.js";

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

  it("0016 normaliza los nombres de rol que ya existen y no falla con duplicados heredados", () => {
    const migrations = listMigrations();
    const index = migrations.findIndex((migration) => migration.id === "0016_role_name_normalized");
    for (const migration of migrations.slice(0, index)) db.exec(migration.sql);
    db.exec("insert into uniora_organizations (id, name, slug) values ('o', 'O', 'o'), ('p', 'P', 'p')");
    db.exec(
      `insert into uniora_roles (id, organization_id, name, key) values
         ('r1', 'o', 'Recepción', 'a'), ('r2', 'o', 'RECEPCION', 'b'), ('r3', 'o', 'recepción', 'c'), ('r4', 'o', 'Ventas', 'd'), ('r5', 'p', 'Recepción', 'a')`,
    );
    db.exec(migrations[index]!.sql);
    expect(db.prepare("select id, name_normalized from uniora_roles order by id").all()).toEqual([
      { id: "r1", name_normalized: "recepcion" },
      { id: "r2", name_normalized: "recepcion#r2" },
      { id: "r3", name_normalized: "recepcion#r3" },
      { id: "r4", name_normalized: "ventas" },
      { id: "r5", name_normalized: "recepcion" },
    ]);
    expect(() => db.exec("insert into uniora_roles (id, organization_id, name, name_normalized, key) values ('r6', 'o', 'x', 'ventas', 'e')")).toThrow(/UNIQUE/);
  });

  it("0027 reconstruye las tablas de políticas sin perder datos, revisiones ni contadores, y deja los mismos índices y triggers", () => {
    const migrations = listMigrations();
    const index = migrations.findIndex((migration) => migration.id === "0027_policy_kinds");
    for (const migration of migrations.slice(0, index)) db.exec(migration.sql);

    const hash = (character: string) => character.repeat(64);
    const definition = (kind: string, extra = "") => JSON.stringify({ kind, effect: "deny", actions: ["a.b"], condition: { feature: "x" } }).replace("}", `${extra}}`);
    db.exec("insert into uniora_organizations (id, name, slug) values ('o1', 'O1', 'o1'), ('o2', 'O2', 'o2')");
    db.exec("begin");
    for (const [id, org, key] of [["p1", "o1", "uno"], ["p2", "o1", "dos"], ["p3", "o2", "tres"]] as const) {
      db.prepare(
        `insert into uniora_policies (id, organization_id, key, name, kind, effect, definition, definition_hash, created_at, created_by_provider, created_by_subject, updated_at)
         values (?, ?, ?, ?, 'access', 'deny', ?, ?, '2026-01-01T00:00:00.000Z', 'sys', 'import', '2026-01-01T00:00:00.000Z')`,
      ).run(id, org, key, key, definition("access"), hash("a"));
      db.prepare(
        `insert into uniora_policy_revisions (policy_id, organization_id, revision, definition, definition_hash, created_at, created_by_provider, created_by_subject)
         values (?, ?, 1, ?, ?, '2026-01-01T00:00:00.000Z', 'sys', 'import')`,
      ).run(id, org, definition("access"), hash("a"));
    }
    db.exec("commit");
    // p1: activated, then edited to revision 2 (the live path through the triggers).
    db.exec("update uniora_policies set status = 'active', version = 2, activated_at = '2026-01-02T00:00:00.000Z', updated_at = '2026-01-02T00:00:00.000Z' where id = 'p1'");
    db.exec("begin");
    db.prepare(
      `insert into uniora_policy_revisions (policy_id, organization_id, revision, definition, definition_hash, created_at, created_by_provider, created_by_subject, note)
       values ('p1', 'o1', 2, ?, ?, '2026-01-03T00:00:00.000Z', 'sys', 'import', 'second')`,
    ).run(definition("access", ', "denyReason": "later"'), hash("b"));
    db.prepare("update uniora_policies set revision = 2, definition = ?, definition_hash = ?, version = 3 where id = 'p1'").run(definition("access", ', "denyReason": "later"'), hash("b"));
    db.exec("commit");

    const snapshot = () => ({
      policies: db.prepare("select * from uniora_policies order by id").all(),
      revisions: db.prepare("select * from uniora_policy_revisions order by policy_id, revision").all(),
      sets: db.prepare("select * from uniora_policy_set_revisions order by organization_id").all(),
      counter: db.prepare("select * from uniora_policy_revision_counter").all(),
    });
    const objects = () =>
      (db.prepare("select type, name, tbl_name, sql from sqlite_master where (name like 'uniora\\_polic%' escape '\\' or tbl_name like 'uniora\\_polic%' escape '\\') and name not like 'sqlite_%' order by type, name").all() as { type: string; name: string; tbl_name: string; sql: string }[]).map(
        (row) => ({ ...row, sql: row.sql.replace(/\s+/g, " ").replace(", 'contextual', 'sensitive'", "").replace("create table if not exists", "create table").replace("create trigger if not exists", "create trigger").replace("create index if not exists", "create index") }),
      );
    const before = snapshot();
    const objectsBefore = objects();
    expect(before.policies).toHaveLength(3);
    expect(before.revisions).toHaveLength(4);

    // As the migrator runs it: one transaction (deferred foreign keys are checked at commit).
    db.exec("begin immediate");
    db.exec(migrations[index]!.sql);
    db.exec("commit");

    expect(snapshot()).toEqual(before);
    expect(objects()).toEqual(objectsBefore);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);

    // The new kinds are accepted, an unknown one is not, and the lifecycle triggers still guard the new tables.
    db.exec("begin");
    db.prepare(
      `insert into uniora_policies (id, organization_id, key, name, kind, effect, definition, definition_hash, created_at, created_by_provider, created_by_subject, updated_at)
       values ('p4', 'o1', 'cuatro', 'cuatro', 'contextual', 'deny', ?, ?, '2026-01-01T00:00:00.000Z', 'sys', 'import', '2026-01-01T00:00:00.000Z')`,
    ).run(definition("contextual"), hash("c"));
    db.prepare(
      `insert into uniora_policy_revisions (policy_id, organization_id, revision, definition, definition_hash, created_at, created_by_provider, created_by_subject)
       values ('p4', 'o1', 1, ?, ?, '2026-01-01T00:00:00.000Z', 'sys', 'import')`,
    ).run(definition("contextual"), hash("c"));
    db.exec("commit");
    expect(db.prepare("select kind from uniora_policies where id = 'p4'").get()).toEqual({ kind: "contextual" });
    expect(() =>
      db.exec(
        `insert into uniora_policies (id, organization_id, key, name, kind, effect, definition, definition_hash, created_at, created_by_provider, created_by_subject, updated_at)
         values ('p5', 'o1', 'cinco', 'cinco', 'magic', 'deny', '${definition("magic")}', '${hash("d")}', 'x', 'sys', 'import', 'x')`,
      ),
    ).toThrow(/CHECK/);
    expect(() => db.exec("update uniora_policies set version = version + 2 where id = 'p3'")).toThrow(/policy_immutable/);
    expect(() => db.exec("delete from uniora_policies where id = 'p1'")).toThrow(/policy_not_draft/);
    expect(() => db.exec("update uniora_policy_revisions set note = 'x' where policy_id = 'p1'")).toThrow(/policy_immutable/);
    // Deleting an organization still cascades through both tables.
    db.exec("delete from uniora_organizations where id = 'o2'");
    expect(db.prepare("select count(*) as n from uniora_policies where organization_id = 'o2'").get()).toEqual({ n: 0 });
    expect(db.prepare("select count(*) as n from uniora_policy_revisions where organization_id = 'o2'").get()).toEqual({ n: 0 });
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
