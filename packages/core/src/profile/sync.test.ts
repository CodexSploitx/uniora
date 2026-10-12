import { describe, expect, it, vi } from "vitest";
import { createMemoryStorage } from "../storage/memory.js";
import { createOrganizationWithOwner } from "../organization/create-with-owner.js";
import { listMembersWithProfiles } from "./profiles.js";
import { createProfileSync } from "./sync.js";

const ana = { provider: "supabase", subject: "ana" };

describe("createProfileSync", () => {
  it("fills in the profile of a member who existed before profiles did, the first time they are seen", async () => {
    const storage = createMemoryStorage();
    await createOrganizationWithOwner(storage, { organizationId: "o", organizationName: "Acme", ownerRoleId: "r", membershipId: "m", ownerIdentity: ana });
    expect((await listMembersWithProfiles(storage, undefined, { organizationId: "o", rolesPerMember: 1 }))[0]?.profile).toBeUndefined();

    const sync = createProfileSync(storage);
    await sync(ana, { displayName: "Ana Pérez", email: "ana@example.com", avatarUrl: "https://cdn.example.com/ana.png" });

    const [member] = await listMembersWithProfiles(storage, undefined, { organizationId: "o", rolesPerMember: 1 });
    expect(member?.profile).toEqual({ displayName: "Ana Pérez", email: "ana@example.com", avatarUrl: "https://cdn.example.com/ana.png" });
  });

  it("does not write an unchanged profile again within the interval, but writes a change at once and after the interval", async () => {
    const storage = createMemoryStorage();
    const upsert = vi.spyOn(storage.profiles, "upsert");
    let clock = 0;
    const sync = createProfileSync(storage, { minIntervalMs: 1000, now: () => clock });

    await sync(ana, { displayName: "Ana" });
    await sync(ana, { displayName: "Ana" });
    expect(upsert).toHaveBeenCalledTimes(1);

    await sync(ana, { displayName: "Ana María" });
    expect(upsert).toHaveBeenCalledTimes(2);

    clock = 5000;
    await sync(ana, { displayName: "Ana María" });
    expect(upsert).toHaveBeenCalledTimes(3);
  });

  it("ignores an empty profile and never rejects when the store fails (the next request retries)", async () => {
    const storage = createMemoryStorage();
    const upsert = vi.spyOn(storage.profiles, "upsert");
    const onError = vi.fn();
    const sync = createProfileSync(storage, { onError });

    await sync(ana, {});
    await sync(ana, undefined);
    expect(upsert).not.toHaveBeenCalled();

    upsert.mockRejectedValueOnce(new Error("db down"));
    await expect(sync(ana, { displayName: "Ana" })).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);

    await sync(ana, { displayName: "Ana" });
    expect(upsert).toHaveBeenCalledTimes(2);
    expect((await storage.profiles.findMany([ana]))[0]?.displayName).toBe("Ana");
  });

  it("leaves out what the provider did not give, so a stored name survives a sync that only has the e-mail", async () => {
    const storage = createMemoryStorage();
    const sync = createProfileSync(storage, { minIntervalMs: 0 });
    await sync(ana, { displayName: "Ana", email: "ana@example.com" });
    await sync(ana, { email: "ana@new.example.com" });
    expect((await storage.profiles.findMany([ana]))[0]).toMatchObject({ displayName: "Ana", email: "ana@new.example.com" });
  });
});
