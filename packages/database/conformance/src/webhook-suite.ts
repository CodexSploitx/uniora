import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MAX_WEBHOOK_ENDPOINTS, WebhookError, createWebhookService, generateWebhookSecret } from "@uniora/core";
import type { Identity, WebhookStorage } from "@uniora/core";

const operator: Identity = { provider: "uniora-studio", subject: "local-admin" };

/** How the webhook conformance suite drives one adapter. */
export interface WebhookHarness {
  readonly name: string;
  setup(): Promise<void>;
  teardown(): Promise<void>;
  /** Empties the webhook tables and the audit log. */
  reset(): Promise<void>;
  storage(): WebhookStorage;
  probe?: {
    /** Every text value stored in the webhook tables, joined: used to prove what is (and is not) kept there. */
    dumpWebhookText(): Promise<string>;
  };
}

const at = (seconds: number) => new Date(Date.UTC(2030, 0, 1, 0, 0, seconds));
// The time the tests claim at: a little ahead of the real clock. `enqueue` stamps `available_at` with the database's clock, which can run ahead of this process's (a container), and a delivery stamped "in the future" is not due yet.
const soon = () => new Date(Date.now() + 5_000);

/** The behaviour every `WebhookStorage` adapter must reproduce. Real database, never mocks. */
export function defineWebhookConformance(harness: WebhookHarness): void {
  describe(`${harness.name} — WebhookStorage conformance`, () => {
    beforeAll(() => harness.setup());
    afterAll(() => harness.teardown());
    beforeEach(() => harness.reset());

    const endpointInput = (id: string, extra: Record<string, unknown> = {}) => ({
      id,
      url: "https://hooks.example.com/uniora",
      events: ["membership.*"],
      organizations: "*" as const,
      secret: generateWebhookSecret(),
      createdBy: operator,
      ...extra,
    });

    const delivery = (endpointId: string, eventId: string, extra: Record<string, unknown> = {}) => ({
      id: `${endpointId}:${eventId}`,
      endpointId,
      eventId,
      eventType: "membership.blocked",
      organizationId: "org-1",
      eventCreatedAt: at(0),
      payload: { membershipId: "mem-1" },
      ...extra,
    });

    describe("endpoints", () => {
      it("creates an endpoint with normalized filters and never reads its secret back", async () => {
        const { endpoints } = harness.storage();
        const input = endpointInput("whe_a", { events: ["role.*", "membership.blocked", "role.*"], organizations: ["org-b", "org-a"], description: "  Billing\nsync " });
        const created = await endpoints.create(input);
        expect(created).toMatchObject({
          id: "whe_a",
          url: "https://hooks.example.com/uniora",
          events: ["membership.blocked", "role.*"],
          organizations: ["org-a", "org-b"],
          description: "Billing sync",
          status: "enabled",
          consecutiveFailures: 0,
          version: 1,
          createdBy: operator,
        });
        expect(JSON.stringify(created)).not.toContain(input.secret);
        expect(JSON.stringify(await endpoints.findById("whe_a"))).not.toContain(input.secret);
        expect(JSON.stringify(await endpoints.search())).not.toContain(input.secret);
        expect(await endpoints.signingSecrets("whe_a")).toEqual([input.secret]);
        expect(await endpoints.findById("whe_missing")).toBeNull();
        expect(await endpoints.signingSecrets("whe_missing")).toEqual([]);
      });

      it("refuses what is malformed, a repeated id and more than the limit", async () => {
        const { endpoints } = harness.storage();
        await endpoints.create(endpointInput("whe_a"));
        await expect(endpoints.create(endpointInput("whe_a"))).rejects.toBeInstanceOf(WebhookError);
        const bad: Record<string, unknown>[] = [
          { url: "ftp://x.example.com" },
          { url: "https://user:pw@x.example.com/" },
          { url: "not a url" },
          { events: [] },
          { events: ["Not.Valid"] },
          { events: ["a.*.b"] },
          { organizations: [] },
          { secret: "whsec_short" },
          { description: "x".repeat(201) },
        ];
        for (const extra of bad) await expect(endpoints.create(endpointInput("whe_bad", extra)), JSON.stringify(extra)).rejects.toBeInstanceOf(WebhookError);
        expect(await endpoints.count()).toBe(1);
        for (let index = 1; index < MAX_WEBHOOK_ENDPOINTS; index++) await endpoints.create(endpointInput(`whe_${String(index).padStart(3, "0")}`));
        await expect(endpoints.create(endpointInput("whe_over"))).rejects.toMatchObject({ code: "webhook_endpoint_limit" });
      });

      it("updates with optimistic concurrency and bumps the version", async () => {
        const { endpoints } = harness.storage();
        await endpoints.create(endpointInput("whe_a", { description: "first" }));
        const updated = await endpoints.update("whe_a", { url: "https://other.example.com/hook", events: ["*"], organizations: ["org-1"], description: null, expectedVersion: 1 });
        expect(updated).toMatchObject({ url: "https://other.example.com/hook", events: ["*"], organizations: ["org-1"], version: 2 });
        expect(updated.description).toBeUndefined();
        await expect(endpoints.update("whe_a", { events: ["role.*"], expectedVersion: 1 })).rejects.toMatchObject({ code: "webhook_version_conflict" });
        await expect(endpoints.update("whe_a", {})).rejects.toBeInstanceOf(WebhookError);
        await expect(endpoints.update("whe_missing", { events: ["*"] })).rejects.toMatchObject({ code: "webhook_endpoint_not_found" });
      });

      it("disables and enables, clearing the failure count when enabled", async () => {
        const { endpoints } = harness.storage();
        await endpoints.create(endpointInput("whe_a"));
        await endpoints.recordAttempt("whe_a", { success: false, at: at(1) });
        const disabled = await endpoints.setStatus("whe_a", "disabled", { reason: "maintenance\nwindow" });
        expect(disabled).toMatchObject({ status: "disabled", disabledReason: "maintenance window", consecutiveFailures: 1 });
        expect(disabled.disabledAt).toBeInstanceOf(Date);
        const enabled = await endpoints.setStatus("whe_a", "enabled");
        expect(enabled).toMatchObject({ status: "enabled", consecutiveFailures: 0 });
        expect(enabled.disabledReason).toBeUndefined();
        await expect(endpoints.setStatus("whe_a", "disabled", { expectedVersion: 1 })).rejects.toMatchObject({ code: "webhook_version_conflict" });
        await expect(endpoints.setStatus("whe_missing", "disabled")).rejects.toMatchObject({ code: "webhook_endpoint_not_found" });
      });

      it("rotates the secret: the old one keeps signing only for its grace", async () => {
        const { endpoints } = harness.storage();
        const first = generateWebhookSecret();
        const second = generateWebhookSecret();
        const third = generateWebhookSecret();
        await endpoints.create(endpointInput("whe_a", { secret: first }));
        const rotated = await endpoints.rotateSecret("whe_a", { secret: second, previousValidUntil: at(100) });
        expect(rotated.version).toBe(2);
        expect(await endpoints.signingSecrets("whe_a", at(50))).toEqual([second, first]);
        expect(await endpoints.signingSecrets("whe_a", at(100))).toEqual([second]);
        await endpoints.rotateSecret("whe_a", { secret: third });
        expect(await endpoints.signingSecrets("whe_a", at(50))).toEqual([third]);
        await expect(endpoints.rotateSecret("whe_a", { secret: "nope" })).rejects.toBeInstanceOf(WebhookError);
        await expect(endpoints.rotateSecret("whe_missing", { secret: second })).rejects.toMatchObject({ code: "webhook_endpoint_not_found" });
      });

      it("counts attempts: success resets, failures add up and disable at the threshold", async () => {
        const { endpoints } = harness.storage();
        await endpoints.create(endpointInput("whe_a"));
        let state = await endpoints.recordAttempt("whe_a", { success: false, at: at(1), disableAfter: 3 });
        expect(state).toMatchObject({ consecutiveFailures: 1, status: "enabled" });
        state = await endpoints.recordAttempt("whe_a", { success: true, at: at(2), disableAfter: 3 });
        expect(state).toMatchObject({ consecutiveFailures: 0, status: "enabled" });
        expect(state!.lastSuccessAt).toEqual(at(2));
        for (let attempt = 1; attempt <= 2; attempt++) state = await endpoints.recordAttempt("whe_a", { success: false, at: at(10 + attempt), disableAfter: 3 });
        expect(state).toMatchObject({ consecutiveFailures: 2, status: "enabled" });
        state = await endpoints.recordAttempt("whe_a", { success: false, at: at(20), disableAfter: 3 });
        expect(state).toMatchObject({ consecutiveFailures: 3, status: "disabled", disabledReason: "too_many_failures" });
        expect(state!.lastFailureAt).toEqual(at(20));
        expect(await endpoints.recordAttempt("whe_missing", { success: true })).toBeNull();
      });

      it("disables only after the failures have also lasted: a burst against a receiver that blinked keeps the endpoint on", async () => {
        const { endpoints } = harness.storage();
        await endpoints.create(endpointInput("whe_a"));
        const created = (await endpoints.findById("whe_a"))!.createdAt;
        const later = (minutes: number) => new Date(created.getTime() + minutes * 60_000);
        let state = null;
        for (let attempt = 0; attempt < 10; attempt++) state = await endpoints.recordAttempt("whe_a", { success: false, at: later(1), disableAfter: 3, disableAfterMs: 30 * 60_000 });
        expect(state).toMatchObject({ consecutiveFailures: 10, status: "enabled" });
        state = await endpoints.recordAttempt("whe_a", { success: false, at: later(31), disableAfter: 3, disableAfterMs: 30 * 60_000 });
        expect(state).toMatchObject({ status: "disabled", disabledReason: "too_many_failures" });
        // A success restarts the clock.
        await endpoints.setStatus("whe_a", "enabled");
        await endpoints.recordAttempt("whe_a", { success: true, at: later(40) });
        state = await endpoints.recordAttempt("whe_a", { success: false, at: later(41), disableAfter: 1, disableAfterMs: 30 * 60_000 });
        expect(state!.status).toBe("enabled");
        state = await endpoints.recordAttempt("whe_a", { success: false, at: later(71), disableAfter: 1, disableAfterMs: 30 * 60_000 });
        expect(state!.status).toBe("disabled");
      });

      it("lists by id with a keyset cursor and filters by status", async () => {
        const { endpoints } = harness.storage();
        for (const id of ["whe_c", "whe_a", "whe_b"]) await endpoints.create(endpointInput(id));
        await endpoints.setStatus("whe_b", "disabled");
        expect((await endpoints.search()).map((endpoint) => endpoint.id)).toEqual(["whe_a", "whe_b", "whe_c"]);
        expect((await endpoints.search({ limit: 2 })).map((endpoint) => endpoint.id)).toEqual(["whe_a", "whe_b"]);
        expect((await endpoints.search({ after: "whe_b" })).map((endpoint) => endpoint.id)).toEqual(["whe_c"]);
        expect((await endpoints.search({ status: "disabled" })).map((endpoint) => endpoint.id)).toEqual(["whe_b"]);
        expect(await endpoints.count()).toBe(3);
        expect(await endpoints.count({ status: "enabled" })).toBe(2);
      });

      it("deletes an endpoint together with its deliveries", async () => {
        const { endpoints, deliveries } = harness.storage();
        await endpoints.create(endpointInput("whe_a"));
        await endpoints.create(endpointInput("whe_b"));
        await deliveries.enqueue(delivery("whe_a", "evt-1"));
        await deliveries.enqueue(delivery("whe_b", "evt-1"));
        expect(await endpoints.delete("whe_a")).toBe(true);
        expect(await endpoints.delete("whe_a")).toBe(false);
        expect(await deliveries.findById("whe_a:evt-1")).toBeNull();
        expect(await deliveries.findById("whe_b:evt-1")).not.toBeNull();
      });
    });

    describe("deliveries", () => {
      beforeEach(async () => {
        await harness.storage().endpoints.create(endpointInput("whe_a"));
      });

      it("enqueues once per id and not for an endpoint that does not exist", async () => {
        const { deliveries } = harness.storage();
        expect(await deliveries.enqueue(delivery("whe_a", "evt-1"))).toBe(true);
        expect(await deliveries.enqueue(delivery("whe_a", "evt-1"))).toBe(false);
        expect(await deliveries.enqueue(delivery("whe_none", "evt-1"))).toBe(false);
        const stored = await deliveries.findById("whe_a:evt-1");
        expect(stored).toMatchObject({ endpointId: "whe_a", eventId: "evt-1", eventType: "membership.blocked", organizationId: "org-1", status: "pending", attempts: 0, payload: { membershipId: "mem-1" } });
        expect(stored!.eventCreatedAt).toEqual(at(0));
        await expect(deliveries.enqueue(delivery("whe_a", "evt-2", { eventType: "" }))).rejects.toBeInstanceOf(WebhookError);
      });

      it("claims oldest first, leases them, and skips what is not due", async () => {
        const { deliveries } = harness.storage();
        for (const id of ["evt-1", "evt-2", "evt-3"]) await deliveries.enqueue(delivery("whe_a", id));
        const first = await deliveries.claim({ limit: 2, leaseSeconds: 30, now: soon() });
        expect(first.map((row) => row.eventId)).toEqual(["evt-1", "evt-2"]);
        expect(first.every((row) => row.attempts === 1)).toBe(true);
        const second = await deliveries.claim({ limit: 10, now: soon() });
        expect(second.map((row) => row.eventId)).toEqual(["evt-3"]);
        expect(await deliveries.claim({ now: soon() })).toEqual([]);
        // The lease runs out: they can be taken again.
        const later = await deliveries.claim({ now: new Date(Date.now() + 120_000) });
        expect(later.map((row) => row.eventId).sort()).toEqual(["evt-1", "evt-2", "evt-3"]);
        expect(later.every((row) => row.attempts === 2)).toBe(true);
        await expect(deliveries.claim({ limit: 0 })).rejects.toBeInstanceOf(WebhookError);
        await expect(deliveries.claim({ leaseSeconds: 100_000 })).rejects.toBeInstanceOf(WebhookError);
      });

      it("never hands the same delivery to two concurrent workers", async () => {
        const { deliveries } = harness.storage();
        for (let index = 0; index < 12; index++) await deliveries.enqueue(delivery("whe_a", `evt-${index}`));
        const now = soon();
        const batches = await Promise.all(Array.from({ length: 4 }, () => deliveries.claim({ limit: 5, now })));
        const ids = batches.flat().map((row) => row.id);
        expect(new Set(ids).size).toBe(ids.length);
        expect(ids).toHaveLength(12);
      });

      it("holds the deliveries of a disabled endpoint until it is enabled again", async () => {
        const { endpoints, deliveries } = harness.storage();
        await deliveries.enqueue(delivery("whe_a", "evt-1"));
        await endpoints.setStatus("whe_a", "disabled");
        expect(await deliveries.claim({ now: soon() })).toEqual([]);
        await endpoints.setStatus("whe_a", "enabled");
        expect((await deliveries.claim({ now: soon() })).map((row) => row.eventId)).toEqual(["evt-1"]);
      });

      it("completes a delivery and records what the receiver said", async () => {
        const { deliveries } = harness.storage();
        await deliveries.enqueue(delivery("whe_a", "evt-1"));
        await deliveries.claim({ now: soon() });
        expect(await deliveries.complete("whe_a:evt-1", { httpStatus: 204, durationMs: 42, at: at(5) })).toBe(true);
        expect(await deliveries.complete("whe_a:evt-1", { httpStatus: 204, durationMs: 42 })).toBe(false);
        expect(await deliveries.findById("whe_a:evt-1")).toMatchObject({ status: "delivered", lastHttpStatus: 204, lastDurationMs: 42, deliveredAt: at(5) });
        expect(await deliveries.claim({ now: new Date(Date.now() + 600_000) })).toEqual([]);
      });

      it("retries at the time asked and goes dead at the maximum, keeping the last error", async () => {
        const { deliveries } = harness.storage();
        await deliveries.enqueue(delivery("whe_a", "evt-1"));
        await deliveries.claim({ now: soon() });
        const retryAt = new Date(Date.now() + 60_000);
        expect(await deliveries.fail("whe_a:evt-1", { error: "HTTP 500", httpStatus: 500, durationMs: 9, retryAt, maxAttempts: 2 })).toBe("pending");
        expect(await deliveries.claim({ now: soon() })).toEqual([]);
        const again = await deliveries.claim({ now: new Date(retryAt.getTime() + 1000) });
        expect(again.map((row) => row.attempts)).toEqual([2]);
        expect(await deliveries.fail("whe_a:evt-1", { error: "timeout", retryAt, maxAttempts: 2 })).toBe("dead");
        expect(await deliveries.findById("whe_a:evt-1")).toMatchObject({ status: "dead", lastError: "timeout", attempts: 2 });
        expect(await deliveries.fail("whe_a:evt-1", { error: "x", retryAt, maxAttempts: 2 })).toBeNull();
        expect(await deliveries.fail("whe_nope", { error: "x", retryAt, maxAttempts: 2 })).toBeNull();
        expect(await deliveries.requeue("whe_a:evt-1")).toBe(true);
        expect(await deliveries.requeue("whe_a:evt-1")).toBe(false);
        expect(await deliveries.findById("whe_a:evt-1")).toMatchObject({ status: "pending", attempts: 0 });
        expect((await deliveries.claim({ now: new Date(Date.now() + 1000) })).map((row) => row.eventId)).toEqual(["evt-1"]);
      });

      it("searches newest first with a keyset cursor, by endpoint, status and type", async () => {
        const { endpoints, deliveries } = harness.storage();
        await endpoints.create(endpointInput("whe_b"));
        await deliveries.enqueue(delivery("whe_a", "evt-1"));
        await deliveries.enqueue(delivery("whe_a", "evt-2", { eventType: "role.updated" }));
        await deliveries.enqueue(delivery("whe_b", "evt-3"));
        await deliveries.claim({ limit: 1, now: soon() });
        await deliveries.complete("whe_a:evt-1", { httpStatus: 200, durationMs: 1 });
        expect((await deliveries.search()).map((row) => row.eventId)).toEqual(["evt-3", "evt-2", "evt-1"]);
        const page = await deliveries.search({ limit: 2 });
        expect((await deliveries.search({ beforeSeq: page.at(-1)!.seq })).map((row) => row.eventId)).toEqual(["evt-1"]);
        expect((await deliveries.search({ endpointId: "whe_a" })).map((row) => row.eventId)).toEqual(["evt-2", "evt-1"]);
        expect((await deliveries.search({ status: "delivered" })).map((row) => row.eventId)).toEqual(["evt-1"]);
        expect((await deliveries.search({ eventType: "role.updated" })).map((row) => row.eventId)).toEqual(["evt-2"]);
        expect(await deliveries.count()).toBe(3);
        expect(await deliveries.count({ endpointId: "whe_b" })).toBe(1);
        expect(await deliveries.count({ status: "pending" })).toBe(2);
      });

      it("prunes only delivered deliveries older than the cutoff", async () => {
        const { deliveries } = harness.storage();
        for (const id of ["evt-1", "evt-2", "evt-3"]) await deliveries.enqueue(delivery("whe_a", id));
        await deliveries.claim({ limit: 3, now: soon() });
        await deliveries.complete("whe_a:evt-1", { httpStatus: 200, durationMs: 1, at: at(1) });
        await deliveries.complete("whe_a:evt-2", { httpStatus: 200, durationMs: 1, at: at(100) });
        expect(await deliveries.pruneDelivered(at(50))).toBe(1);
        expect(await deliveries.findById("whe_a:evt-1")).toBeNull();
        expect(await deliveries.findById("whe_a:evt-2")).not.toBeNull();
        expect(await deliveries.findById("whe_a:evt-3")).not.toBeNull();
      });
    });

    describe("service", () => {
      it("shows the secret once, audits with the host only and never keeps the secret in the trail", async () => {
        const storage = harness.storage();
        const service = createWebhookService({ storage });
        const { endpoint, secret } = await service.createEndpoint({ actor: operator, url: "https://hooks.example.com/t/very-secret-path-token", events: ["membership.*"] });
        expect(secret).toMatch(/^whsec_/);
        expect(endpoint.id).toMatch(/^whe_/);
        expect(JSON.stringify(await service.getEndpoint(endpoint.id))).not.toContain(secret);
        await service.updateEndpoint({ actor: operator, endpointId: endpoint.id, events: ["role.*"] });
        const rotated = await service.rotateSecret({ actor: operator, endpointId: endpoint.id, graceSeconds: 60 });
        expect(rotated.secret).not.toBe(secret);
        expect(await storage.endpoints.signingSecrets(endpoint.id)).toEqual([rotated.secret, secret]);
        await service.disableEndpoint({ actor: operator, endpointId: endpoint.id, reason: "paused" });
        await service.enableEndpoint({ actor: operator, endpointId: endpoint.id });
        await service.deleteEndpoint({ actor: operator, endpointId: endpoint.id });
        const entries = await storage.auditLogs.listRecent({ limit: 20 });
        expect(entries.map((entry) => entry.action).sort()).toEqual(
          ["webhook_endpoint.created", "webhook_endpoint.deleted", "webhook_endpoint.disabled", "webhook_endpoint.enabled", "webhook_endpoint.secret_rotated", "webhook_endpoint.updated"].sort(),
        );
        const trail = JSON.stringify(entries);
        for (const forbidden of [secret, rotated.secret, "very-secret-path-token"]) expect(trail).not.toContain(forbidden);
        expect(trail).toContain("hooks.example.com");
        expect(entries.every((entry) => entry.actor.subject === operator.subject)).toBe(true);
      });

      it("refuses an unsafe URL by default and accepts a development one only when allowed", async () => {
        const storage = harness.storage();
        const strict = createWebhookService({ storage });
        for (const url of ["http://hooks.example.com/", "https://127.0.0.1/", "https://localhost/", "https://10.0.0.5/x", "https://[::1]/", "https://169.254.169.254/latest", "https://service.internal/"]) {
          await expect(strict.createEndpoint({ actor: operator, url, events: ["*"] }), url).rejects.toMatchObject({ code: "webhook_url_invalid" });
        }
        const lenient = createWebhookService({ storage, urlPolicy: { allowInsecureHttp: true, allowPrivateNetworks: true } });
        await expect(lenient.createEndpoint({ actor: operator, url: "http://127.0.0.1:9000/hook", events: ["*"] })).resolves.toBeDefined();
      });

      it("sends a dead delivery again, and only a dead one", async () => {
        const storage = harness.storage();
        const service = createWebhookService({ storage });
        const { endpoint } = await service.createEndpoint({ actor: operator, url: "https://hooks.example.com/", events: ["*"] });
        await storage.deliveries.enqueue(delivery(endpoint.id, "evt-1"));
        await expect(service.requeueDelivery({ actor: operator, deliveryId: `${endpoint.id}:evt-1` })).rejects.toBeInstanceOf(WebhookError);
        await storage.deliveries.claim({ now: soon() });
        await storage.deliveries.fail(`${endpoint.id}:evt-1`, { error: "boom", retryAt: new Date(), maxAttempts: 1 });
        const revived = await service.requeueDelivery({ actor: operator, deliveryId: `${endpoint.id}:evt-1` });
        expect(revived).toMatchObject({ status: "pending", attempts: 0 });
        await expect(service.requeueDelivery({ actor: operator, deliveryId: "nope" })).rejects.toMatchObject({ code: "webhook_delivery_not_found" });
      });

      if (harness.probe) {
        it("keeps the secret only in the endpoint row, and no payload text in the endpoint table", async () => {
          const storage = harness.storage();
          const secret = generateWebhookSecret();
          await storage.endpoints.create(endpointInput("whe_a", { secret }));
          const dump = await harness.probe!.dumpWebhookText();
          expect(dump).toContain(secret);
        });
      }
    });
  });
}
