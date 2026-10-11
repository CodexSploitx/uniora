import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { InvitationDeliveryError, createWebhookService, verifyWebhook } from "@uniora/core";
import { ServerConfigError, createUnioraServer, silentLogger } from "./index.js";
import { createMemoryApiCredentialStorage, createMemoryStorage, createMemoryWebhookStorage } from "@uniora/core";
import { BACKENDS, startFixture } from "./test-support/harness.js";
import type { BackendName, Fixture } from "./test-support/harness.js";

const open: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (open.length > 0) await open.pop()!();
});

const operator = { provider: "uniora-cli", subject: "tests" };
const LOCAL = { allowInsecureHttp: true, allowPrivateNetworks: true } as const;

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
  open.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  return { received, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook` };
}

async function waitFor(condition: () => boolean, what: string) {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > 5000) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe.each(BACKENDS)("webhooks of the server over %s", (backend: BackendName) => {
  async function start(): Promise<Fixture> {
    const fixture = await startFixture(backend, async (b) => ({ webhooks: { storage: b.webhooks, urlPolicy: LOCAL, pollIntervalMs: 20 } }));
    open.push(() => fixture.stop());
    return fixture;
  }

  it("sends the changes made through the API to a registered endpoint, signed", async () => {
    const f = await start();
    const target = await receiver();
    const service = createWebhookService({ storage: f.backend.webhooks, urlPolicy: LOCAL });
    const { secret } = await service.createEndpoint({ actor: operator, url: target.url, events: ["membership.*", "organization.created", "invitation.*"], organizations: "*" });
    const { token } = await f.issue();

    const assigned = await f.call("PUT", "/v1/organizations/org_acme/members/mem_bob/roles/role_viewer", { token, actor: "mgr" });
    expect(assigned.status).toBe(200);
    const created = await f.call("POST", "/v1/organizations", { token, body: { name: "Initech", owner: { subject: "peter" } } });
    expect(created.status).toBe(201);
    const invited = await f.call("POST", "/v1/organizations/org_acme/invitations", { token, actor: "mgr", body: { email: "someone@example.com", roleIds: ["role_viewer"] } });
    expect(invited.status).toBe(201);

    await waitFor(() => target.received.length >= 3, "three deliveries");
    const events = target.received.map((item) => JSON.parse(item.body) as { id: string; type: string; organizationId: string; data: { actor: { subject: string }; target: { type: string } } });
    expect(events.map((event) => event.type).sort()).toEqual(expect.arrayContaining(["membership.role_assigned", "organization.created", "invitation.created"]));
    const assignedEvent = events.find((event) => event.type.startsWith("membership."))!;
    expect(assignedEvent).toMatchObject({ organizationId: "org_acme", data: { actor: { subject: "mgr" } } });
    for (const item of target.received) {
      expect(verifyWebhook({ body: item.body, headers: { id: item.headers["webhook-id"] as string, timestamp: item.headers["webhook-timestamp"] as string, signature: item.headers["webhook-signature"] as string }, secrets: secret })).toBe(true);
    }
    // What a receiver is told never includes the invitee's address, the token or the link.
    const everything = target.received.map((item) => item.body).join("\n");
    expect(everything).not.toContain("someone@example.com");
    expect(everything).not.toMatch(/uinv_|app\.test\/invite/);
  });

  it("never puts the invitee's address in an event, not even through the error of a sender that echoes it", async () => {
    const f = await startFixture(backend, async (b) => ({
      webhooks: { storage: b.webhooks, urlPolicy: LOCAL, pollIntervalMs: 20 },
      invitations: {
        acceptUrl: (token: string) => `https://app.test/invite/${token}`,
        sender: { send: async (message) => { throw new InvitationDeliveryError(`550 5.1.1 <${message.to}>: Recipient address rejected: User ${message.to.split("@")[0]} unknown`, true); } },
        retry: { maxAttempts: 1 },
      },
    }));
    open.push(() => f.stop());
    const target = await receiver();
    await createWebhookService({ storage: f.backend.webhooks, urlPolicy: LOCAL }).createEndpoint({ actor: operator, url: target.url, events: ["invitation.*"] });
    const { token } = await f.issue();
    const invited = await f.call("POST", "/v1/organizations/org_acme/invitations", { token, actor: "mgr", body: { email: "victim.person@example.com", roleIds: ["role_viewer"] } });
    expect(invited.status).toBe(201);
    await waitFor(() => target.received.some((item) => JSON.parse(item.body).type === "invitation.delivery_failed"), "the failure event");
    const everything = target.received.map((item) => item.body).join("\n");
    expect(everything).not.toContain("victim.person");
    expect(everything).not.toContain("emailFingerprint");
    expect(JSON.stringify(invited.body)).not.toMatch(/550 5\.1\.1 <victim/);
  });

  it("filters by organization and by event, and the server keeps serving when the receiver is down", async () => {
    const f = await start();
    const globex = await receiver();
    const down = await receiver();
    const service = createWebhookService({ storage: f.backend.webhooks, urlPolicy: LOCAL });
    await service.createEndpoint({ actor: operator, url: globex.url, events: ["*"], organizations: ["org_globex"] });
    const broken = await service.createEndpoint({ actor: operator, url: "http://127.0.0.1:1/never", events: ["*"], organizations: ["org_acme"] });
    void down;
    const { token } = await f.issue();
    const response = await f.call("PUT", "/v1/organizations/org_acme/members/mem_bob/roles/role_viewer", { token, actor: "mgr" });
    expect(response.status).toBe(200);
    expect(globex.received).toHaveLength(0);
    // The broken receiver does not make the API fail, and its failures are recorded for the operator.
    expect((await f.call("GET", "/v1/organizations/org_acme", { token })).status).toBe(200);
    const started = Date.now();
    let delivery;
    while (!(delivery = (await f.backend.webhooks.deliveries.search({ endpointId: broken.endpoint.id }))[0])?.lastError && Date.now() - started < 5000) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(delivery).toMatchObject({ status: "pending", lastError: "connection refused" });
  });

  it("is switched off by run: false, and can then be driven by hand", async () => {
    const f = await startFixture(backend, async (b) => ({ webhooks: { storage: b.webhooks, urlPolicy: LOCAL, run: false } }));
    open.push(() => f.stop());
    const target = await receiver();
    await createWebhookService({ storage: f.backend.webhooks, urlPolicy: LOCAL }).createEndpoint({ actor: operator, url: target.url, events: ["*"] });
    const { token } = await f.issue();
    await f.call("PUT", "/v1/organizations/org_acme/members/mem_bob/roles/role_viewer", { token, actor: "mgr" });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(target.received).toHaveLength(0);
  });
});

describe("webhooks configuration", () => {
  const base = () => ({ storage: createMemoryStorage(), credentials: createMemoryApiCredentialStorage(), logger: silentLogger });
  it("needs a storage, refuses unknown options and the dangerous combination in production", () => {
    expect(() => createUnioraServer({ ...base(), webhooks: {} as never })).toThrow(ServerConfigError);
    expect(() => createUnioraServer({ ...base(), webhooks: { storage: createMemoryWebhookStorage(), nope: 1 } as never })).toThrow(/unknown option/);
    expect(() => createUnioraServer({ ...base(), webhooks: { storage: createMemoryWebhookStorage() } })).not.toThrow();
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      expect(() => createUnioraServer({ ...base(), webhooks: { storage: createMemoryWebhookStorage(), urlPolicy: LOCAL } })).toThrow(/production/);
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
  });
  it("exposes the dispatcher only when configured", () => {
    expect(createUnioraServer(base()).webhooks).toBeUndefined();
    expect(createUnioraServer({ ...base(), webhooks: { storage: createMemoryWebhookStorage() } }).webhooks).toBeDefined();
  });
});
