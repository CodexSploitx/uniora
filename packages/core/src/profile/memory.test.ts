import { describe, expect, it } from "vitest";
import { createMemoryStorage } from "../storage/memory.js";
import { createOrganizationWithOwner } from "../organization/create-with-owner.js";
import { listMembersWithProfiles } from "./profiles.js";

const carla = { provider: "supabase", subject: "2eb65215-291a-4ced-a624-abdaff8d0723" };

describe("memory profiles", () => {
  it("keeps what is left out, clears null, drops unusable values and an emptied profile", async () => {
    const { profiles } = createMemoryStorage();
    await profiles.upsert(carla, { displayName: " Carla ", email: "carla@example.com", avatarUrl: "https://cdn.example.com/c.png" });
    expect(await profiles.upsert(carla, { email: "c@new.example.com" })).toMatchObject({ displayName: "Carla", email: "c@new.example.com", avatarUrl: "https://cdn.example.com/c.png" });
    expect((await profiles.upsert(carla, { avatarUrl: "javascript:alert(1)" }))?.avatarUrl).toBe("https://cdn.example.com/c.png");
    expect((await profiles.upsert(carla, { avatarUrl: null }))?.avatarUrl).toBeUndefined();
    await profiles.upsert(carla, { displayName: null, email: null });
    expect(await profiles.findMany([carla])).toEqual([]);
  });

  it("searches by name or e-mail, literally and without case, and a listing finds the member by it", async () => {
    const storage = createMemoryStorage();
    await createOrganizationWithOwner(storage, { organizationId: "o", organizationName: "Acme", ownerRoleId: "r", membershipId: "m", ownerIdentity: carla });
    await storage.profiles.upsert(carla, { displayName: "Carla Gómez", email: "carla@example.com" });

    expect((await storage.profiles.search({ query: "GÓMEZ" })).map((entry) => entry.identity)).toEqual([carla]);
    expect(await storage.profiles.search({ query: "%" })).toEqual([]);
    expect(await storage.profiles.search({ query: "  " })).toEqual([]);

    expect(await storage.memberships.count({ query: "carla" })).toBe(0);
    const members = await listMembersWithProfiles(storage, undefined, { organizationId: "o", query: "carla", rolesPerMember: 1 });
    expect(members.map((member) => member.profile?.displayName)).toEqual(["Carla Gómez"]);
    // No profile match and no id match: nobody.
    expect(await listMembersWithProfiles(storage, undefined, { organizationId: "o", query: "nobody", rolesPerMember: 1 })).toEqual([]);
  });
});
