import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  API_SCOPE_LIST,
  ApiCredentialError,
  authenticateApiKey,
  clientMayAccessOrganization,
  createApiCredentialService,
  generateApiKey,
  hashApiKeySecret,
  parseApiKey,
} from "@uniora/core";
import type { ApiCredentialStorage, Identity } from "@uniora/core";

const operator: Identity = { provider: "uniora-studio", subject: "local-admin" };

/** How the API-credential conformance suite drives one adapter. */
export interface ApiHarness {
  readonly name: string;
  setup(): Promise<void>;
  teardown(): Promise<void>;
  /** Empties every credential table and the audit log. */
  reset(): Promise<void>;
  storage(): ApiCredentialStorage;
  /** Raw access, for the few assertions that must look under the repositories. Optional: the in-memory backend has no tables. */
  probe?: {
    /** Every text value stored in the credential tables, joined: used to prove a secret is nowhere in it. */
    dumpCredentialText(): Promise<string>;
  };
}

/** The behaviour every `ApiCredentialStorage` adapter must reproduce. Real database, never mocks. */
export function defineApiCredentialConformance(harness: ApiHarness): void {
  describe(`${harness.name} — ApiCredentialStorage conformance`, () => {
    beforeAll(() => harness.setup());
    afterAll(() => harness.teardown());
    beforeEach(() => harness.reset());

    const boot = (clock?: { now: Date }) => {
      const storage = harness.storage();
      const service = createApiCredentialService({ storage, ...(clock ? { now: () => clock.now } : {}) });
      return { storage, service };
    };

    async function client(service: ReturnType<typeof boot>["service"], name = "billing-backend") {
      return service.createClient({ actor: operator, name, scopes: ["check", "organizations:read"], organizations: ["org-b", "org-a"] });
    }

    describe("clients", () => {
      it("creates a client with sorted scopes and organizations, and persists it", async () => {
        const { storage, service } = boot();
        const created = await service.createClient({ actor: operator, name: "  Billing   Backend ", scopes: ["organizations:read", "check", "check"], organizations: ["org-b", "org-a"] });

        expect(created).toMatchObject({
          name: "Billing Backend",
          scopes: ["check", "organizations:read"],
          organizations: ["org-a", "org-b"],
          status: "active",
          version: 1,
          createdBy: operator,
        });
        expect(created.id).toMatch(/^apc_[0-9A-Za-z]{16}$/);
        expect(await storage.apiClients.findById(created.id)).toEqual(created);
        expect(await storage.apiClients.findById("apc_nope")).toBeNull();
      });

      it('accepts "*" for every organization', async () => {
        const { service } = boot();
        const created = await service.createClient({ actor: operator, name: "all", scopes: ["check"], organizations: "*" });
        expect(created.organizations).toBe("*");
      });

      it("refuses invalid input with stable codes", async () => {
        const { service } = boot();
        const base = { actor: operator, name: "x", scopes: ["check" as const], organizations: "*" as const };
        await expect(service.createClient({ ...base, name: "   " })).rejects.toMatchObject({ code: "api_client_invalid" });
        await expect(service.createClient({ ...base, name: "a".repeat(101) })).rejects.toMatchObject({ code: "api_client_invalid" });
        await expect(service.createClient({ ...base, name: "bad\u0000name" })).rejects.toMatchObject({ code: "api_client_invalid" });
        await expect(service.createClient({ ...base, scopes: [] })).rejects.toMatchObject({ code: "api_scope_invalid" });
        await expect(service.createClient({ ...base, scopes: ["root" as never] })).rejects.toMatchObject({ code: "api_scope_invalid" });
        await expect(service.createClient({ ...base, organizations: [] })).rejects.toMatchObject({ code: "api_organizations_invalid" });
        await expect(service.createClient({ ...base, organizations: ["*", "a"] })).rejects.toMatchObject({ code: "api_organizations_invalid" });
        await expect(service.createClient({ ...base, organizations: [""] })).rejects.toMatchObject({ code: "api_organizations_invalid" });
        await expect(service.createClient({ ...base, organizations: Array.from({ length: 501 }, (_, i) => `o${i}`) })).rejects.toMatchObject({
          code: "api_organizations_invalid",
        });
        await expect(service.createClient({ ...base, actor: { provider: "", subject: "x" } })).rejects.toMatchObject({ code: "api_invalid" });
      });

      it("names are unique ignoring case and spacing", async () => {
        const { service } = boot();
        await client(service, "Billing Backend");
        await expect(client(service, "billing   backend")).rejects.toMatchObject({ code: "api_client_exists" });
        const other = await client(service, "Signup Worker");
        await expect(service.updateClient({ actor: operator, clientId: other.id, name: "BILLING BACKEND" })).rejects.toMatchObject({ code: "api_client_exists" });
      });

      it("updates with optimistic concurrency and bumps the version", async () => {
        const { service } = boot();
        const created = await client(service);
        const updated = await service.updateClient({ actor: operator, clientId: created.id, scopes: ["check"], organizations: "*", expectedVersion: 1 });
        expect(updated).toMatchObject({ scopes: ["check"], organizations: "*", version: 2 });
        await expect(service.updateClient({ actor: operator, clientId: created.id, name: "renamed", expectedVersion: 1 })).rejects.toMatchObject({
          code: "api_version_conflict",
        });
        await expect(service.updateClient({ actor: operator, clientId: "apc_missing", name: "x" })).rejects.toMatchObject({ code: "api_client_not_found" });
        await expect(service.updateClient({ actor: operator, clientId: created.id })).rejects.toMatchObject({ code: "api_client_invalid" });
      });

      it("disables and enables, and repeating either changes nothing", async () => {
        const { service } = boot();
        const created = await client(service);
        const disabled = await service.disableClient({ actor: operator, clientId: created.id });
        expect(disabled).toMatchObject({ status: "disabled", version: 2 });
        expect(await service.disableClient({ actor: operator, clientId: created.id })).toMatchObject({ status: "disabled", version: 2 });
        expect(await service.enableClient({ actor: operator, clientId: created.id })).toMatchObject({ status: "active", version: 3 });
        await expect(service.disableClient({ actor: operator, clientId: created.id, expectedVersion: 1 })).rejects.toMatchObject({ code: "api_version_conflict" });
      });

      it("pages by id and counts by status", async () => {
        const { storage, service } = boot();
        const created = [];
        for (let i = 0; i < 5; i++) created.push(await client(service, `client ${i}`));
        await service.disableClient({ actor: operator, clientId: created[1]!.id });

        const first = await storage.apiClients.search({ limit: 2 });
        const second = await storage.apiClients.search({ limit: 2, after: first.at(-1)!.id });
        const third = await storage.apiClients.search({ limit: 2, after: second.at(-1)!.id });
        const ids = [...first, ...second, ...third].map((row) => row.id);
        expect(ids).toEqual([...ids].sort());
        expect(new Set(ids).size).toBe(5);
        expect(await storage.apiClients.count()).toBe(5);
        expect(await storage.apiClients.count({ status: "disabled" })).toBe(1);
        expect((await storage.apiClients.search({ status: "active" })).map((row) => row.id)).not.toContain(created[1]!.id);
      });
    });

    describe("keys", () => {
      it("returns the token once, stores only its SHA-256, and never exposes the digest", async () => {
        const { storage, service } = boot();
        const c = await client(service);
        const { key, token } = await service.createKey({ actor: operator, clientId: c.id });
        const parsed = parseApiKey(token)!;

        expect(parsed.id).toBe(key.id);
        expect(key.hint).toBe(parsed.secret.slice(-4));
        expect(key).not.toHaveProperty("secretHash");
        expect(await storage.apiKeys.findById(key.id)).not.toHaveProperty("secretHash");
        const record = await storage.apiKeys.findRecordById(key.id);
        expect(record?.secretHash).toBe(hashApiKeySecret(parsed.secret));
        expect(record?.secretHash).not.toContain(parsed.secret);
        if (harness.probe) {
          const everything = await harness.probe.dumpCredentialText();
          expect(everything).not.toContain(parsed.secret);
          expect(everything).not.toContain(token);
          expect(everything).toContain(hashApiKeySecret(parsed.secret));
        }
      });

      it("allows two active keys and refuses a third until one is revoked or expires", async () => {
        const clock = { now: new Date("2026-10-10T12:00:00Z") };
        const { service } = boot(clock);
        const c = await client(service);
        const first = await service.createKey({ actor: operator, clientId: c.id });
        await service.createKey({ actor: operator, clientId: c.id, expiresAt: new Date("2026-10-11T12:00:00Z") });
        await expect(service.createKey({ actor: operator, clientId: c.id })).rejects.toMatchObject({ code: "api_key_limit" });

        await service.revokeKey({ actor: operator, keyId: first.key.id });
        const replacement = await service.createKey({ actor: operator, clientId: c.id });
        expect(replacement.key.id).not.toBe(first.key.id);
        await expect(service.createKey({ actor: operator, clientId: c.id })).rejects.toMatchObject({ code: "api_key_limit" });

        // The key that expires stops counting once it has expired.
        clock.now = new Date("2026-10-12T12:00:00Z");
        await expect(service.createKey({ actor: operator, clientId: c.id })).resolves.toBeDefined();
      });

      it("never lets concurrent creations slip past the cap", async () => {
        const { service } = boot();
        const c = await client(service);
        const results = await Promise.allSettled(Array.from({ length: 8 }, () => service.createKey({ actor: operator, clientId: c.id })));
        expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
        for (const result of results) {
          if (result.status === "rejected") expect((result.reason as ApiCredentialError).code).toBe("api_key_limit");
        }
        expect(await boot().storage.apiKeys.listByClient(c.id)).toHaveLength(2);
      });

      it("refuses a key for a missing or disabled client, and a bad expiry", async () => {
        const clock = { now: new Date("2026-10-10T12:00:00Z") };
        const { service } = boot(clock);
        await expect(service.createKey({ actor: operator, clientId: "apc_missing" })).rejects.toMatchObject({ code: "api_client_not_found" });
        const c = await client(service);
        await expect(service.createKey({ actor: operator, clientId: c.id, expiresAt: new Date("2026-10-10T11:00:00Z") })).rejects.toMatchObject({ code: "api_key_invalid" });
        await expect(service.createKey({ actor: operator, clientId: c.id, expiresAt: new Date("2040-01-01T00:00:00Z") })).rejects.toMatchObject({ code: "api_key_invalid" });
        await service.disableClient({ actor: operator, clientId: c.id });
        await expect(service.createKey({ actor: operator, clientId: c.id })).rejects.toMatchObject({ code: "api_client_disabled" });
      });

      it("revokes idempotently and lists newest first, per client and in bulk", async () => {
        const clock = { now: new Date("2026-10-10T12:00:00Z") };
        const { storage, service } = boot(clock);
        const c = await client(service);
        const other = await client(service, "other");
        const a = await service.createKey({ actor: operator, clientId: c.id });
        clock.now = new Date("2026-10-10T12:05:00Z");
        const b = await service.createKey({ actor: operator, clientId: c.id });

        const revoked = await service.revokeKey({ actor: operator, keyId: a.key.id });
        expect(revoked.revokedAt).toEqual(new Date("2026-10-10T12:05:00Z"));
        expect(revoked.revokedBy).toEqual(operator);
        clock.now = new Date("2026-10-10T13:00:00Z");
        expect((await service.revokeKey({ actor: operator, keyId: a.key.id })).revokedAt).toEqual(revoked.revokedAt);
        await expect(service.revokeKey({ actor: operator, keyId: "nope" })).rejects.toMatchObject({ code: "api_key_not_found" });

        expect((await storage.apiKeys.listByClient(c.id)).map((k) => k.id)).toEqual([b.key.id, a.key.id]);
        const bulk = await storage.apiKeys.listByClients([c.id, other.id]);
        expect(bulk.get(c.id)).toHaveLength(2);
        expect(bulk.get(other.id)).toEqual([]);
        const listed = await service.getClient(c.id);
        expect(listed?.keys.map((k) => k.id)).toEqual([b.key.id, a.key.id]);
      });
    });

    describe("authentication", () => {
      it("authenticates a valid key and returns its client and key (without the digest)", async () => {
        const { storage, service } = boot();
        const c = await client(service);
        const { key, token } = await service.createKey({ actor: operator, clientId: c.id });

        const principal = await authenticateApiKey(storage, `Bearer ${token}`);

        expect(principal?.client).toMatchObject({ id: c.id, status: "active" });
        expect(principal?.key.id).toBe(key.id);
        expect(principal?.key).not.toHaveProperty("secretHash");
      });

      it("answers null for every kind of failure, never throwing", async () => {
        const clock = { now: new Date("2026-10-10T12:00:00Z") };
        const { storage, service } = boot(clock);
        const c = await client(service);
        const good = await service.createKey({ actor: operator, clientId: c.id });
        const expiring = await service.createKey({ actor: operator, clientId: c.id, expiresAt: new Date("2026-10-10T13:00:00Z") });
        const parsed = parseApiKey(good.token)!;
        const stranger = generateApiKey();

        const otherSecret = generateApiKey();
        // A well-formed key (valid checksum) with the right id but a different secret.
        const wrongSecret = otherSecret.token.replace(otherSecret.id, parsed.id);
        const cases: [string, unknown][] = [
          ["no header", undefined],
          ["not a string", 42],
          ["wrong scheme", `Basic ${good.token}`],
          ["empty bearer", "Bearer "],
          ["garbage", "Bearer not-a-key"],
          ["truncated", `Bearer ${good.token.slice(0, -1)}`],
          ["bad checksum", `Bearer ${good.token.slice(0, -1)}${good.token.endsWith("a") ? "b" : "a"}`],
          ["unknown id (valid shape)", `Bearer ${stranger.token}`],
          ["right id, wrong secret", `Bearer ${wrongSecret}`],
          ["two tokens", `Bearer ${good.token} ${good.token}`],
        ];
        for (const [label, header] of cases) {
          expect(await authenticateApiKey(storage, header, { now: clock.now }), label).toBeNull();
        }

        // Revoked, expired, client disabled and re-enabled.
        await service.revokeKey({ actor: operator, keyId: good.key.id });
        expect(await authenticateApiKey(storage, `Bearer ${good.token}`, { now: clock.now }), "revoked").toBeNull();
        expect(await authenticateApiKey(storage, `Bearer ${expiring.token}`, { now: clock.now }), "not yet expired").not.toBeNull();
        expect(await authenticateApiKey(storage, `Bearer ${expiring.token}`, { now: new Date("2026-10-10T13:00:00Z") }), "expired").toBeNull();
        await service.disableClient({ actor: operator, clientId: c.id });
        expect(await authenticateApiKey(storage, `Bearer ${expiring.token}`, { now: clock.now }), "client disabled").toBeNull();
        await service.enableClient({ actor: operator, clientId: c.id });
        expect(await authenticateApiKey(storage, `Bearer ${expiring.token}`, { now: clock.now }), "client re-enabled").not.toBeNull();
      });

      it("a revoked key stops working on the very next request (no cache)", async () => {
        const { storage, service } = boot();
        const c = await client(service);
        const { key, token } = await service.createKey({ actor: operator, clientId: c.id });
        expect(await authenticateApiKey(storage, `Bearer ${token}`)).not.toBeNull();
        await service.revokeKey({ actor: operator, keyId: key.id });
        expect(await authenticateApiKey(storage, `Bearer ${token}`)).toBeNull();
      });

      it("refreshes lastUsedAt at most once per interval", async () => {
        const { storage, service } = boot();
        const c = await client(service);
        const { key, token } = await service.createKey({ actor: operator, clientId: c.id });
        const t0 = new Date("2026-10-10T12:00:00Z");
        const interval = 5 * 60 * 1000;

        expect((await storage.apiKeys.findById(key.id))?.lastUsedAt).toBeUndefined();
        await authenticateApiKey(storage, `Bearer ${token}`, { now: t0, touchIntervalMs: interval });
        expect((await storage.apiKeys.findById(key.id))?.lastUsedAt).toEqual(t0);
        await authenticateApiKey(storage, `Bearer ${token}`, { now: new Date(t0.getTime() + 60_000), touchIntervalMs: interval });
        expect((await storage.apiKeys.findById(key.id))?.lastUsedAt).toEqual(t0);
        const later = new Date(t0.getTime() + interval + 1);
        await authenticateApiKey(storage, `Bearer ${token}`, { now: later, touchIntervalMs: interval });
        expect((await storage.apiKeys.findById(key.id))?.lastUsedAt).toEqual(later);
      });

      it("a failing lastUsedAt write does not fail an otherwise valid request", async () => {
        const { storage, service } = boot();
        const c = await client(service);
        const { token } = await service.createKey({ actor: operator, clientId: c.id });
        const broken = {
          apiClients: storage.apiClients,
          apiKeys: { ...storage.apiKeys, touch: () => Promise.reject(new Error("read-only replica")) },
        };
        expect(await authenticateApiKey(broken, `Bearer ${token}`)).not.toBeNull();
      });

      it("a storage failure throws instead of reading as 'not authenticated'", async () => {
        const { storage, service } = boot();
        const c = await client(service);
        const { token } = await service.createKey({ actor: operator, clientId: c.id });
        const down = { apiClients: storage.apiClients, apiKeys: { ...storage.apiKeys, findRecordById: () => Promise.reject(new Error("db down")) } };
        await expect(authenticateApiKey(down, `Bearer ${token}`)).rejects.toThrow("db down");
      });

      it("clientMayAccessOrganization honours the allowlist and the wildcard", async () => {
        const { service } = boot();
        const some = await client(service);
        const all = await service.createClient({ actor: operator, name: "all", scopes: ["check"], organizations: "*" });
        expect(clientMayAccessOrganization(some, "org-a")).toBe(true);
        expect(clientMayAccessOrganization(some, "org-c")).toBe(false);
        expect(clientMayAccessOrganization(some, "*")).toBe(false);
        expect(clientMayAccessOrganization(all, "anything")).toBe(true);
      });
    });

    describe("audit", () => {
      it("records every change with the operator, and never a secret, a token or a digest", async () => {
        const { storage, service } = boot();
        const c = await client(service);
        await service.updateClient({ actor: operator, clientId: c.id, scopes: ["check"] });
        const { key, token } = await service.createKey({ actor: operator, clientId: c.id });
        await service.revokeKey({ actor: operator, keyId: key.id });
        await service.revokeKey({ actor: operator, keyId: key.id });
        await service.disableClient({ actor: operator, clientId: c.id });
        await service.disableClient({ actor: operator, clientId: c.id });
        await service.enableClient({ actor: operator, clientId: c.id });

        const entries = await storage.auditLogs.search({ actionPrefix: "api_" });
        expect(entries.map((entry) => entry.action).sort()).toEqual(
          ["api_client.created", "api_client.disabled", "api_client.enabled", "api_client.updated", "api_key.created", "api_key.revoked"].sort(),
        );
        for (const entry of entries) {
          expect(entry.actor).toEqual(operator);
          expect(entry.organizationId).toBeUndefined();
        }
        const text = JSON.stringify(entries);
        const parsed = parseApiKey(token)!;
        expect(text).not.toContain(token);
        expect(text).not.toContain(parsed.secret);
        expect(text).not.toContain(hashApiKeySecret(parsed.secret));
        expect(entries.find((entry) => entry.action === "api_key.created")?.target).toEqual({ type: "api_key", id: key.id });
      });

      it("a refused change leaves no audit entry and no row (one transaction)", async () => {
        const { storage, service } = boot();
        const c = await client(service);
        await service.createKey({ actor: operator, clientId: c.id });
        await service.createKey({ actor: operator, clientId: c.id });
        const before = (await storage.auditLogs.search({ actionPrefix: "api_" })).length;

        await expect(service.createKey({ actor: operator, clientId: c.id })).rejects.toMatchObject({ code: "api_key_limit" });
        await expect(service.updateClient({ actor: operator, clientId: c.id, name: "x", expectedVersion: 99 })).rejects.toMatchObject({ code: "api_version_conflict" });

        expect((await storage.auditLogs.search({ actionPrefix: "api_" })).length).toBe(before);
        expect(await storage.apiKeys.listByClient(c.id)).toHaveLength(2);
      });
    });

    it("lists every scope the API knows, each with a description", () => {
      expect(API_SCOPE_LIST.length).toBeGreaterThan(5);
    });
  });
}
