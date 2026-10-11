import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyWebhook } from "@uniora/core";
import { runCli } from "../cli/main.js";
import { runWebhooks } from "./webhooks.js";

const CONFIG = `export default {
  database: { provider: "sqlite", url: "sqlite:./data/uniora.db" },
  server: { webhooks: { urlPolicy: { allowInsecureHttp: true, allowPrivateNetworks: true }, pollIntervalMs: 20 } },
};
`;

describe("uniora webhooks (SQLite)", () => {
  let dir: string;
  let lines: string[];
  const closers: (() => Promise<void> | void)[] = [];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "uniora-cli-webhooks-"));
    mkdirSync(join(dir, "data"));
    writeFileSync(join(dir, "uniora.config.mjs"), CONFIG);
    process.exitCode = undefined;
    lines = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => void lines.push(args.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void lines.push(args.join(" ")));
    await runCli(["migrate", "--json"], dir);
    lines.length = 0;
    process.exitCode = undefined;
  });

  afterEach(async () => {
    while (closers.length > 0) await closers.pop()!();
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  async function run(...argv: string[]): Promise<Record<string, any>> {
    lines.length = 0;
    process.exitCode = undefined;
    await runCli(["webhooks", ...argv, "--json"], dir);
    return JSON.parse(lines.join("\n"));
  }

  async function receiver() {
    const received: { body: string; headers: IncomingMessage["headers"] }[] = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        received.push({ body: Buffer.concat(chunks).toString("utf8"), headers: request.headers });
        response.writeHead(204).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    closers.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
    return { received, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook` };
  }

  it("creates an endpoint (the secret is shown once), lists, shows, updates, disables, rotates and deletes", async () => {
    const target = await receiver();
    const created = await run("create", "--url", target.url, "--events", "membership.*,role.*", "--orgs", "org_a,org_b", "--description", "Billing sync");
    expect(created.ok).toBe(true);
    expect(created.secret).toMatch(/^whsec_/);
    const id = created.endpoint.id as string;
    expect(created.endpoint).toMatchObject({ status: "enabled", events: ["membership.*", "role.*"], organizations: ["org_a", "org_b"], description: "Billing sync" });

    const listed = await run("list");
    expect(listed.endpoints).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(created.secret);
    // The URL (it can carry a secret in its path) is not repeated in the human lines of the list.
    expect(listed.checks[0].message).not.toContain("/hook");

    const shown = await run("show", id);
    expect(shown.deliveries).toMatchObject({ pending: 0, dead: 0 });
    expect(JSON.stringify(shown)).not.toContain(created.secret);

    expect((await run("update", id, "--events", "*", "--orgs", "*")).endpoint).toMatchObject({ events: ["*"], organizations: "*" });
    expect((await run("disable", id, "--reason", "maintenance")).endpoint).toMatchObject({ status: "disabled", disabledReason: "maintenance" });
    expect((await run("enable", id)).endpoint.status).toBe("enabled");

    const rotated = await run("rotate-secret", id, "--grace-seconds", "60");
    expect(rotated.secret).toMatch(/^whsec_/);
    expect(rotated.secret).not.toBe(created.secret);

    expect((await run("delete", id)).ok).toBe(true);
    expect((await run("list")).endpoints).toHaveLength(0);
    expect((await run("show", id)).ok).toBe(false);
  });

  it("prints the secret alone on its own line in human mode", async () => {
    const target = await receiver();
    lines.length = 0;
    await runCli(["webhooks", "create", "--url", target.url, "--events", "*"], dir);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(/^whsec_/);
    expect(lines[0]).not.toContain("whsec_");
  });

  it("refuses an unsafe URL unless the config allows it", async () => {
    // A config module is imported once per path, so the strict one is a different file.
    writeFileSync(join(dir, "strict.config.mjs"), 'export default { database: { provider: "sqlite", url: "sqlite:./data/uniora.db" } };\n');
    for (const url of ["http://hooks.example.com/", "https://127.0.0.1/", "https://169.254.169.254/x"]) {
      const result = await run("create", "--url", url, "--events", "*", "--config", "strict.config.mjs");
      expect(result.ok, url).toBe(false);
      expect(JSON.stringify(result)).toContain("webhook_url_invalid");
    }
  });

  it("sends a signed test event", async () => {
    const target = await receiver();
    const created = await run("create", "--url", target.url, "--events", "*");
    const tested = await run("test", created.endpoint.id);
    expect(tested).toMatchObject({ ok: true, httpStatus: 204 });
    const { body, headers } = target.received[0]!;
    expect(JSON.parse(body).type).toBe("webhook.test");
    expect(verifyWebhook({ body, headers: { id: headers["webhook-id"] as string, timestamp: headers["webhook-timestamp"] as string, signature: headers["webhook-signature"] as string }, secrets: created.secret })).toBe(true);
  });

  it("run --once moves the outbox events of the database to the endpoints", async () => {
    const target = await receiver();
    const created = await run("create", "--url", target.url, "--events", "membership.*");
    // An event written by anything that uses the database (a Studio change, an API call): here, straight into the outbox.
    const { openSqliteDatabase, createSqliteStorage } = await import("@uniora/sqlite");
    const db = openSqliteDatabase(join(dir, "data", "uniora.db"));
    await createSqliteStorage(db).outbox.enqueue({ id: "evt_1", type: "membership.blocked", organizationId: "org_a", payload: { membershipId: "m1" } });
    db.close();
    const ran = await run("run", "--once");
    expect(ran).toMatchObject({ ok: true, fannedOut: 1, delivered: 1, failed: 0 });
    expect(JSON.parse(target.received[0]!.body)).toMatchObject({ id: "evt_1", type: "membership.blocked", organizationId: "org_a" });
    const deliveries = await run("deliveries", "--endpoint", created.endpoint.id);
    expect(deliveries.deliveries[0]).toMatchObject({ eventId: "evt_1", status: "delivered", lastHttpStatus: 204 });
  });

  it("run keeps going until stopped", async () => {
    const target = await receiver();
    await run("create", "--url", target.url, "--events", "*");
    const { openSqliteDatabase, createSqliteStorage } = await import("@uniora/sqlite");
    const db = openSqliteDatabase(join(dir, "data", "uniora.db"));
    const abort = new AbortController();
    const done = runWebhooks(["run"], dir, { json: true, stop: abort.signal });
    await createSqliteStorage(db).outbox.enqueue({ id: "evt_1", type: "a.b", payload: {} });
    const started = Date.now();
    while (target.received.length === 0 && Date.now() - started < 5000) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(target.received).toHaveLength(1);
    abort.abort();
    await done;
    db.close();
  });

  it("refuses bad input before touching the database", async () => {
    const bad = async (...argv: string[]) => {
      lines.length = 0;
      process.exitCode = undefined;
      await runCli(["webhooks", ...argv], dir);
      return process.exitCode;
    };
    expect(await bad()).toBe(2);
    expect(await bad("nope")).toBe(2);
    expect(await bad("create", "--events", "*")).toBe(2);
    expect(await bad("create", "--url", "https://x.example.com/")).toBe(2);
    expect(await bad("create", "--url", "https://x.example.com/", "--events", "a,,b")).toBe(2);
    expect(await bad("create", "--url", "https://x.example.com/", "--events", "*", "--orgs", "*,org_a")).toBe(2);
    expect(await bad("show")).toBe(2);
    expect(await bad("update", "whe_x")).toBe(2);
    expect(await bad("list", "whe_x")).toBe(2);
    expect(await bad("list", "--url", "https://x.example.com/")).toBe(2);
    expect(await bad("rotate-secret", "whe_x", "--grace-seconds", "999999999")).toBe(2);
    expect(await bad("deliveries", "--status", "nope")).toBe(2);
    expect(await bad("enable", "whe_x", "--reason", "x")).toBe(2);
  });

  it("refuses to run before the migrations", async () => {
    const empty = mkdtempSync(join(tmpdir(), "uniora-cli-webhooks-empty-"));
    try {
      writeFileSync(join(empty, "uniora.config.mjs"), 'export default { database: { provider: "sqlite", url: "sqlite:./fresh.db" } };\n');
      lines.length = 0;
      await runCli(["webhooks", "list", "--json"], empty);
      expect(JSON.parse(lines.join("\n")).ok).toBe(false);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
