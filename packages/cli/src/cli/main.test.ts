import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./main.js";

function logged(): string {
  return vi.mocked(console.log).mock.calls.flat().join("\n");
}

describe("runCli", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "uniora-cli-main-"));
    process.exitCode = undefined;
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it("sin argumentos y con --help muestra la ayuda y sale 0", async () => {
    await runCli([], dir);
    await runCli(["--help"], dir);
    expect(logged()).toContain("Uso: uniora <comando>");
    expect(process.exitCode).toBeUndefined();
  });

  it("--version imprime la versión del paquete", async () => {
    await runCli(["--version"], dir);
    expect(logged()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("cada comando tiene su propia ayuda", async () => {
    await runCli(["migrate", "--help"], dir);
    expect(logged()).toContain("--dry-run");
    expect(process.exitCode).toBeUndefined();
  });

  it("un comando o flag desconocido sale con 2 (uso), distinto de 1 (falló algo)", async () => {
    await runCli(["nope"], dir);
    expect(process.exitCode).toBe(2);

    process.exitCode = undefined;
    await runCli(["check", "--bogus"], dir);
    expect(process.exitCode).toBe(2);
  });

  it("con --json un error de uso también es JSON parseable", async () => {
    await runCli(["check", "--bogus", "--json"], dir);
    expect(process.exitCode).toBe(2);
    expect(JSON.parse(logged())).toMatchObject({ ok: false });
  });

  it("rechaza --status y --dry-run juntos, un --env con path traversal y --json en studio", async () => {
    await runCli(["migrate", "--status", "--dry-run"], dir);
    expect(process.exitCode).toBe(2);

    process.exitCode = undefined;
    await runCli(["check", "--env", "../../etc/passwd"], dir);
    expect(process.exitCode).toBe(2);

    process.exitCode = undefined;
    await runCli(["studio", "--json"], dir);
    expect(process.exitCode).toBe(2);
  });

  it("--json emite un único objeto JSON (y sale 1 si falla), sin mezclar texto", async () => {
    await runCli(["check", "--json"], dir); // sin config → fail
    expect(process.exitCode).toBe(1);
    const calls = vi.mocked(console.log).mock.calls;
    expect(calls).toHaveLength(1);
    expect(JSON.parse(String(calls[0]?.[0]))).toMatchObject({
      ok: false,
      command: "check",
      checks: [{ name: "Configuración", severity: "fail" }],
    });
  });

  it("--json nunca incluye la connection string", async () => {
    const url = "postgresql://user:s3cret@127.0.0.1:1/db";
    writeFileSync(
      join(dir, "uniora.config.mjs"),
      `export default { database: { provider: "postgresql", url: ${JSON.stringify(url)} } };\n`,
    );

    for (const command of [["check"], ["doctor"], ["migrate", "--status"], ["migrate"]]) {
      vi.mocked(console.log).mockClear();
      await runCli([...command, "--json"], dir);
      expect(logged()).not.toContain("s3cret");
      expect(logged()).not.toContain(url);
    }
  });

  it("init --json informa los archivos creados", async () => {
    await runCli(["init", "--json"], dir);
    const output = JSON.parse(logged());
    expect(output.ok).toBe(true);
    expect(output.files.map((file: { status: string }) => file.status)).toEqual(["created", "created", "created"]);
  });
});
