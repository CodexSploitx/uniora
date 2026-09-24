import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UnioraConfigError } from "./validate.js";
import { loadConfig } from "./loader.js";

describe("loadConfig", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "uniora-cli-loader-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("lanza UnioraConfigError si no hay uniora.config.mjs/.js en el directorio", async () => {
    await expect(loadConfig(dir)).rejects.toThrow(UnioraConfigError);
  });

  it("carga y valida un uniora.config.mjs válido", async () => {
    writeFileSync(
      join(dir, "uniora.config.mjs"),
      'export default { database: { provider: "postgresql", url: "postgresql://u:p@host/db" } };\n',
    );

    await expect(loadConfig(dir)).resolves.toEqual({
      database: { provider: "postgresql", url: "postgresql://u:p@host/db" },
    });
  });

  it("propaga el error de validación cuando la config tiene forma inválida", async () => {
    writeFileSync(join(dir, "uniora.config.mjs"), "export default { database: { provider: \"mysql\" } };\n");

    await expect(loadConfig(dir)).rejects.toThrow(/no soportado/);
  });

  it("carga .env del mismo directorio antes de importar la config, sin asumir un valor por defecto", async () => {
    const marker = `UNIORA_LOADER_TEST_URL_${Date.now()}`;
    writeFileSync(join(dir, ".env"), `${marker}=postgresql://u:p@host/from-env\n`);
    writeFileSync(
      join(dir, "uniora.config.mjs"),
      `export default { database: { provider: "postgresql", url: process.env.${marker} } };\n`,
    );

    await expect(loadConfig(dir)).resolves.toEqual({
      database: { provider: "postgresql", url: "postgresql://u:p@host/from-env" },
    });
  });

  describe("--env", () => {
    const writeConfig = (marker: string) =>
      writeFileSync(
        join(dir, "uniora.config.mjs"),
        `export default { database: { provider: "postgresql", url: process.env.${marker} } };\n`,
      );

    it("carga .env.<nombre> y NO el .env de desarrollo", async () => {
      const marker = `UNIORA_ENV_TEST_A_${Date.now()}`;
      writeFileSync(join(dir, ".env"), `${marker}=postgresql://u:p@dev-host/dev\n`);
      writeFileSync(join(dir, ".env.production"), `${marker}=postgresql://u:p@prod-host/prod\n`);
      writeConfig(marker);

      await expect(loadConfig(dir, { envName: "production" })).resolves.toMatchObject({
        database: { url: "postgresql://u:p@prod-host/prod" },
      });
      delete process.env[marker];
    });

    it("falla si .env.<nombre> no existe, sin caer en silencio al .env (base equivocada)", async () => {
      const marker = `UNIORA_ENV_TEST_B_${Date.now()}`;
      writeFileSync(join(dir, ".env"), `${marker}=postgresql://u:p@dev-host/dev\n`);
      writeConfig(marker);

      await expect(loadConfig(dir, { envName: "production" })).rejects.toThrow(/No existe \.env\.production/);
    });

    it("rechaza nombres de entorno que escapan del directorio", async () => {
      await expect(loadConfig(dir, { envName: "../secrets" })).rejects.toThrow(UnioraConfigError);
      await expect(loadConfig(dir, { envName: "a/b" })).rejects.toThrow(UnioraConfigError);
    });
  });

  describe("--config", () => {
    it("carga el archivo indicado en vez de buscar uniora.config.mjs", async () => {
      writeFileSync(
        join(dir, "staging.config.mjs"),
        'export default { database: { provider: "postgresql", url: "postgresql://u:p@staging/db" } };\n',
      );

      await expect(loadConfig(dir, { configPath: "staging.config.mjs" })).resolves.toMatchObject({
        database: { url: "postgresql://u:p@staging/db" },
      });
    });

    it("falla si el archivo no existe (no busca otro en su lugar) o no es .mjs/.js", async () => {
      writeFileSync(
        join(dir, "uniora.config.mjs"),
        'export default { database: { provider: "postgresql", url: "postgresql://u:p@x/db" } };\n',
      );

      await expect(loadConfig(dir, { configPath: "missing.config.mjs" })).rejects.toThrow(/No existe el archivo/);
      await expect(loadConfig(dir, { configPath: "config.json" })).rejects.toThrow(/\.mjs o \.js/);
    });
  });
});
