import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCheck } from "./check.js";

describe("runCheck", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "uniora-cli-check-"));
    process.exitCode = undefined;
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it("falla (exitCode 1) si no hay archivo de configuración, sin intentar conectarse a nada", async () => {
    await runCheck(dir);
    expect(process.exitCode).toBe(1);
  });

  it("falla (exitCode 1) sin filtrar la connection string cuando la conexión falla", async () => {
    const connectionString = "postgresql://u:p@127.0.0.1:1/db";
    writeFileSync(
      join(dir, "uniora.config.mjs"),
      `export default { database: { provider: "postgresql", url: ${JSON.stringify(connectionString)} } };\n`,
    );

    await runCheck(dir);

    expect(process.exitCode).toBe(1);
    const output = [...vi.mocked(console.error).mock.calls, ...vi.mocked(console.log).mock.calls].flat().join("\n");
    expect(output).not.toContain(connectionString);
    expect(output).not.toContain(":p@");
  });

  it.skipIf(!process.env.DATABASE_URL)(
    "valida la config y conecta a una base de datos real cuando DATABASE_URL está disponible",
    async () => {
      writeFileSync(
        join(dir, "uniora.config.mjs"),
        'export default { database: { provider: "postgresql", url: process.env.DATABASE_URL } };\n',
      );

      await runCheck(dir);

      expect(process.exitCode).toBeUndefined();
    },
  );
});
