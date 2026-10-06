import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations } from "./migrate.js";
import { hasUnioraSchema, openSqliteDatabase, SqliteUrlError, sqlitePathFromUrl } from "./connection.js";

describe("sqlitePathFromUrl", () => {
  const cwd = resolve("/projects/app");

  it("resuelve una ruta relativa contra el cwd", () => {
    expect(sqlitePathFromUrl("sqlite:./data/uniora.db", cwd)).toBe(resolve(cwd, "data/uniora.db"));
    expect(sqlitePathFromUrl("sqlite:uniora.db", cwd)).toBe(resolve(cwd, "uniora.db"));
  });

  it("acepta rutas absolutas, con y sin estilo URL", () => {
    expect(sqlitePathFromUrl("sqlite:/var/lib/uniora.db", cwd)).toBe(resolve("/var/lib/uniora.db"));
    expect(sqlitePathFromUrl("sqlite:///var/lib/uniora.db", cwd)).toBe(resolve("/var/lib/uniora.db"));
  });

  it("rechaza lo que no es una URL de SQLite", () => {
    expect(() => sqlitePathFromUrl("postgresql://u:p@host/db", cwd)).toThrow(SqliteUrlError);
    expect(() => sqlitePathFromUrl("./uniora.db", cwd)).toThrow(/sqlite:/);
  });

  it("rechaza lo que no apunta a UN archivo concreto (en memoria, vacío, con host, con query)", () => {
    expect(() => sqlitePathFromUrl("sqlite:", cwd)).toThrow(/ningún archivo/);
    expect(() => sqlitePathFromUrl("sqlite:///", cwd)).toThrow(SqliteUrlError);
    expect(() => sqlitePathFromUrl("sqlite::memory:", cwd)).toThrow(/memoria/);
    expect(() => sqlitePathFromUrl("sqlite://host/db.sqlite", cwd)).toThrow(/host/);
    expect(() => sqlitePathFromUrl("sqlite:./a.db?mode=ro", cwd)).toThrow(/"\?" ni "#"/);
    expect(() => sqlitePathFromUrl("sqlite:./a.db#frag", cwd)).toThrow(SqliteUrlError);
  });
});

describe("openSqliteDatabase", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "uniora-sqlite-open-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("crea el archivo y NO cambia el modo de journal salvo que se pida (wal es opt-in y persistente)", () => {
    const file = join(dir, "plain.db");
    const plain = openSqliteDatabase(file);
    expect(existsSync(file)).toBe(true);
    expect(plain.pragma("journal_mode", { simple: true })).toBe("delete");
    plain.close();

    const reopened = openSqliteDatabase(file, { wal: true });
    expect(reopened.pragma("journal_mode", { simple: true })).toBe("wal");
    reopened.close();
    // Persistente: una apertura posterior, sin pedirlo, ya lo encuentra en WAL.
    const later = openSqliteDatabase(file);
    expect(later.pragma("journal_mode", { simple: true })).toBe("wal");
    later.close();
  });

  it("la base queda lista para migrar", () => {
    const file = join(dir, "app.db");
    const db = openSqliteDatabase(file, { wal: true });

    expect(hasUnioraSchema(db)).toBe(false);
    applyMigrations(db);
    expect(hasUnioraSchema(db)).toBe(true);
    db.close();
  });

  it("fileMustExist: falla sin crear nada cuando el archivo no existe", () => {
    const file = join(dir, "missing.db");

    expect(() => openSqliteDatabase(file, { fileMustExist: true })).toThrow();

    expect(existsSync(file)).toBe(false);
  });

  it("wal y readonly son incompatibles", () => {
    expect(() => openSqliteDatabase(join(dir, "x.db"), { wal: true, readonly: true })).toThrow(/readonly/);
  });

  it("readonly: no puede escribir ni siquiera por error", () => {
    const file = join(dir, "app.db");
    const writable = openSqliteDatabase(file);
    applyMigrations(writable);
    writable.close();

    const db = openSqliteDatabase(file, { readonly: true });
    expect(hasUnioraSchema(db)).toBe(true);
    expect(() => db.exec("insert into uniora_organizations (id, name, slug) values ('x', 'X', 'x')")).toThrow(/readonly/i);
    db.close();
  });
});
