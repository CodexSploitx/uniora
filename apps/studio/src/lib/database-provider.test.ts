import { describe, expect, it } from "vitest";
import { databaseProviderLabel, parseDatabaseProvider } from "./database-provider";

describe("parseDatabaseProvider", () => {
  it("sin valor es postgresql (compatibilidad con un CLI anterior a SQLite)", () => {
    expect(parseDatabaseProvider(undefined)).toBe("postgresql");
    expect(parseDatabaseProvider("")).toBe("postgresql");
  });

  it("acepta los proveedores conocidos", () => {
    expect(parseDatabaseProvider("postgresql")).toBe("postgresql");
    expect(parseDatabaseProvider("sqlite")).toBe("sqlite");
  });

  it("rechaza cualquier otro valor en vez de adivinar", () => {
    expect(() => parseDatabaseProvider("mysql")).toThrow(/Unsupported/);
    expect(() => parseDatabaseProvider("SQLITE")).toThrow(/Unsupported/);
    expect(() => parseDatabaseProvider("postgres")).toThrow(/Unsupported/);
  });
});

describe("databaseProviderLabel", () => {
  it("da el nombre que se muestra en la cabecera", () => {
    expect(databaseProviderLabel("postgresql")).toBe("PostgreSQL");
    expect(databaseProviderLabel("sqlite")).toBe("SQLite");
  });
});
