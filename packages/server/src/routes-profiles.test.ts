import { afterEach, describe, expect, it } from "vitest";
import { BACKENDS, startFixture } from "./test-support/harness.js";
import type { BackendName, Fixture } from "./test-support/harness.js";

const open: Fixture[] = [];
afterEach(async () => {
  while (open.length > 0) await open.pop()!.stop();
});
async function start(name: BackendName) {
  const f = await startFixture(name);
  open.push(f);
  const issued = await f.issue();
  const call = (method: string, path: string, init: { body?: unknown; headers?: Record<string, string>; token?: string } = {}) => f.call(method, path, { token: issued.token, ...init });
  return { f, ...issued, call };
}
const ana = { subject: "ana" };
const profile = { displayName: "Ana Pérez", email: "ana@example.com", avatarUrl: "https://cdn.example.com/avatars/ana.png" };

describe.each(BACKENDS)("profiles over %s", (backend) => {
  async function org(call: Awaited<ReturnType<typeof start>>["call"], name: string, owner = "ana") {
    const created = await call("POST", "/v1/organizations", { body: { name, owner: { subject: owner } } });
    expect(created.status).toBe(201);
    return { id: created.body.organization.id as string, membershipId: created.body.membership.id as string };
  }

  it("stores a profile and every member read carries it, only for the people who have one", async () => {
    const { call } = await start(backend);
    const acme = await org(call, "Beauty Salon");
    const second = await call("POST", `/v1/organizations`, { body: { name: "Other", owner: { subject: "ben" } } });
    expect(second.status).toBe(201);

    const put = await call("PUT", "/v1/profiles", { body: { profiles: [{ identity: ana, ...profile }] } });
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ stored: 1, empty: 0 });

    const list = await call("GET", `/v1/organizations/${acme.id}/members`);
    expect(list.body.items[0].profile).toEqual(profile);
    const got = await call("GET", `/v1/organizations/${acme.id}/members/${acme.membershipId}`);
    expect(got.body.profile).toEqual(profile);

    const benOrg = second.body.organization.id as string;
    const ben = await call("GET", `/v1/organizations/${benOrg}/members`);
    expect(ben.body.items[0].profile).toBeUndefined();
  });

  it("is one profile for the person in every organization", async () => {
    const { call } = await start(backend);
    const one = await org(call, "One");
    const two = await org(call, "Two");
    await call("PUT", "/v1/profiles", { body: { profiles: [{ identity: ana, displayName: "Ana" }] } });
    expect((await call("GET", `/v1/organizations/${one.id}/members/${one.membershipId}`)).body.profile).toEqual({ displayName: "Ana" });
    expect((await call("GET", `/v1/organizations/${two.id}/members/${two.membershipId}`)).body.profile).toEqual({ displayName: "Ana" });
  });

  it("keeps a field left out, clears one sent as null, and drops a profile left empty", async () => {
    const { call } = await start(backend);
    const acme = await org(call, "Beauty Salon");
    const read = async () => (await call("GET", `/v1/organizations/${acme.id}/members/${acme.membershipId}`)).body.profile;
    await call("PUT", "/v1/profiles", { body: { profiles: [{ identity: ana, ...profile }] } });

    await call("PUT", "/v1/profiles", { body: { profiles: [{ identity: ana, email: "ana@new.example.com" }] } });
    expect(await read()).toEqual({ ...profile, email: "ana@new.example.com" });

    await call("PUT", "/v1/profiles", { body: { profiles: [{ identity: ana, avatarUrl: null }] } });
    expect(await read()).toEqual({ displayName: "Ana Pérez", email: "ana@new.example.com" });

    const cleared = await call("PUT", "/v1/profiles", { body: { profiles: [{ identity: ana, displayName: null, email: null }] } });
    expect(cleared.body).toEqual({ stored: 0, empty: 1 });
    expect(await read()).toBeUndefined();
  });

  it("finds a member by the name or e-mail of the profile, next to the id match", async () => {
    const { call } = await start(backend);
    const acme = await org(call, "Beauty Salon", "2eb65215-291a-4ced-a624-abdaff8d0723");
    await call("PUT", "/v1/profiles", { body: { profiles: [{ identity: { subject: "2eb65215-291a-4ced-a624-abdaff8d0723" }, displayName: "Carla Gómez", email: "carla@beauty.example" }] } });

    const ids = async (q: string) => (await call("GET", `/v1/organizations/${acme.id}/members?q=${encodeURIComponent(q)}`)).body.items.map((m: { id: string }) => m.id);
    expect(await ids("gómez")).toEqual([acme.membershipId]);
    expect(await ids("BEAUTY.example")).toEqual([acme.membershipId]);
    expect(await ids("2eb65215")).toEqual([acme.membershipId]);
    expect(await ids("nobody")).toEqual([]);
  });

  it("refuses what is not a profile: other kinds of address, objects, unknown fields, empty and oversized calls", async () => {
    const { call } = await start(backend);
    const bad = async (profiles: unknown) => (await call("PUT", "/v1/profiles", { body: { profiles } })).status;
    expect(await bad([{ identity: ana, avatarUrl: "javascript:alert(1)" }])).toBe(400);
    expect(await bad([{ identity: ana, avatarUrl: "data:image/png;base64,AAAA" }])).toBe(400);
    expect(await bad([{ identity: ana, avatarUrl: { url: "https://cdn.example.com/a.png" } }])).toBe(400);
    expect(await bad([{ identity: ana, displayName: "" }])).toBe(400);
    expect(await bad([{ identity: ana, displayName: "x".repeat(321) }])).toBe(400);
    expect(await bad([{ identity: ana, role: "owner" }])).toBe(400);
    expect(await bad([])).toBe(400);
    expect(await bad(Array.from({ length: 101 }, (_, i) => ({ identity: { subject: `u${i}` }, displayName: "x" })))).toBe(400);
    expect((await call("PUT", "/v1/profiles", { body: {} })).status).toBe(400);
    expect(await bad(Array.from({ length: 100 }, (_, i) => ({ identity: { subject: `u${i}` }, displayName: "x" })))).toBe(200);
  });

  it("stores all the people of a call or none: a bad identity refuses the whole call", async () => {
    const { f, call } = await start(backend);
    const acme = await org(call, "Beauty Salon");
    const refused = await call("PUT", "/v1/profiles", { body: { profiles: [{ identity: ana, displayName: "Ana" }, { identity: { provider: "uniora-api", subject: "z" }, displayName: "Z" }] } });
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe("identity_provider_reserved");
    expect(await f.backend.storage.profiles.findMany([{ provider: "main", subject: "ana" }])).toEqual([]);
    expect((await call("GET", `/v1/organizations/${acme.id}/members/${acme.membershipId}`)).body.profile).toBeUndefined();
  });

  it("needs its own scope and a client with every organization, and is not audited", async () => {
    const { f, call } = await start(backend);
    const acme = await org(call, "Beauty Salon");
    const body = { profiles: [{ identity: ana, displayName: "Ana" }] };
    const noScope = await f.issue({ scopes: ["check", "organizations:read", "organizations:create"] });
    expect((await call("PUT", "/v1/profiles", { body, token: noScope.token })).status).toBe(403);
    const limited = await f.issue({ organizations: [acme.id] });
    expect((await call("PUT", "/v1/profiles", { body, token: limited.token })).status).toBe(403);
    expect((await f.call("PUT", "/v1/profiles", { body, token: null })).status).toBe(401);
    expect(await f.backend.storage.profiles.findMany([{ provider: "main", subject: "ana" }])).toEqual([]);

    const entries = async () => (await f.backend.storage.auditLogs.search({ limit: 1000 })).length;
    const before = await entries();
    expect((await call("PUT", "/v1/profiles", { body })).status).toBe(200);
    expect(await entries()).toBe(before);
  });

  it("stores the owner's profile at sign-up, in the same transaction, only for a client that may write profiles", async () => {
    const { f, call } = await start(backend);
    const withProfile = { name: "Initech", owner: { subject: "dana" }, ownerProfile: { displayName: "Dana Lee", email: "dana@initech.example" } };
    const created = await call("POST", "/v1/organizations", { body: withProfile });
    expect(created.status).toBe(201);
    const orgId = created.body.organization.id as string;
    expect((await call("GET", `/v1/organizations/${orgId}/members/${created.body.membership.id}`)).body.profile).toEqual({ displayName: "Dana Lee", email: "dana@initech.example" });

    const signupOnly = await f.issue({ scopes: ["organizations:create"] });
    const before = (await call("GET", "/v1/organizations")).body.items.length;
    const refused = await call("POST", "/v1/organizations", { body: { ...withProfile, name: "Initech 2", owner: { subject: "eve" } }, token: signupOnly.token });
    expect(refused.status).toBe(403);
    expect((await call("GET", "/v1/organizations")).body.items.length).toBe(before);
    expect(await f.backend.storage.profiles.findMany([{ provider: "main", subject: "eve" }])).toEqual([]);

    // Without a profile, the same limited client signs up as before.
    expect((await call("POST", "/v1/organizations", { body: { name: "Initech 3", owner: { subject: "eve" } }, token: signupOnly.token })).status).toBe(201);
  });
});
