import { describe, expect, it } from "vitest";
import { UnioraConfigError, validateConfig } from "./validate.js";

const SOURCE = "uniora.config.mjs";

describe("validateConfig", () => {
  it("acepta una configuración válida mínima", () => {
    expect(
      validateConfig({ database: { provider: "postgresql", url: "postgresql://u:p@host/db" } }, SOURCE),
    ).toEqual({ database: { provider: "postgresql", url: "postgresql://u:p@host/db" } });
  });

  it("acepta una configuración válida con auth", () => {
    expect(
      validateConfig(
        { database: { provider: "postgresql", url: "postgresql://u:p@host/db" }, auth: { provider: "supabase" } },
        SOURCE,
      ),
    ).toEqual({
      database: { provider: "postgresql", url: "postgresql://u:p@host/db" },
      auth: { provider: "supabase" },
    });
  });

  it("rechaza un export default que no es un objeto", () => {
    expect(() => validateConfig(null, SOURCE)).toThrow(UnioraConfigError);
    expect(() => validateConfig("postgresql", SOURCE)).toThrow(UnioraConfigError);
    expect(() => validateConfig(undefined, SOURCE)).toThrow(UnioraConfigError);
  });

  it("rechaza cuando falta database", () => {
    expect(() => validateConfig({}, SOURCE)).toThrow(/falta "database"/);
  });

  it("rechaza un proveedor de base de datos no soportado", () => {
    expect(() => validateConfig({ database: { provider: "mysql", url: "x" } }, SOURCE)).toThrow(
      /no soportado/,
    );
  });

  it("rechaza un provider que no es string (confusión de tipos)", () => {
    // El primer parámetro de validateConfig es `unknown` a propósito: no hay
    // error de TS que suprimir aquí, el punto es que el chequeo es en runtime.
    expect(() => validateConfig({ database: { provider: 123, url: "x" } }, SOURCE)).toThrow(
      UnioraConfigError,
    );
  });

  it("rechaza database.url vacío o ausente", () => {
    expect(() => validateConfig({ database: { provider: "postgresql", url: "" } }, SOURCE)).toThrow(
      /url" debe ser un string no vacío/,
    );
    expect(() => validateConfig({ database: { provider: "postgresql" } }, SOURCE)).toThrow(
      /url" debe ser un string no vacío/,
    );
  });

  it("rechaza auth.provider inválido cuando auth está presente", () => {
    expect(() =>
      validateConfig({ database: { provider: "postgresql", url: "x" }, auth: {} }, SOURCE),
    ).toThrow(/auth.provider/);

    expect(() =>
      validateConfig({ database: { provider: "postgresql", url: "x" }, auth: "supabase" }, SOURCE),
    ).toThrow(/auth.provider/);
  });
});
