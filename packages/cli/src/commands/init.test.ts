import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runInit } from "./init.js";

describe("runInit", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "uniora-cli-init-"));
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("crea uniora.config.mjs, .env.example y .gitignore en un directorio vacío", () => {
    runInit(dir);

    expect(existsSync(join(dir, "uniora.config.mjs"))).toBe(true);
    expect(existsSync(join(dir, ".env.example"))).toBe(true);
    expect(existsSync(join(dir, ".gitignore"))).toBe(true);
  });

  it("nunca hardcodea una URL real: el config usa process.env.DATABASE_URL y el .env.example es un placeholder genérico", () => {
    runInit(dir);

    const config = readFileSync(join(dir, "uniora.config.mjs"), "utf8");
    expect(config).toContain("process.env.DATABASE_URL");
    expect(config).not.toMatch(/url:\s*["'`]postgres/);

    const envExample = readFileSync(join(dir, ".env.example"), "utf8");
    expect(envExample).toContain("DATABASE_URL=postgresql://user:password@localhost:5432/database");
  });

  it("añade .env y .env.*.local a un .gitignore existente sin borrar su contenido", () => {
    writeFileSync(join(dir, ".gitignore"), "node_modules/\ndist/\n");

    runInit(dir);

    const gitignore = readFileSync(join(dir, ".gitignore"), "utf8");
    expect(gitignore).toContain("node_modules/");
    expect(gitignore).toContain("dist/");
    expect(gitignore).toContain(".env");
    expect(gitignore).toContain(".env.*.local");
  });

  it("nunca sobrescribe uniora.config.mjs existente sin --force (skill §58: mutación destructiva requiere opt-in)", () => {
    const customContent = "export default { database: { provider: \"postgresql\", url: \"custom\" } };\n";
    writeFileSync(join(dir, "uniora.config.mjs"), customContent);

    runInit(dir);

    expect(readFileSync(join(dir, "uniora.config.mjs"), "utf8")).toBe(customContent);
  });

  it("sobrescribe uniora.config.mjs solo cuando se pasa force: true explícitamente", () => {
    const customContent = "export default { database: { provider: \"postgresql\", url: \"custom\" } };\n";
    writeFileSync(join(dir, "uniora.config.mjs"), customContent);

    runInit(dir, { force: true });

    const updated = readFileSync(join(dir, "uniora.config.mjs"), "utf8");
    expect(updated).not.toBe(customContent);
    expect(updated).toContain("process.env.DATABASE_URL");
  });

  it("tampoco sobrescribe .env.example existente sin --force", () => {
    const customContent = "DATABASE_URL=already-set-by-developer\n";
    writeFileSync(join(dir, ".env.example"), customContent);

    runInit(dir);

    expect(readFileSync(join(dir, ".env.example"), "utf8")).toBe(customContent);
  });
});
