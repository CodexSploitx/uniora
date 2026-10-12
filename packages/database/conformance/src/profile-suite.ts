import { expect, it } from "vitest";
import { MAX_PROFILE_BATCH, createOrganizationWithOwner } from "@uniora/core";
import type { StorageHarness } from "./harness.js";

const ana = { provider: "supabase", subject: "ana" };
const ben = { provider: "supabase", subject: "ben" };

/** The stored name, e-mail and avatar URL of a person: the same rules on every adapter. */
export function defineProfileConformance(harness: StorageHarness): void {
  it("stores a profile and reads it back by identity", async () => {
    const { profiles } = harness.storage();
    const stored = await profiles.upsert(ana, { displayName: "Ana Pérez", email: "ana@example.com", avatarUrl: "https://cdn.example.com/ana.png" });
    expect(stored).toMatchObject({ identity: ana, displayName: "Ana Pérez", email: "ana@example.com", avatarUrl: "https://cdn.example.com/ana.png" });
    expect(stored?.updatedAt).toBeInstanceOf(Date);

    const found = await profiles.findMany([ana, ben]);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ identity: ana, displayName: "Ana Pérez" });
  });

  it("keeps a field that was left out and clears one that is null", async () => {
    const { profiles } = harness.storage();
    await profiles.upsert(ana, { displayName: "Ana", email: "ana@example.com", avatarUrl: "https://cdn.example.com/a.png" });

    // A sync that only knows the e-mail must not wipe the name or the avatar a previous one stored.
    const onlyEmail = await profiles.upsert(ana, { email: "ana@new.example.com" });
    expect(onlyEmail).toMatchObject({ displayName: "Ana", email: "ana@new.example.com", avatarUrl: "https://cdn.example.com/a.png" });

    const noAvatar = await profiles.upsert(ana, { avatarUrl: null });
    expect(noAvatar?.displayName).toBe("Ana");
    expect(noAvatar?.avatarUrl).toBeUndefined();
  });

  it("drops what is not usable: blank text, and an avatar that is not an http(s) URL", async () => {
    const { profiles } = harness.storage();
    const stored = await profiles.upsert(ana, { displayName: "  Ana  ", email: "   ", avatarUrl: "javascript:alert(1)" });
    expect(stored).toMatchObject({ displayName: "Ana" });
    expect(stored?.email).toBeUndefined();
    expect(stored?.avatarUrl).toBeUndefined();

    expect(await profiles.upsert(ben, { avatarUrl: "data:image/png;base64,AAAA" })).toBeNull();
    expect(await profiles.findMany([ben])).toEqual([]);
    // An object is not an avatar: only a URL is ever kept.
    expect(await profiles.upsert(ben, { avatarUrl: { url: "https://cdn.example.com/b.png" } as unknown as string })).toBeNull();
  });

  it("removes the row when the last field is cleared, and delete() says whether there was one", async () => {
    const { profiles } = harness.storage();
    await profiles.upsert(ana, { displayName: "Ana" });
    expect(await profiles.upsert(ana, { displayName: null })).toBeNull();
    expect(await profiles.findMany([ana])).toEqual([]);
    expect(await profiles.upsert(ben, { displayName: null })).toBeNull();

    await profiles.upsert(ana, { email: "ana@example.com" });
    expect(await profiles.delete(ana)).toBe(true);
    expect(await profiles.delete(ana)).toBe(false);
  });

  it("keeps two providers' same subject apart, and answers a batch with repeated identities", async () => {
    const { profiles } = harness.storage();
    await profiles.upsert({ provider: "clerk", subject: "u1" }, { displayName: "Clerk One" });
    await profiles.upsert({ provider: "auth0", subject: "u1" }, { displayName: "Auth0 One" });
    const found = await profiles.findMany([{ provider: "clerk", subject: "u1" }, { provider: "clerk", subject: "u1" }, { provider: "auth0", subject: "u1" }]);
    expect(found.map((entry) => `${entry.identity.provider}:${entry.displayName}`).sort()).toEqual(["auth0:Auth0 One", "clerk:Clerk One"]);
    expect(await profiles.findMany([])).toEqual([]);
  });

  it("stores quotes, percent signs and unicode as plain text", async () => {
    const { profiles } = harness.storage();
    const name = `O'Brien "100%" — 山田 太郎`;
    await profiles.upsert({ provider: "supabase", subject: "it's;--" }, { displayName: name });
    const [found] = await profiles.findMany([{ provider: "supabase", subject: "it's;--" }]);
    expect(found?.displayName).toBe(name);
  });

  it("handles a full batch, and a transaction that rolls back leaves no profile", async () => {
    const storage = harness.storage();
    const many = Array.from({ length: MAX_PROFILE_BATCH }, (_, index) => ({ provider: "supabase", subject: `bulk-${index}` }));
    await storage.transaction(async (tx) => {
      for (const identity of many) await tx.profiles.upsert(identity, { displayName: identity.subject });
    });
    expect(await storage.profiles.findMany(many)).toHaveLength(MAX_PROFILE_BATCH);

    await expect(
      storage.transaction(async (tx) => {
        await tx.profiles.upsert(ben, { displayName: "Ben" });
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(await storage.profiles.findMany([ben])).toEqual([]);
  });

  it("lists members with the stored profile of each, in one round trip per page", async () => {
    const storage = harness.storage();
    await createOrganizationWithOwner(storage, { organizationId: "org-p", organizationName: "Profiles", ownerRoleId: "role-p", membershipId: "mem-p", ownerIdentity: ana });
    await storage.profiles.upsert(ana, { displayName: "Ana Pérez", email: "ana@example.com", avatarUrl: "https://cdn.example.com/ana.png" });

    const { listMembersWithProfiles } = await import("@uniora/core");
    const members = await listMembersWithProfiles(storage, undefined, { organizationId: "org-p", limit: 10, rolesPerMember: 1 });
    expect(members).toHaveLength(1);
    expect(members[0]?.profile).toEqual({ displayName: "Ana Pérez", email: "ana@example.com", avatarUrl: "https://cdn.example.com/ana.png" });
  });

  it("searches profiles by name or e-mail, ignoring case and matching % and _ literally", async () => {
    const { profiles } = harness.storage();
    await profiles.upsert(ana, { displayName: "Ana Pérez", email: "ana@example.com" });
    await profiles.upsert(ben, { displayName: "Ben Ruiz", email: "ben.ruiz@acme.io" });
    await profiles.upsert({ provider: "supabase", subject: "cy" }, { displayName: "100% Cyan_Blue" });

    expect((await profiles.search({ query: "PÉREZ" })).map((entry) => entry.identity.subject)).toEqual(["ana"]);
    expect((await profiles.search({ query: "acme" })).map((entry) => entry.identity.subject)).toEqual(["ben"]);
    expect((await profiles.search({ query: "a" })).map((entry) => entry.identity.subject)).toEqual(["ana", "ben", "cy"]);
    expect((await profiles.search({ query: "a", limit: 2 })).map((entry) => entry.identity.subject)).toEqual(["ana", "ben"]);
    expect((await profiles.search({ query: "100%" })).map((entry) => entry.identity.subject)).toEqual(["cy"]);
    expect(await profiles.search({ query: "%" })).toHaveLength(1);
    expect(await profiles.search({ query: "n_b" })).toHaveLength(1);
    expect(await profiles.search({ query: "zzz" })).toEqual([]);
    expect(await profiles.search({ query: "   " })).toEqual([]);
  });

  it("finds a member by the name or e-mail of their profile, next to the id match, in listings, searches and counts", async () => {
    const storage = harness.storage();
    const carla = { provider: "supabase", subject: "2eb65215-291a-4ced-a624-abdaff8d0723" };
    const dani = { provider: "supabase", subject: "dani-id" };
    await createOrganizationWithOwner(storage, { organizationId: "org-s", organizationName: "Search", ownerRoleId: "role-s", membershipId: "mem-carla", ownerIdentity: carla });
    await storage.memberships.create({ id: "mem-dani", organizationId: "org-s", identity: dani });
    await storage.organizations.create({ id: "org-t", name: "Other" });
    await storage.memberships.create({ id: "mem-carla-t", organizationId: "org-t", identity: carla });
    await storage.profiles.upsert(carla, { displayName: "Carla Gómez", email: "carla@example.com" });

    // Without the profile, "carla" finds nobody: the id is a UUID.
    expect(await storage.memberships.count({ query: "carla" })).toBe(0);

    const found = await storage.profiles.search({ query: "carla" });
    const orIdentities = found.map((entry) => entry.identity);
    expect(orIdentities).toEqual([carla]);

    const listing = await storage.memberships.searchListing({ query: "carla", orIdentities, rolesPerMember: 1 });
    expect(listing.map((member) => member.id).sort()).toEqual(["mem-carla", "mem-carla-t"]);
    expect((await storage.memberships.searchListing({ organizationId: "org-s", query: "carla", orIdentities, rolesPerMember: 1 })).map((member) => member.id)).toEqual(["mem-carla"]);
    expect((await storage.memberships.search({ organizationId: "org-t", query: "carla", orIdentities })).map((member) => member.id)).toEqual(["mem-carla-t"]);
    expect(await storage.memberships.count({ query: "carla", orIdentities })).toBe(2);
    expect(await storage.memberships.count({ organizationId: "org-s", query: "carla", orIdentities })).toBe(1);

    // The id match still works on its own and next to it (the identities are ADDED to what the term matches), and `orIdentities` means nothing without a query.
    const daniMatches = (await storage.profiles.search({ query: "dani" })).map((entry) => entry.identity);
    expect((await storage.memberships.searchListing({ organizationId: "org-s", query: "dani", orIdentities: daniMatches, rolesPerMember: 1 })).map((member) => member.id)).toEqual(["mem-dani"]);
    expect((await storage.memberships.searchListing({ organizationId: "org-s", query: "dani", orIdentities, rolesPerMember: 1 })).map((member) => member.id).sort()).toEqual(["mem-carla", "mem-dani"]);
    expect((await storage.memberships.searchListing({ organizationId: "org-s", orIdentities, rolesPerMember: 1 })).map((member) => member.id).sort()).toEqual(["mem-carla", "mem-dani"]);
    expect(await storage.memberships.count({ organizationId: "org-s", status: "active", query: "carla", orIdentities })).toBe(1);

    // And the same through the helper a host uses.
    const { listMembersWithProfiles } = await import("@uniora/core");
    const members = await listMembersWithProfiles(storage, undefined, { organizationId: "org-s", query: "gómez", rolesPerMember: 1 });
    expect(members.map((member) => [member.id, member.profile?.displayName])).toEqual([["mem-carla", "Carla Gómez"]]);
  });
}
