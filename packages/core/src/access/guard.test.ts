import { describe, expect, it } from "vitest";
import {
  AccessError,
  createAccessAdminService,
  createGuardedStorage,
  createMemoryStorage,
  createOrganizationWithOwner,
  createTrustedAccessStorage,
  GUARDED_WRITES,
  isGuardedStorage,
} from "../index.js";
import type { UnioraStorage } from "../index.js";

const owner = { provider: "p", subject: "owner" };
const code = (promise: Promise<unknown>) => promise.then(() => "ok", (error: unknown) => (error as { code?: string }).code ?? String(error));

/** The memory backend re-exposed as classes: their methods live on the prototype and rely on `this`, like a hand-written backend. */
function asClasses(storage: UnioraStorage): UnioraStorage {
  const lift = <T extends object>(repo: T): T => {
    class Repo {
      constructor() {
        for (const key of Object.keys(repo)) Object.defineProperty(this, `_${key}`, { value: (repo as Record<string, unknown>)[key] });
      }
    }
    for (const key of Object.keys(repo)) {
      Object.defineProperty(Repo.prototype, key, {
        value: function (this: Record<string, (...args: unknown[]) => unknown>, ...args: unknown[]) {
          return this[`_${key}`]!(...args);
        },
      });
    }
    return new Repo() as unknown as T;
  };
  return {
    ...storage,
    memberships: lift(storage.memberships),
    roles: lift(storage.roles),
    invitations: lift(storage.invitations),
  } as UnioraStorage;
}

async function seeded(raw = createMemoryStorage()) {
  for (const key of ["reports.read", "members.roles.manage"]) await raw.permissions.register({ key });
  await createOrganizationWithOwner(raw, { organizationId: "org", organizationName: "Acme", ownerRoleId: "owner", membershipId: "m-owner", ownerIdentity: owner });
  await raw.roles.create({ id: "viewer", organizationId: "org", name: "Viewer", permissionKeys: ["reports.read"] });
  await raw.memberships.create({ id: "m-ana", organizationId: "org", identity: { provider: "p", subject: "ana" } });
  return raw;
}

describe("createGuardedStorage", () => {
  it("lists every guarded write once", () => {
    expect(new Set(GUARDED_WRITES).size).toBe(GUARDED_WRITES.length);
    expect(GUARDED_WRITES).toContain("memberships.assignRole");
    expect(GUARDED_WRITES).toContain("roles.setPermissions");
    expect(GUARDED_WRITES).toContain("invitations.create");
  });

  it("refuses a write without a token and passes reads and unrelated writes", async () => {
    const storage = createGuardedStorage(await seeded());
    expect(isGuardedStorage(storage)).toBe(true);
    expect(await code(storage.memberships.assignRole("m-ana", "viewer"))).toBe("access_authorization_required");
    expect(await code(storage.roles.grantPermission("viewer", "members.roles.manage"))).toBe("access_authorization_required");
    expect((await storage.memberships.findById("m-ana"))?.roleIds).toEqual([]);
    await expect(storage.memberships.recordActivity("m-ana", new Date())).resolves.not.toThrow();
  });

  it("keeps a repository written as a class working, guarded and trusted", async () => {
    const guarded = createGuardedStorage(asClasses(await seeded()));
    expect(await code(guarded.memberships.assignRole("m-ana", "viewer"))).toBe("access_authorization_required");
    expect((await guarded.memberships.findById("m-ana"))?.id).toBe("m-ana");
    const access = createAccessAdminService({ storage: guarded });
    await expect(access.assignRole({ actor: owner, organizationId: "org", membershipId: "m-ana", roleId: "viewer" })).resolves.toMatchObject({ roleIds: ["viewer"] });
    const trusted = createTrustedAccessStorage(guarded, { actor: owner, reason: "test" });
    await trusted.memberships.unassignRole("m-ana", "viewer");
    expect((await guarded.memberships.findById("m-ana"))?.roleIds).toEqual([]);
  });

  it("a trusted storage needs a reason", async () => {
    const guarded = createGuardedStorage(await seeded());
    expect(() => createTrustedAccessStorage(guarded, { actor: owner, reason: " " })).toThrow(AccessError);
  });
});
