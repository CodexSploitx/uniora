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
}
