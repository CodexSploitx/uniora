import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApiCredentialService, createMemoryApiCredentialStorage } from "@uniora/core";
import type { ApiCredentialStorage } from "@uniora/core";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/i18n/server", () => ({
  getT: async () => ({ locale: "en", t: (key: string, params?: Record<string, unknown>) => `${key}${params ? JSON.stringify(params) : ""}` }),
}));
vi.mock("@/lib/env", () => ({ getStudioEnv: () => ({ operator: "tester" }) }));

const state = vi.hoisted(() => ({ storage: null as unknown as ApiCredentialStorage }));
vi.mock("@/lib/db", () => ({ getStorage: () => ({}), getApiCredentialStorage: () => state.storage }));

const session = vi.hoisted(() => ({ requireWrite: vi.fn(async () => {}) }));
vi.mock("@/lib/session", async () => {
  class StudioAuthError extends Error {}
  class StudioReadOnlyError extends Error {}
  return { StudioAuthError, StudioReadOnlyError, requireWrite: session.requireWrite };
});

import { createApiClient, createApiKey, revokeApiKey, setApiClientEnabled, updateApiClient } from "./api-clients";

beforeEach(() => {
  state.storage = createMemoryApiCredentialStorage();
  session.requireWrite.mockReset();
  session.requireWrite.mockResolvedValue(undefined);
});

const service = () => createApiCredentialService({ storage: state.storage });
const valid = { name: "billing", scopes: ["check"], allOrganizations: true };

describe("api client actions", () => {
  it("create a client as the Studio operator and key it once", async () => {
    const created = await createApiClient(valid);
    expect(created).toMatchObject({ ok: true });
    const clientId = (created as { data: { id: string } }).data.id;

    const key = await createApiKey({ clientId });
    expect(key).toMatchObject({ ok: true });
    const { token, keyId } = (key as { data: { token: string; keyId: string } }).data;
    expect(token).toMatch(/^uniora_sk_/);

    const stored = await service().getClient(clientId);
    expect(stored).toMatchObject({ name: "billing", organizations: "*", createdBy: { provider: "uniora-studio", subject: "tester" } });
    expect(stored!.keys[0]!.id).toBe(keyId);
    expect(JSON.stringify(stored)).not.toContain(token);
  });

  it("refuse in read-only mode without touching the credentials", async () => {
    const { StudioReadOnlyError } = await import("@/lib/session");
    session.requireWrite.mockRejectedValue(new StudioReadOnlyError());
    expect(await createApiClient(valid)).toMatchObject({ ok: false, error: "errors.readOnly" });
    expect(await service().listClients()).toEqual([]);
  });

  it("an empty organization list can never mean every organization", async () => {
    expect(await createApiClient({ ...valid, allOrganizations: false, organizations: [] })).toMatchObject({ ok: false });
    expect(await createApiClient({ ...valid, allOrganizations: "yes" as never })).toMatchObject({ ok: false });
    expect(await createApiClient({ name: "x", scopes: ["check"], allOrganizations: false })).toMatchObject({ ok: false });
    expect(await service().listClients()).toEqual([]);
    expect(await createApiClient({ ...valid, allOrganizations: false, organizations: ["org_a", "org_a", " org_b "] })).toMatchObject({ ok: true });
    expect((await service().listClients())[0]!.organizations).toEqual(["org_a", "org_b"]);
  });

  it("refuse unknown scopes, empty scopes and bad types from the browser", async () => {
    expect(await createApiClient({ ...valid, scopes: ["root"] })).toMatchObject({ ok: false, error: "errors.scopeUnknown" });
    expect(await createApiClient({ ...valid, scopes: [] })).toMatchObject({ ok: false });
    expect(await createApiClient({ ...valid, scopes: "check" as never })).toMatchObject({ ok: false });
    expect(await createApiClient({ ...valid, name: 5 as never })).toMatchObject({ ok: false });
    expect(await createApiClient(undefined as never)).toMatchObject({ ok: false });
  });

  it("update with the version it was loaded at, and refuse a stale one", async () => {
    const { data } = (await createApiClient(valid)) as { data: { id: string } };
    const loaded = (await service().getClient(data.id))!;
    expect(await updateApiClient({ clientId: data.id, expectedVersion: loaded.version, scopes: ["check", "organizations:read"] })).toMatchObject({ ok: true });
    const stale = await updateApiClient({ clientId: data.id, expectedVersion: loaded.version, scopes: ["check"] });
    expect(stale).toMatchObject({ ok: false });
    expect((await service().getClient(data.id))!.scopes).toEqual(["check", "organizations:read"]);
  });

  it("disabling a client stops its keys, enabling brings them back, and a key can be revoked", async () => {
    const { data } = (await createApiClient(valid)) as { data: { id: string } };
    const { data: key } = (await createApiKey({ clientId: data.id })) as { data: { keyId: string } };
    expect(await setApiClientEnabled({ clientId: data.id, enabled: false })).toMatchObject({ ok: true });
    expect((await service().getClient(data.id))!.status).toBe("disabled");
    expect(await setApiClientEnabled({ clientId: data.id, enabled: true })).toMatchObject({ ok: true });
    expect(await revokeApiKey({ keyId: key.keyId })).toMatchObject({ ok: true });
    expect((await service().getClient(data.id))!.keys[0]!.revokedAt).toBeInstanceOf(Date);
  });

  it("stop at two active keys and show the domain message", async () => {
    const { data } = (await createApiClient(valid)) as { data: { id: string } };
    await createApiKey({ clientId: data.id });
    await createApiKey({ clientId: data.id });
    const third = await createApiKey({ clientId: data.id });
    expect(third).toMatchObject({ ok: false });
    expect((third as { error: string }).error).not.toBe("errors.unexpected");
  });

  it("validate the key lifetime", async () => {
    const { data } = (await createApiClient(valid)) as { data: { id: string } };
    expect(await createApiKey({ clientId: data.id, expiresInDays: 0 })).toMatchObject({ ok: false, error: "errors.keyLifetime" });
    expect(await createApiKey({ clientId: data.id, expiresInDays: 2000 })).toMatchObject({ ok: false, error: "errors.keyLifetime" });
    expect(await createApiKey({ clientId: data.id, expiresInDays: 30 })).toMatchObject({ ok: true });
  });
});
