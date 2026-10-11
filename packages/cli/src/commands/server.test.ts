import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunningServer } from "@uniora/server";
import { runCli } from "../cli/main.js";
import { runServer } from "./server.js";

describe("uniora server (SQLite)", () => {
  let dir: string;
  let lines: string[];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "uniora-cli-server-"));
    mkdirSync(join(dir, "data"));
    writeFileSync(join(dir, "uniora.config.mjs"), 'export default { database: { provider: "sqlite", url: "sqlite:./data/uniora.db" } };\n');
    process.exitCode = undefined;
    lines = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => void lines.push(args.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void lines.push(args.join(" ")));
    await runCli(["migrate", "--json"], dir);
    lines.length = 0;
    process.exitCode = undefined;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  async function run(...argv: string[]): Promise<Record<string, any>> {
    lines.length = 0;
    process.exitCode = undefined;
    await runCli(["server", ...argv, "--json"], dir);
    return JSON.parse(lines.join("\n"));
  }

  it("creates a client, a key (shown once), lists, rotates and revokes", async () => {
    const created = await run("clients", "create", "--name", "signup-worker", "--scopes", "check,organizations:read", "--orgs", "*");
    expect(created.ok).toBe(true);
    const clientId = created.client.id as string;

    const key = await run("keys", "create", "--client", "signup-worker");
    expect(key.token).toMatch(/^uniora_sk_/);

    const listed = await run("clients", "list");
    expect(listed.clients[0]).toMatchObject({ name: "signup-worker", status: "active", organizations: "*" });
    expect(listed.clients[0].keys).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(key.token);
    expect(JSON.stringify(listed)).not.toContain(key.token.slice(-20));

    const shown = await run("clients", "show", clientId);
    expect(shown.client.keys[0]).toMatchObject({ id: key.keyId, status: "active" });

    const second = await run("keys", "create", "--client", clientId, "--expires-in-days", "30");
    expect(second.ok).toBe(true);
    const third = await run("keys", "create", "--client", clientId);
    expect(third.ok).toBe(false); // at most two active keys: rotate by revoking the old one first
    expect(process.exitCode).toBe(1);

    const revoked = await run("keys", "revoke", key.keyId);
    expect(revoked.ok).toBe(true);
    expect((await run("keys", "create", "--client", clientId)).ok).toBe(true);

    const disabled = await run("clients", "disable", "signup-worker");
    expect(disabled.client.status).toBe("disabled");
    const updated = await run("clients", "update", clientId, "--scopes", "check", "--orgs", "org_a,org_b");
    expect(updated.client).toMatchObject({ scopes: ["check"], organizations: ["org_a", "org_b"] });
  });

  it("prints the key alone on its own line in human mode", async () => {
    await run("clients", "create", "--name", "c", "--scopes", "check", "--orgs", "*");
    lines.length = 0;
    await runCli(["server", "keys", "create", "--client", "c"], dir);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(/^uniora_sk_/);
    expect(lines[0]).not.toContain("uniora_sk_");
  });

  it("refuses bad input before touching the database", async () => {
    const bad = async (...argv: string[]) => {
      lines.length = 0;
      process.exitCode = undefined;
      await runCli(["server", ...argv], dir);
      return process.exitCode;
    };
    expect(await bad("clients", "create", "--name", "x", "--scopes", "nope", "--orgs", "*")).toBe(2);
    expect(await bad("clients", "create", "--name", "x", "--scopes", "check")).toBe(2);
    expect(await bad("clients", "create", "--name", "x", "--scopes", "check", "--orgs", "*,org_a")).toBe(2);
    expect(await bad("clients", "show")).toBe(2);
    expect(await bad("keys", "create")).toBe(2);
    expect(await bad("keys", "create", "--client", "c", "--expires-in-days", "9999")).toBe(2);
    expect(await bad("clients", "list", "--scopes", "check")).toBe(2);
    expect(await bad("nope")).toBe(2);
    expect(await bad("clients", "create", "--name", "x", "--scopes", "check", "--orgs", "*", "--port", "1")).toBe(2);
  });

  it("refuses to run before the migrations", async () => {
    const empty = mkdtempSync(join(tmpdir(), "uniora-cli-server-empty-"));
    try {
      writeFileSync(join(empty, "uniora.config.mjs"), 'export default { database: { provider: "sqlite", url: "sqlite:./fresh.db" } };\n');
      lines.length = 0;
      await runCli(["server", "clients", "list", "--json"], empty);
      expect(JSON.parse(lines.join("\n")).ok).toBe(false);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("start serves the API with the keys it manages, and stops cleanly", async () => {
    await run("clients", "create", "--name", "web", "--scopes", "check,organizations:read", "--orgs", "*");
    const { token } = await run("keys", "create", "--client", "web");

    const abort = new AbortController();
    const running = new Promise<RunningServer>((resolve, reject) => {
      runServer(["start"], dir, { json: true, port: "0", onStarted: resolve, stop: abort.signal }).catch(reject);
    });
    const server = await running;
    try {
      expect((await fetch(`${server.url}/healthz`)).status).toBe(200);
      expect((await fetch(`${server.url}/v1/organizations`)).status).toBe(401);
      const ok = await fetch(`${server.url}/v1/organizations`, { headers: { authorization: `Bearer ${token}` } });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ items: [], nextCursor: null });
    } finally {
      abort.abort();
    }
  });

  it("start takes tokens, the platform and webhooks from the config file", async () => {
    writeFileSync(
      join(dir, "full.config.mjs"),
      `export default {
        database: { provider: "sqlite", url: "sqlite:./data/uniora.db" },
        server: {
          defaultProvider: "main",
          actorTokens: [{ provider: "staff", issuer: "https://staff.example.com/", audience: "uniora", algorithms: ["HS256"], secret: "0123456789abcdef0123456789abcdef-secret" }],
          platform: { providers: ["staff"], stepUp: { maxAgeSeconds: 120 } },
          webhooks: { run: false },
          sharedRateLimit: true,
        },
      };\n`,
    );
    await run("clients", "create", "--name", "panel", "--scopes", "platform:admin", "--orgs", "*");
    const { token } = await run("keys", "create", "--client", "panel");
    const abort = new AbortController();
    const running = new Promise<RunningServer>((resolve, reject) => {
      runServer(["start"], dir, { json: true, port: "0", configPath: "full.config.mjs", onStarted: resolve, stop: abort.signal }).catch(reject);
    });
    const server = await running;
    try {
      expect(lines.join("\n")).toContain("plataforma");
      expect(lines.join("\n")).toContain("webhooks");
      // The platform routes exist and want the operator's own token; the key alone is not enough.
      const keyAlone = await fetch(`${server.url}/v1/platform/roles`, { headers: { authorization: `Bearer ${token}` } });
      expect(keyAlone.status).toBe(403);
      expect(((await keyAlone.json()) as { code: string }).code).toBe("actor_token_required");
      const bad = await fetch(`${server.url}/v1/platform/roles`, { headers: { authorization: `Bearer ${token}`, "uniora-actor-token": "nope" } });
      expect(bad.status).toBe(401);
    } finally {
      abort.abort();
    }
  });

  it("start refuses a server section that makes no sense, naming the option", async () => {
    writeFileSync(
      join(dir, "bad.config.mjs"),
      `export default { database: { provider: "sqlite", url: "sqlite:./data/uniora.db" }, server: { platform: { providers: ["nobody"] } } };\n`,
    );
    lines.length = 0;
    process.exitCode = undefined;
    await runCli(["server", "start", "--port", "0", "--config", "bad.config.mjs", "--json"], dir);
    const report = JSON.parse(lines.join("\n"));
    expect(report.ok).toBe(false);
    expect(JSON.stringify(report)).toMatch(/platform|actorTokens/);
    writeFileSync(join(dir, "typo.config.mjs"), `export default { database: { provider: "sqlite", url: "sqlite:./data/uniora.db" }, server: { platfrom: {} } };\n`);
    lines.length = 0;
    await runCli(["server", "start", "--port", "0", "--config", "typo.config.mjs", "--json"], dir);
    expect(JSON.stringify(JSON.parse(lines.join("\n")))).toContain("server.platfrom");
  });

  it("start refuses a public interface without TLS", async () => {
    lines.length = 0;
    process.exitCode = undefined;
    await runCli(["server", "start", "--host", "0.0.0.0", "--port", "0", "--json"], dir);
    const report = JSON.parse(lines.join("\n"));
    expect(report.ok).toBe(false);
    expect(JSON.stringify(report)).toMatch(/TLS/);
  });

  it("looking and refusing never create the database: a path typo leaves nothing behind", async () => {
    const fresh = mkdtempSync(join(tmpdir(), "uniora-cli-server-fresh-"));
    try {
      writeFileSync(join(fresh, "uniora.config.mjs"), 'export default { database: { provider: "sqlite", url: "sqlite:./typo/uniora.db" } };\n');
      for (const argv of [["server", "clients", "create", "--name", "x", "--scopes", "check", "--orgs", "*", "--json"], ["server", "keys", "revoke", "k", "--json"], ["server", "start", "--port", "0", "--json"]]) {
        lines.length = 0;
        process.exitCode = undefined;
        await runCli(argv, fresh);
        expect(JSON.parse(lines.join("\n")).ok).toBe(false);
      }
      expect(existsSync(join(fresh, "typo"))).toBe(false);
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });

  it("refuses a port that is not plain digits", async () => {
    for (const port of [" ", "0x50", "1e3", "-1", "８０"]) {
      process.exitCode = undefined;
      await runCli(["server", "start", "--port", port], dir);
      expect(process.exitCode, port).toBe(2);
    }
  });

  it("finds a client by its name whatever the spacing and case, and counts only keys that work", async () => {
    await run("clients", "create", "--name", "Web  App", "--scopes", "check", "--orgs", "*");
    const found = await run("clients", "show", "  web app  ");
    expect(found.ok).toBe(true);
    const key = await run("keys", "create", "--client", "WEB APP");
    expect(key.ok).toBe(true);
    await run("keys", "revoke", key.keyId);
    const listed = await run("clients", "list");
    expect(listed.checks[0].message).toContain("0 clave(s) activa(s)");
  });
});
