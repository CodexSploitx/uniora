import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { bootstrapPlatform, createMemoryPlatformStorage, createMemoryStorage, createPlatformEngine, createPlatformService } from "@uniora/core";
import { platformCommand, requirePlatformPermission } from "./platform.js";

const root = { provider: "p", subject: "root" };
const intruder = { provider: "p", subject: "intruder" };

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

async function serve() {
  const storage = createMemoryStorage();
  const platform = createMemoryPlatformStorage({ auditLogs: storage.auditLogs });
  await bootstrapPlatform({ platform, admin: root });
  const service = createPlatformService({ platform, storage });
  const resolve = (req: { header(name: string): string | undefined }) => {
    const who = req.header("x-test-user");
    return who === "root" ? { actor: root } : who === "intruder" ? { actor: intruder } : null;
  };
  const app = express();
  app.use(express.json());
  app.post("/admin/roles", platformCommand(service, { command: "createRole", resolve }));
  app.get("/admin/secret", requirePlatformPermission(createPlatformEngine(platform), { permission: "platform.billing.refund", resolve }), (_req, res) => {
    res.json({ ok: true });
  });
  const server = await new Promise<Server>((res) => {
    const s = app.listen(0, "127.0.0.1", () => res(s));
  });
  servers.push(server);
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const call = (url: string, user: string | null, init: { method?: string; body?: unknown } = {}) =>
  fetch(url, {
    method: init.method ?? "POST",
    headers: { "content-type": "application/json", ...(user ? { "x-test-user": user } : {}) },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });

describe("platformCommand / requirePlatformPermission", () => {
  it("answers 401 without a caller and 403 (never why) to someone without platform power", async () => {
    const { base } = await serve();
    expect((await call(`${base}/admin/roles`, null, { body: { key: "support", name: "Support", permissions: [] } })).status).toBe(401);
    const denied = await call(`${base}/admin/roles`, "intruder", { body: { key: "support", name: "Support", permissions: [] } });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: "forbidden", message: "You are not allowed to do that." });
  });

  it("lets a platform administrator run the command, and rejects smuggled fields", async () => {
    const { base } = await serve();
    const ok = await call(`${base}/admin/roles`, "root", { body: { key: "support", name: "Support", permissions: ["platform.audit.read"] } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ key: "support", permissions: ["platform.audit.read"] });
    expect((await call(`${base}/admin/roles`, "root", { body: { key: "x_role", name: "X", permissions: [], actor: intruder } })).status).toBe(400);
  });

  it("guards your own routes with a platform permission", async () => {
    const { base } = await serve();
    expect((await call(`${base}/admin/secret`, null, { method: "GET" })).status).toBe(401);
    expect((await call(`${base}/admin/secret`, "intruder", { method: "GET" })).status).toBe(403);
    expect((await call(`${base}/admin/secret`, "root", { method: "GET" })).status).toBe(200);
  });
});
