import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../cli/main.js";
import { runMigrate } from "./migrate.js";
import { parsePlatformIdentity, runPlatform } from "./platform.js";

describe("uniora platform (sqlite)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "uniora-cli-platform-"));
    mkdirSync(join(dir, "data"));
    writeFileSync(join(dir, "uniora.config.mjs"), 'export default { database: { provider: "sqlite", url: "sqlite:./data/uniora.db" } };\n');
    process.exitCode = undefined;
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  async function json(run: () => Promise<void>): Promise<Record<string, any>> {
    vi.mocked(console.log).mockClear();
    process.exitCode = undefined;
    await run();
    return JSON.parse(vi.mocked(console.log).mock.calls.flat().join("\n")) as Record<string, any>;
  }

  it("parses provider:subject, splitting at the first colon", () => {
    expect(parsePlatformIdentity("supabase:abc:def")).toEqual({ provider: "supabase", subject: "abc:def" });
    for (const bad of ["", "x", ":y", "x:", " : "]) expect(() => parsePlatformIdentity(bad)).toThrow(/proveedor:sujeto/);
  });

  it("asks to migrate first, initialises once, and refuses a second time", async () => {
    await json(() => runMigrate(dir, { json: true }));
    const empty = await json(() => runPlatform("status", dir, { json: true }));
    expect(empty).toMatchObject({ ok: true, initialised: false, members: 0 });

    const init = await json(() => runPlatform("init", dir, { json: true, admin: "supabase:user-1" }));
    expect(init).toMatchObject({ ok: true });
    expect(init.memberId).toBeTypeOf("string");

    const status = await json(() => runPlatform("status", dir, { json: true }));
    expect(status).toMatchObject({ ok: true, initialised: true, members: 1, activeAdmins: 1 });

    const again = await json(() => runPlatform("init", dir, { json: true, admin: "supabase:user-2" }));
    expect(again.ok).toBe(false);
    expect(process.exitCode).toBe(1);
  });

  it("validates its usage through the main CLI", async () => {
    await runCli(["platform", "nope"], dir);
    expect(process.exitCode).toBe(2);
    process.exitCode = undefined;
    await runCli(["platform", "init"], dir);
    expect(process.exitCode).toBe(2);
    process.exitCode = undefined;
    await runCli(["platform", "status", "--admin", "a:b"], dir);
    expect(process.exitCode).toBe(2);
    process.exitCode = undefined;
    await runCli(["platform", "init", "extra", "--admin", "a:b"], dir);
    expect(process.exitCode).toBe(2);
  });
});
