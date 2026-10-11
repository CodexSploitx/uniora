import { describe, expect, it } from "vitest";
import { bootstrapPlatform, createMemoryPlatformStorage, createMemoryStorage, createPlatformEngine, createPlatformService } from "@uniora/core";
import { PlatformDeniedError, assertPlatformCan, platformCommandRoute } from "./platform.js";

const root = { provider: "p", subject: "root" };
const intruder = { provider: "p", subject: "intruder" };

async function setup() {
  const storage = createMemoryStorage();
  const platform = createMemoryPlatformStorage({ auditLogs: storage.auditLogs });
  await bootstrapPlatform({ platform, admin: root });
  return { platform, service: createPlatformService({ platform, storage }) };
}

describe("platformCommandRoute / assertPlatformCan", () => {
  it("401 without a caller, 403 without platform power, 200 for an administrator", async () => {
    const { service } = await setup();
    const params = { key: "support", name: "Support", permissions: ["platform.audit.read"] };
    expect((await platformCommandRoute(service, { command: "createRole", caller: null, params })).status).toBe(401);
    const denied = await platformCommandRoute(service, { command: "createRole", caller: { actor: intruder }, params });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: "forbidden", message: "You are not allowed to do that." });
    const ok = await platformCommandRoute(service, { command: "createRole", caller: { actor: root }, params });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ key: "support" });
  });

  it("assertPlatformCan fails closed", async () => {
    const { platform } = await setup();
    const engine = createPlatformEngine(platform);
    await expect(assertPlatformCan(engine, { identity: root, permission: "platform.x.y" })).resolves.toBeUndefined();
    await expect(assertPlatformCan(engine, { identity: intruder, permission: "platform.x.y" })).rejects.toBeInstanceOf(PlatformDeniedError);
    await expect(assertPlatformCan(engine, { identity: null, permission: "platform.x.y" })).rejects.toBeInstanceOf(PlatformDeniedError);
  });
});
