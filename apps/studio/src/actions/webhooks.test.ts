import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryWebhookStorage, createWebhookService } from "@uniora/core";
import type { WebhookStorage } from "@uniora/core";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/i18n/server", () => ({
  getT: async () => ({ locale: "en", t: (key: string, params?: Record<string, unknown>) => `${key}${params ? JSON.stringify(params) : ""}` }),
}));
vi.mock("@/lib/env", () => ({ getStudioEnv: () => ({ operator: "tester" }) }));

const state = vi.hoisted(() => ({ storage: null as unknown as WebhookStorage }));
vi.mock("@/lib/db", () => ({ getStorage: () => ({}), getWebhookStorage: () => state.storage }));

const session = vi.hoisted(() => ({ requireWrite: vi.fn(async () => {}) }));
vi.mock("@/lib/session", async () => {
  class StudioAuthError extends Error {}
  class StudioReadOnlyError extends Error {}
  return { StudioAuthError, StudioReadOnlyError, requireWrite: session.requireWrite };
});

import { createWebhook, deleteWebhook, requeueWebhookDelivery, rotateWebhookSecret, setWebhookEnabled, updateWebhook } from "./webhooks";

beforeEach(() => {
  state.storage = createMemoryWebhookStorage();
  session.requireWrite.mockReset();
  session.requireWrite.mockResolvedValue(undefined);
});

const service = () => createWebhookService({ storage: state.storage });
const valid = { url: "https://hooks.example.com/uniora", events: ["membership.*"], allOrganizations: true };

describe("webhook actions", () => {
  it("register an endpoint as the Studio operator and return its secret once", async () => {
    const created = await createWebhook({ ...valid, description: "Billing" });
    expect(created).toMatchObject({ ok: true });
    const { id, secret } = (created as { data: { id: string; secret: string } }).data;
    expect(secret).toMatch(/^whsec_/);
    const stored = await service().getEndpoint(id);
    expect(stored).toMatchObject({ events: ["membership.*"], organizations: "*", description: "Billing", createdBy: { provider: "uniora-studio", subject: "tester" } });
    expect(JSON.stringify(stored)).not.toContain(secret);
    expect(await state.storage.endpoints.signingSecrets(id)).toEqual([secret]);
  });

  it("refuse in read-only mode without touching anything", async () => {
    const { StudioReadOnlyError } = await import("@/lib/session");
    session.requireWrite.mockRejectedValue(new StudioReadOnlyError());
    expect(await createWebhook(valid)).toMatchObject({ ok: false, error: "errors.readOnly" });
    expect(await service().listEndpoints()).toEqual([]);
  });

  it("refuse an unsafe URL, malformed events and a list that could mean everything", async () => {
    for (const url of ["http://hooks.example.com/", "https://127.0.0.1/x", "https://169.254.169.254/", "https://user:pw@hooks.example.com/", "not a url"]) {
      expect(await createWebhook({ ...valid, url }), url).toMatchObject({ ok: false });
    }
    expect(await createWebhook({ ...valid, events: ["Not.Valid"] })).toMatchObject({ ok: false, error: "errors.webhookEvents" });
    expect(await createWebhook({ ...valid, events: [] })).toMatchObject({ ok: false });
    expect(await createWebhook({ ...valid, events: "*" as never })).toMatchObject({ ok: false });
    expect(await createWebhook({ ...valid, allOrganizations: false, organizations: [] })).toMatchObject({ ok: false });
    expect(await createWebhook({ ...valid, allOrganizations: "yes" as never })).toMatchObject({ ok: false });
    expect(await createWebhook(undefined as never)).toMatchObject({ ok: false });
    expect(await service().listEndpoints()).toEqual([]);
    expect(await createWebhook({ ...valid, allOrganizations: false, organizations: ["org_a", "org_a", " org_b "] })).toMatchObject({ ok: true });
    expect((await service().listEndpoints())[0]!.organizations).toEqual(["org_a", "org_b"]);
  });

  it("update with the version it was loaded at, and refuse a stale one", async () => {
    const { data } = (await createWebhook(valid)) as { data: { id: string } };
    const loaded = (await service().getEndpoint(data.id))!;
    expect(await updateWebhook({ endpointId: data.id, expectedVersion: loaded.version, events: ["*"], description: "All" })).toMatchObject({ ok: true });
    expect(await updateWebhook({ endpointId: data.id, expectedVersion: loaded.version, events: ["role.*"] })).toMatchObject({ ok: false });
    expect(await updateWebhook({ endpointId: data.id, expectedVersion: loaded.version + 1, description: "" })).toMatchObject({ ok: true });
    const stored = (await service().getEndpoint(data.id))!;
    expect(stored.events).toEqual(["*"]);
    expect(stored.description).toBeUndefined();
    expect(await updateWebhook({ endpointId: data.id, expectedVersion: 0 })).toMatchObject({ ok: false });
  });

  it("disable, enable, rotate (the old secret keeps signing for the grace) and delete", async () => {
    const { data } = (await createWebhook(valid)) as { data: { id: string; secret: string } };
    expect(await setWebhookEnabled({ endpointId: data.id, enabled: false })).toMatchObject({ ok: true });
    expect((await service().getEndpoint(data.id))!.status).toBe("disabled");
    expect(await setWebhookEnabled({ endpointId: data.id, enabled: true })).toMatchObject({ ok: true });

    const rotated = await rotateWebhookSecret({ endpointId: data.id, graceHours: 2 });
    const { secret } = (rotated as { data: { secret: string } }).data;
    expect(secret).not.toBe(data.secret);
    expect(await state.storage.endpoints.signingSecrets(data.id)).toEqual([secret, data.secret]);
    expect(await rotateWebhookSecret({ endpointId: data.id, graceHours: 0 })).toMatchObject({ ok: true });
    expect(await state.storage.endpoints.signingSecrets(data.id)).toHaveLength(1);
    expect(await rotateWebhookSecret({ endpointId: data.id, graceHours: 500 })).toMatchObject({ ok: false, error: "errors.webhookGrace" });
    expect(await rotateWebhookSecret({ endpointId: data.id, graceHours: 1.5 })).toMatchObject({ ok: false });

    expect(await deleteWebhook({ endpointId: data.id })).toMatchObject({ ok: true });
    expect(await service().getEndpoint(data.id)).toBeNull();
    expect(await deleteWebhook({ endpointId: data.id })).toMatchObject({ ok: false });
  });

  it("send a dead delivery again, and only a dead one", async () => {
    const { data } = (await createWebhook(valid)) as { data: { id: string } };
    await state.storage.deliveries.enqueue({ id: `${data.id}:evt-1`, endpointId: data.id, eventId: "evt-1", eventType: "membership.blocked", eventCreatedAt: new Date() });
    expect(await requeueWebhookDelivery({ deliveryId: `${data.id}:evt-1` })).toMatchObject({ ok: false });
    await state.storage.deliveries.claim({ now: new Date() });
    await state.storage.deliveries.fail(`${data.id}:evt-1`, { error: "boom", retryAt: new Date(), maxAttempts: 1 });
    expect(await requeueWebhookDelivery({ deliveryId: `${data.id}:evt-1` })).toMatchObject({ ok: true });
    expect((await state.storage.deliveries.findById(`${data.id}:evt-1`))!.status).toBe("pending");
  });
});
