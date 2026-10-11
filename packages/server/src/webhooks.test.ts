import { createServer } from "node:http";
import type { IncomingMessage, Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createWebhookService, verifyWebhook } from "@uniora/core";
import type { OutboxRepository, WebhookService, WebhookStorage } from "@uniora/core";
import { createWebhookDispatcher, sendWebhook } from "./index.js";
import type { WebhookDispatcher } from "./index.js";
import { BACKENDS, createBackend } from "./test-support/harness.js";
import type { Backend, BackendName } from "./test-support/harness.js";

interface Received {
  body: string;
  headers: IncomingMessage["headers"];
  url: string;
}

/** A receiver on this machine. `answer` decides what it says to each request. */
type Reply = { status: number; headers?: Record<string, string>; delayMs?: number; flood?: boolean };
async function receiver(answer: (request: Received, index: number) => Reply = () => ({ status: 204 })) {
  const received: Received[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const item = { body: Buffer.concat(chunks).toString("utf8"), headers: request.headers, url: request.url ?? "" };
      received.push(item);
      const reply = answer(item, received.length - 1);
      setTimeout(() => {
        response.writeHead(reply.status, reply.headers);
        if (reply.flood) {
          const timer = setInterval(() => response.write("x".repeat(65536)), 1);
          response.on("close", () => clearInterval(timer));
        } else response.end();
      }, reply.delayMs ?? 0);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return { received, url: `http://127.0.0.1:${port}/hook`, port, close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

const LOCAL = { allowInsecureHttp: true, allowPrivateNetworks: true } as const;
const operator = { provider: "uniora-cli", subject: "tests" };
const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (closers.length > 0) await closers.pop()!();
});
const track = <T extends { close(): Promise<void> | void }>(thing: T): T => {
  closers.push(() => thing.close());
  return thing;
};

describe("sendWebhook", () => {
  const input = (url: string, extra: Record<string, unknown> = {}) => ({ url, body: '{"a":1}', headers: { "content-type": "application/json", "webhook-id": "evt_1" }, timeoutMs: 2000, policy: LOCAL, ...extra });

  it("posts the body and headers and reports the status", async () => {
    const target = track(await receiver());
    const result = await sendWebhook(input(target.url));
    expect(result).toMatchObject({ ok: true, status: 204 });
    expect(target.received[0]).toMatchObject({ body: '{"a":1}', url: "/hook" });
    expect(target.received[0]!.headers["webhook-id"]).toBe("evt_1");
    expect(target.received[0]!.headers.host).toBe(`127.0.0.1:${target.port}`);
  });

  it("treats anything but 2xx as a failure, redirects included, and never follows one", async () => {
    const elsewhere = track(await receiver());
    const target = track(await receiver((_request, index): Reply => (index === 0 ? { status: 500 } : index === 1 ? { status: 302, headers: { location: elsewhere.url } } : { status: 429, headers: { "retry-after": "120" } })));
    expect(await sendWebhook(input(target.url))).toMatchObject({ ok: false, status: 500, error: "HTTP 500" });
    expect(await sendWebhook(input(target.url))).toMatchObject({ ok: false, status: 302, error: expect.stringContaining("redirects are not followed") });
    expect(await sendWebhook(input(target.url))).toMatchObject({ ok: false, status: 429, retryAfterSeconds: 120 });
    expect(elsewhere.received).toHaveLength(0);
  });

  it("gives up at the deadline and does not wait for a receiver that never answers", async () => {
    const target = track(await receiver(() => ({ status: 200, delayMs: 5000 })));
    const started = Date.now();
    const result = await sendWebhook(input(target.url, { timeoutMs: 300 }));
    expect(result).toMatchObject({ ok: false, error: "timeout after 300 ms" });
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("does not read an endless answer", async () => {
    const target = track(await receiver(() => ({ status: 200, flood: true })));
    const result = await sendWebhook(input(target.url));
    expect(result.ok).toBe(true);
    expect(result.durationMs).toBeLessThan(1500);
  });

  it("says why a connection failed without naming the address", async () => {
    const target = await receiver();
    await target.close();
    const result = await sendWebhook(input(target.url));
    expect(result).toMatchObject({ ok: false, error: "connection refused" });
    expect(JSON.stringify(result)).not.toContain("127.0.0.1");
  });

  it("refuses private destinations unless allowed: literals, names, and a name with ANY private address", async () => {
    const target = track(await receiver());
    const strict = { policy: { allowInsecureHttp: true } };
    expect(await sendWebhook(input(target.url, strict))).toMatchObject({ ok: false, error: "the address is not public" });
    expect(await sendWebhook(input("http://[::1]:9/", strict))).toMatchObject({ ok: false, error: "the address is not public" });
    expect(await sendWebhook(input("http://[::ffff:169.254.169.254]/latest", strict))).toMatchObject({ ok: false, error: "the address is not public" });
    expect(await sendWebhook(input(`http://rebind.example.com:${target.port}/hook`, { ...strict, resolve: async () => ["93.184.216.34", "127.0.0.1"] }))).toMatchObject({ ok: false, error: "the name resolves to a private address" });
    expect(await sendWebhook(input(`http://metadata.example.com:${target.port}/`, { ...strict, resolve: async () => ["169.254.169.254"] }))).toMatchObject({ ok: false, error: "the name resolves to a private address" });
    expect(await sendWebhook(input(`http://gone.example.com:${target.port}/`, { ...strict, resolve: async () => [] }))).toMatchObject({ ok: false, error: "the name does not resolve" });
    expect(target.received).toHaveLength(0);
  });

  it("connects to the address it checked, with the name as the Host header", async () => {
    const target = track(await receiver());
    // The name resolves (as far as this test is concerned) to the receiver: the request must arrive there, saying the name.
    const result = await sendWebhook(input(`http://hooks.test:${target.port}/hook`, { resolve: async () => ["127.0.0.1"] }));
    expect(result.ok).toBe(true);
    expect(target.received[0]!.headers.host).toBe(`hooks.test:${target.port}`);
  });
});

describe.each(BACKENDS)("webhook dispatcher over %s", (name: BackendName) => {
  let backend: Backend;

  async function boot(overrides: Parameters<typeof createWebhookDispatcher>[0] extends infer O ? Partial<O> : never = {}) {
    backend = await createBackend(name);
    closers.push(() => backend.close());
    // A little ahead of the real clock: what the storage stamps "now" (an event just queued) is always due for this clock.
    const clock = { now: new Date(Date.now() + 5000) };
    const service: WebhookService = createWebhookService({ storage: backend.webhooks, urlPolicy: LOCAL, now: () => clock.now });
    const dispatcher: WebhookDispatcher = createWebhookDispatcher({
      webhooks: backend.webhooks,
      outbox: backend.storage.outbox,
      urlPolicy: LOCAL,
      now: () => clock.now,
      pollIntervalMs: 10,
      ...overrides,
    });
    closers.push(() => dispatcher.stop());
    const publish = (id: string, type: string, organizationId?: string, payload: Record<string, unknown> = { membershipId: "mem_1" }) =>
      backend.storage.outbox.enqueue({ id, type, ...(organizationId ? { organizationId } : {}), payload });
    return { clock, service, dispatcher, publish, storage: backend.webhooks as WebhookStorage, outbox: backend.storage.outbox as OutboxRepository };
  }

  it("delivers an event once, signed, and marks the outbox event done", async () => {
    const { service, dispatcher, publish, storage, outbox } = await boot();
    const target = track(await receiver());
    const { endpoint, secret } = await service.createEndpoint({ actor: operator, url: target.url, events: ["membership.*"] });
    await publish("evt_1", "membership.blocked", "org_acme");
    expect(await dispatcher.tick()).toEqual({ fannedOut: 1, delivered: 1, failed: 0 });
    expect(target.received).toHaveLength(1);
    const { body, headers } = target.received[0]!;
    expect(JSON.parse(body)).toMatchObject({ id: "evt_1", type: "membership.blocked", organizationId: "org_acme", data: { membershipId: "mem_1" } });
    expect(headers["webhook-id"]).toBe("evt_1");
    expect(verifyWebhook({ body, headers: { id: headers["webhook-id"] as string, timestamp: headers["webhook-timestamp"] as string, signature: headers["webhook-signature"] as string }, secrets: secret })).toBe(true);
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["user-agent"]).toBe("uniora-webhooks/1");
    expect((await outbox.findById("evt_1"))?.status).toBe("delivered");
    expect(await storage.deliveries.findById(`${endpoint.id}:evt_1`)).toMatchObject({ status: "delivered", lastHttpStatus: 204 });
    expect(await dispatcher.tick()).toEqual({ fannedOut: 0, delivered: 0, failed: 0 });
    expect(target.received).toHaveLength(1);
  });

  it("sends each event only to the endpoints that asked for its type and organization", async () => {
    const { service, dispatcher, publish } = await boot();
    const [everything, members, acme, roles] = await Promise.all([track(await receiver()), track(await receiver()), track(await receiver()), track(await receiver())]);
    await service.createEndpoint({ actor: operator, url: everything.url, events: ["*"] });
    await service.createEndpoint({ actor: operator, url: members.url, events: ["membership.*"] });
    await service.createEndpoint({ actor: operator, url: acme.url, events: ["*"], organizations: ["org_acme"] });
    await service.createEndpoint({ actor: operator, url: roles.url, events: ["role.updated"] });
    await publish("evt_1", "membership.blocked", "org_acme");
    await publish("evt_2", "membership.blocked", "org_globex");
    await publish("evt_3", "role.updated", "org_acme");
    await publish("evt_4", "plan.changed");
    await dispatcher.tick();
    const ids = (r: { received: Received[] }) => r.received.map((item) => JSON.parse(item.body).id).sort();
    expect(ids(everything)).toEqual(["evt_1", "evt_2", "evt_3", "evt_4"]);
    expect(ids(members)).toEqual(["evt_1", "evt_2"]);
    expect(ids(acme)).toEqual(["evt_1", "evt_3"]);
    expect(ids(roles)).toEqual(["evt_3"]);
  });

  it("retries with backoff, then parks the delivery as dead, and an operator can send it again", async () => {
    const { clock, service, dispatcher, publish, storage } = await boot({ maxAttempts: 3 });
    let healthy = false;
    const target = track(await receiver(() => ({ status: healthy ? 200 : 503 })));
    const { endpoint } = await service.createEndpoint({ actor: operator, url: target.url, events: ["*"] });
    await publish("evt_1", "membership.blocked", "org_acme");
    expect(await dispatcher.tick()).toMatchObject({ delivered: 0, failed: 1 });
    const id = `${endpoint.id}:evt_1`;
    expect(await storage.deliveries.findById(id)).toMatchObject({ status: "pending", attempts: 1, lastError: "HTTP 503", lastHttpStatus: 503 });
    // Not before its time.
    expect(await dispatcher.tick()).toMatchObject({ delivered: 0, failed: 0 });
    clock.now = new Date(clock.now.getTime() + 60_000);
    expect(await dispatcher.tick()).toMatchObject({ failed: 1 });
    clock.now = new Date(clock.now.getTime() + 3_600_000);
    expect(await dispatcher.tick()).toMatchObject({ failed: 1 });
    expect(await storage.deliveries.findById(id)).toMatchObject({ status: "dead", attempts: 3 });
    expect(target.received).toHaveLength(3);
    healthy = true;
    await service.requeueDelivery({ actor: operator, deliveryId: id });
    expect(await dispatcher.tick()).toMatchObject({ delivered: 1 });
    expect(await storage.deliveries.findById(id)).toMatchObject({ status: "delivered" });
    // Same event id on every attempt, so the receiver can deduplicate.
    expect(new Set(target.received.map((item) => item.headers["webhook-id"]))).toEqual(new Set(["evt_1"]));
  });

  it("waits as long as a receiver asks on 429 or 503", async () => {
    const { clock, service, dispatcher, publish, storage } = await boot();
    const target = track(await receiver((_r, index): Reply => (index === 0 ? { status: 429, headers: { "retry-after": "900" } } : { status: 200 })));
    const { endpoint } = await service.createEndpoint({ actor: operator, url: target.url, events: ["*"] });
    await publish("evt_1", "a.b");
    await dispatcher.tick();
    const delivery = await storage.deliveries.findById(`${endpoint.id}:evt_1`);
    expect(delivery!.availableAt.getTime() - clock.now.getTime()).toBe(900_000);
    clock.now = new Date(clock.now.getTime() + 899_000);
    expect(await dispatcher.tick()).toMatchObject({ delivered: 0, failed: 0 });
    clock.now = new Date(clock.now.getTime() + 2_000);
    expect(await dispatcher.tick()).toMatchObject({ delivered: 1 });
  });

  it("disables an endpoint after too many failures in a row, keeps its queue, and resumes when enabled", async () => {
    const { clock, service, dispatcher, publish, storage } = await boot({ disableAfterFailures: 2, maxAttempts: 10 });
    let healthy = false;
    const target = track(await receiver(() => ({ status: healthy ? 200 : 500 })));
    const { endpoint } = await service.createEndpoint({ actor: operator, url: target.url, events: ["*"] });
    await publish("evt_1", "a.b");
    await dispatcher.tick();
    clock.now = new Date(clock.now.getTime() + 120_000);
    await dispatcher.tick();
    expect(await storage.endpoints.findById(endpoint.id)).toMatchObject({ status: "disabled", disabledReason: "too_many_failures", consecutiveFailures: 2 });
    // Nothing is sent, and new events are not queued for it, while it is disabled.
    await publish("evt_2", "a.b");
    clock.now = new Date(clock.now.getTime() + 3_600_000);
    expect(await dispatcher.tick()).toMatchObject({ delivered: 0, failed: 0 });
    expect(target.received).toHaveLength(2);
    expect(await storage.deliveries.findById(`${endpoint.id}:evt_2`)).toBeNull();
    healthy = true;
    await service.enableEndpoint({ actor: operator, endpointId: endpoint.id });
    expect(await dispatcher.tick()).toMatchObject({ delivered: 1 });
    expect(JSON.parse(target.received.at(-1)!.body).id).toBe("evt_1");
  });

  it("signs with both secrets during a rotation and only the new one afterwards", async () => {
    const { clock, service, dispatcher, publish } = await boot();
    const target = track(await receiver());
    const { endpoint, secret: first } = await service.createEndpoint({ actor: operator, url: target.url, events: ["*"] });
    const { secret: second } = await service.rotateSecret({ actor: operator, endpointId: endpoint.id, graceSeconds: 600 });
    await publish("evt_1", "a.b");
    await dispatcher.tick();
    const check = (item: Received, secrets: string[]) =>
      verifyWebhook({ body: item.body, headers: { id: item.headers["webhook-id"] as string, timestamp: item.headers["webhook-timestamp"] as string, signature: item.headers["webhook-signature"] as string }, secrets, now: clock.now });
    expect(check(target.received[0]!, [first])).toBe(true);
    expect(check(target.received[0]!, [second])).toBe(true);
    clock.now = new Date(clock.now.getTime() + 601_000);
    await publish("evt_2", "a.b");
    await dispatcher.tick();
    expect(check(target.received[1]!, [second])).toBe(true);
    expect(check(target.received[1]!, [first])).toBe(false);
  });

  it("two dispatchers over the same storage deliver every event once", async () => {
    const { service, dispatcher, publish, storage, outbox, clock } = await boot();
    const second = createWebhookDispatcher({ webhooks: storage, outbox, urlPolicy: LOCAL, now: () => clock.now });
    const target = track(await receiver());
    await service.createEndpoint({ actor: operator, url: target.url, events: ["*"] });
    for (let index = 0; index < 30; index++) await publish(`evt_${index}`, "a.b");
    await Promise.all([dispatcher.tick(), second.tick(), dispatcher.tick(), second.tick()]);
    await dispatcher.tick();
    const ids = target.received.map((item) => JSON.parse(item.body).id as string);
    expect(new Set(ids).size).toBe(30);
    expect(ids).toHaveLength(30);
  });

  it("fanning the same event out twice sends it once", async () => {
    const { service, dispatcher, publish, storage, outbox } = await boot();
    const target = track(await receiver());
    const { endpoint } = await service.createEndpoint({ actor: operator, url: target.url, events: ["*"] });
    await publish("evt_1", "a.b");
    // A crash after the delivery was queued but before the outbox event was completed: the event comes back.
    const [event] = await outbox.claim({ now: new Date() });
    await storage.deliveries.enqueue({ id: `${endpoint.id}:${event!.id}`, endpointId: endpoint.id, eventId: event!.id, eventType: event!.type, eventCreatedAt: event!.createdAt, payload: event!.payload });
    await dispatcher.tick(); // the lease on the outbox event is still held
    await dispatcher.tick();
    expect(target.received.length).toBeLessThanOrEqual(1);
    await outbox.fail(event!.id, { error: "crash", retryAt: new Date(Date.now() - 1000), maxAttempts: 8 });
    await dispatcher.tick();
    await dispatcher.tick();
    expect(target.received).toHaveLength(1);
  });

  it("never lets a hostile receiver's address through, even if it was registered under a public name", async () => {
    const { service, dispatcher, publish, storage } = await boot({ urlPolicy: {} });
    // Registered as an ordinary name; at delivery time it resolves to the metadata address.
    const lenient = createWebhookService({ storage, urlPolicy: { allowInsecureHttp: false } });
    const { endpoint } = await lenient.createEndpoint({ actor: operator, url: "https://hooks.example.com/uniora", events: ["*"] });
    void service;
    const guarded = createWebhookDispatcher({ webhooks: storage, outbox: backend.storage.outbox, now: () => new Date(), send: (input) => sendWebhook({ ...input, resolve: async () => ["169.254.169.254"] }) });
    await publish("evt_1", "a.b");
    expect(await guarded.tick()).toMatchObject({ delivered: 0, failed: 1 });
    expect(await storage.deliveries.findById(`${endpoint.id}:evt_1`)).toMatchObject({ lastError: "the name resolves to a private address" });
    void dispatcher;
  });

  it("sends a test event outside the queue", async () => {
    const { service, dispatcher, storage } = await boot();
    const target = track(await receiver());
    const { endpoint, secret } = await service.createEndpoint({ actor: operator, url: target.url, events: ["role.*"] });
    const result = await dispatcher.sendTest(endpoint.id);
    expect(result).toMatchObject({ ok: true, status: 204 });
    const item = target.received[0]!;
    expect(JSON.parse(item.body)).toMatchObject({ type: "webhook.test", data: { message: expect.any(String) } });
    expect(verifyWebhook({ body: item.body, headers: { id: item.headers["webhook-id"] as string, timestamp: item.headers["webhook-timestamp"] as string, signature: item.headers["webhook-signature"] as string }, secrets: secret })).toBe(true);
    expect(await storage.deliveries.count()).toBe(0);
    expect(await dispatcher.sendTest("whe_missing")).toBeNull();
  });

  it("runs in the background and stops cleanly", async () => {
    const { service, dispatcher, publish } = await boot();
    const target = track(await receiver());
    await service.createEndpoint({ actor: operator, url: target.url, events: ["*"] });
    dispatcher.start();
    dispatcher.start();
    await publish("evt_1", "a.b");
    const started = Date.now();
    while (target.received.length === 0 && Date.now() - started < 3000) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(target.received).toHaveLength(1);
    await dispatcher.stop();
    await dispatcher.stop();
    await publish("evt_2", "a.b");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(target.received).toHaveLength(1);
  });

  it("refuses nonsense settings", () => {
    const base = { webhooks: {} as WebhookStorage, outbox: {} as OutboxRepository };
    for (const bad of [{ concurrency: 0 }, { timeoutMs: 10 }, { maxAttempts: 0 }, { pollIntervalMs: 1 }, { retainDeliveredDays: 0 }, { disableAfterFailures: 0 }]) {
      expect(() => createWebhookDispatcher({ ...base, ...bad }), JSON.stringify(bad)).toThrow(RangeError);
    }
  });
});

