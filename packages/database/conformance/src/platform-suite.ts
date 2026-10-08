import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  PlatformError,
  bootstrapPlatform,
  createAuthorizationEngine,
  createPlatformEngine,
  createPlatformService,
} from "@uniora/core";
import type { Identity, PlatformStorage, UnioraStorage } from "@uniora/core";

const root: Identity = { provider: "auth", subject: "root" };
const alice: Identity = { provider: "auth", subject: "alice" };
const bob: Identity = { provider: "auth", subject: "bob" };

/** How the platform conformance suite drives one adapter. */
export interface PlatformHarness {
  readonly name: string;
  setup(): Promise<void>;
  teardown(): Promise<void>;
  /** Empties every platform table AND the organization tables the suite touches. */
  reset(): Promise<void>;
  /** The organization storage and the platform storage over the SAME database. */
  storage(): UnioraStorage;
  platform(): PlatformStorage;
  /** Plain SQL, as any client with write access could issue it; resolves `"rejected"` if the database refuses. */
  probe: {
    suspendMemberDirectly(memberId: string): Promise<"rejected" | "applied">;
    deleteMemberDirectly(memberId: string): Promise<"rejected" | "applied">;
    unassignAllRolesDirectly(memberId: string): Promise<"rejected" | "applied">;
    updateRoleDirectly(roleId: string): Promise<"rejected" | "applied">;
    deleteRoleDirectly(roleId: string): Promise<"rejected" | "applied">;
    /** Gives a non-system role the reserved `platform.*`; the database must refuse. */
    grantWildcardDirectly(roleId: string): Promise<"rejected" | "applied">;
  };
}

/** The behaviour every `PlatformStorage` adapter must reproduce. Real database, never mocks. */
export function definePlatformConformance(harness: PlatformHarness): void {
  describe(`${harness.name} — PlatformStorage conformance`, () => {
    beforeAll(() => harness.setup());
    afterAll(() => harness.teardown());
    beforeEach(() => harness.reset());

    async function boot() {
      const platform = harness.platform();
      const storage = harness.storage();
      const { role, member } = await bootstrapPlatform({ platform, admin: root });
      const service = createPlatformService({ platform, storage });
      return { platform, storage, service, adminRole: role, rootMember: member };
    }

    it("bootstraps once and persists the system role and the first administrator", async () => {
      const { platform, adminRole, rootMember } = await boot();
      expect(adminRole).toMatchObject({ key: "platform_admin", isSystem: true, permissions: ["platform.*"], version: 1 });
      expect(rootMember).toMatchObject({ status: "active", roleIds: [adminRole.id], identity: root, version: 1 });
      await expect(bootstrapPlatform({ platform, admin: alice })).rejects.toMatchObject({ code: "platform_already_initialized" });
      expect(await platform.platformMembers.findByIdentity(root)).toMatchObject({ id: rootMember.id });
      expect(await platform.platformRoles.findByKey("platform_admin")).toMatchObject({ id: adminRole.id });
      const audit = await platform.auditLogs.search({ actionPrefix: "platform." });
      expect(audit.map((entry) => entry.action)).toEqual(["platform.bootstrapped"]);
      expect(audit[0]!.organizationId).toBeUndefined();
    });

    it("refuses every write that did not come through the platform service", async () => {
      const { platform, adminRole } = await boot();
      const forged = { actor: root } as never;
      await expect(platform.platformRoles.create({ id: "r", key: "evil", name: "Evil", permissions: ["platform.x.y"], authorization: forged })).rejects.toMatchObject({
        code: "platform_authorization_required",
      });
      await expect(platform.platformMembers.add({ id: "m", identity: alice, roleIds: [adminRole.id], addedBy: root, authorization: forged })).rejects.toMatchObject({
        code: "platform_authorization_required",
      });
      await expect(platform.platformMembers.remove("m", { by: root, authorization: undefined as never })).rejects.toMatchObject({ code: "platform_authorization_required" });
      expect(await platform.platformMembers.count()).toBe(1);
    });

    it("answers permission checks from the stored roles, with wildcards and suspension", async () => {
      const { platform, service } = await boot();
      const engine = createPlatformEngine(platform);
      const role = await service.createRole({ actor: root, key: "support", name: "Support", permissions: ["platform.organizations.*", "platform.audit.read"] });
      const member = await service.addMember({ actor: root, identity: alice, roleIds: [role.id] });
      expect(await engine.can({ identity: alice, permission: "platform.organizations.manage" })).toBe(true);
      expect(await engine.can({ identity: alice, permission: "platform.audit.read" })).toBe(true);
      expect(await engine.can({ identity: alice, permission: "platform.members.manage" })).toBe(false);
      expect(await engine.can({ identity: root, permission: "platform.anything.at_all" })).toBe(true);
      expect(await engine.can({ identity: bob, permission: "platform.audit.read" })).toBe(false);
      await service.suspendMember({ actor: root, memberId: member.id, reason: "offboarding" });
      expect(await engine.can({ identity: alice, permission: "platform.audit.read" })).toBe(false);
      const stored = await platform.platformMembers.findById(member.id);
      expect(stored).toMatchObject({ status: "suspended", statusChange: { by: root, reason: "offboarding" } });
      await service.reactivateMember({ actor: root, memberId: member.id });
      expect(await engine.can({ identity: alice, permission: "platform.audit.read" })).toBe(true);
    });

    it("keeps the platform apart from organizations", async () => {
      const { storage, platform, service } = await boot();
      await storage.organizations.create({ id: "org", name: "Acme" });
      const owner = await storage.roles.createOwnerRole({ id: "owner", organizationId: "org" });
      await storage.memberships.create({ id: "m-alice", organizationId: "org", identity: alice });
      await storage.memberships.assignOwnerRole("m-alice", owner.id);
      await storage.memberships.create({ id: "m-root", organizationId: "org", identity: root });
      const orgEngine = createAuthorizationEngine(storage);
      expect(await orgEngine.can({ identity: alice, organizationId: "org", permission: "x.y" })).toBe(true);
      expect(await createPlatformEngine(platform).can({ identity: alice, permission: "platform.organizations.read" })).toBe(false);
      await expect(service.addMember({ actor: alice, identity: bob, roleIds: [] })).rejects.toMatchObject({ code: "platform_forbidden" });
      // A platform administrator who is a plain member of the organization has no organization power from it, and vice versa.
      expect(await orgEngine.can({ identity: root, organizationId: "org", permission: "x.y" })).toBe(false);
      await storage.memberships.assignOwnerRole("m-root", owner.id);
      expect(await orgEngine.can({ identity: root, organizationId: "org", permission: "x.y" })).toBe(true);
      expect(await createPlatformEngine(platform).can({ identity: root, permission: "platform.x.y" })).toBe(true);
    });

    it("enforces escalation, self-change and system-role rules", async () => {
      const { service, adminRole, rootMember } = await boot();
      const lead = await service.createRole({ actor: root, key: "team_lead", name: "Team lead", permissions: ["platform.members.manage", "platform.roles.manage"] });
      await service.addMember({ actor: root, identity: alice, roleIds: [lead.id] });
      await expect(service.createRole({ actor: alice, key: "big", name: "Big", permissions: ["platform.organizations.manage"] })).rejects.toMatchObject({ code: "platform_escalation" });
      await expect(service.addMember({ actor: alice, identity: bob, roleIds: [adminRole.id] })).rejects.toMatchObject({ code: "platform_escalation" });
      await expect(service.suspendMember({ actor: alice, memberId: rootMember.id })).rejects.toMatchObject({ code: "platform_escalation" });
      await expect(service.removeMember({ actor: root, memberId: rootMember.id })).rejects.toMatchObject({ code: "platform_self_change" });
      await expect(service.createRole({ actor: root, key: "all", name: "All", permissions: ["platform.*"] })).rejects.toMatchObject({ code: "platform_permission_invalid" });
      await expect(service.updateRole({ actor: root, roleId: adminRole.id, name: "Boss" })).rejects.toMatchObject({ code: "platform_role_system" });
      await expect(service.deleteRole({ actor: root, roleId: adminRole.id })).rejects.toMatchObject({ code: "platform_role_system" });
    });

    it("handles roles: uniqueness, versions, in-use protection, ordering and paging", async () => {
      const { service, platform } = await boot();
      const a = await service.createRole({ actor: root, id: "role-a", key: "alpha", name: "Alpha", description: "First", permissions: ["platform.audit.read", "platform.audit.read"] });
      expect(a).toMatchObject({ version: 1, permissions: ["platform.audit.read"], description: "First", isSystem: false });
      await service.createRole({ actor: root, id: "role-b", key: "beta", name: "Beta", permissions: [] });
      await expect(service.createRole({ actor: root, id: "role-c", key: "alpha", name: "Dup", permissions: [] })).rejects.toMatchObject({ code: "platform_role_exists" });
      await expect(service.createRole({ actor: root, id: "role-a", key: "gamma", name: "Dup", permissions: [] })).rejects.toMatchObject({ code: "platform_role_exists" });
      const updated = await service.updateRole({ actor: root, roleId: a.id, name: "Alpha 2", description: null, expectedVersion: 1 });
      expect(updated).toMatchObject({ name: "Alpha 2", version: 2 });
      expect(updated.description).toBeUndefined();
      await expect(service.updateRole({ actor: root, roleId: a.id, name: "Alpha 3", expectedVersion: 1 })).rejects.toMatchObject({ code: "platform_version_conflict" });
      await service.addMember({ actor: root, identity: alice, roleIds: [a.id] });
      await expect(service.deleteRole({ actor: root, roleId: a.id })).rejects.toMatchObject({ code: "platform_role_in_use" });
      await expect(service.deleteRole({ actor: root, roleId: "nope" })).rejects.toBeInstanceOf(PlatformError);
      const all = await platform.platformRoles.search();
      expect(all).toHaveLength(3);
      const page = await platform.platformRoles.search({ limit: 1, after: all[0]!.id });
      expect(page.map((role) => role.id)).toEqual([all[1]!.id]);
    });

    it("handles members: duplicate identities, role changes, filters and counts", async () => {
      const { service, platform, adminRole } = await boot();
      const support = await service.createRole({ actor: root, key: "support", name: "Support", permissions: ["platform.audit.read"] });
      const member = await service.addMember({ actor: root, identity: alice, roleIds: [support.id] });
      await expect(service.addMember({ actor: root, identity: alice, roleIds: [] })).rejects.toMatchObject({ code: "platform_member_exists" });
      await expect(service.addMember({ actor: root, identity: bob, roleIds: ["missing"] })).rejects.toMatchObject({ code: "platform_role_not_found" });
      const promoted = await service.assignRole({ actor: root, memberId: member.id, roleId: adminRole.id });
      expect(promoted.roleIds).toEqual([adminRole.id, support.id].sort());
      expect(promoted.version).toBe(member.version + 1);
      const same = await service.assignRole({ actor: root, memberId: member.id, roleId: adminRole.id });
      expect(same.version).toBe(promoted.version);
      await service.unassignRole({ actor: root, memberId: member.id, roleId: adminRole.id });
      expect(await platform.platformMembers.count()).toBe(2);
      expect(await platform.platformMembers.count({ roleId: support.id })).toBe(1);
      expect(await platform.platformMembers.count({ status: "suspended" })).toBe(0);
      expect((await platform.platformMembers.search({ roleId: adminRole.id })).map((m) => m.identity.subject)).toEqual(["root"]);
      await expect(service.assignRole({ actor: root, memberId: member.id, roleId: support.id, expectedVersion: 1 })).rejects.toMatchObject({ code: "platform_version_conflict" });
      await service.removeMember({ actor: root, memberId: member.id });
      expect(await platform.platformMembers.findById(member.id)).toBeNull();
      await expect(service.removeMember({ actor: root, memberId: member.id })).rejects.toMatchObject({ code: "platform_member_not_found" });
    });

    it("records global audit entries for every change, in the same transaction", async () => {
      const { platform, service } = await boot();
      const role = await service.createRole({ actor: root, key: "support", name: "Support", permissions: ["platform.audit.read"] });
      const member = await service.addMember({ actor: root, identity: alice, roleIds: [role.id] });
      await service.suspendMember({ actor: root, memberId: member.id });
      await service.reactivateMember({ actor: root, memberId: member.id });
      await service.removeMember({ actor: root, memberId: member.id });
      await service.deleteRole({ actor: root, roleId: role.id });
      const entries = await platform.auditLogs.search({ actionPrefix: "platform." });
      expect(entries.map((entry) => entry.action).sort()).toEqual(
        ["platform.bootstrapped", "platform.member_added", "platform.member_reactivated", "platform.member_removed", "platform.member_suspended", "platform.role_created", "platform.role_deleted"].sort(),
      );
      expect(entries.every((entry) => entry.organizationId === undefined && entry.actor.subject === "root")).toBe(true);

      // A failing transaction leaves neither the change nor its audit entry.
      await expect(
        platform.transaction(async (tx) => {
          await tx.auditLogs.record({ id: "ghost", actor: root, action: "platform.role_created" });
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      expect((await platform.auditLogs.search({ actionPrefix: "platform." })).some((entry) => entry.id === "ghost")).toBe(false);
    });

    it("two administrators suspending each other at the same instant never leave the platform without one", async () => {
      const { service, platform, adminRole } = await boot();
      const second = await service.addMember({ actor: root, identity: alice, roleIds: [adminRole.id] });
      const first = (await platform.platformMembers.findByIdentity(root))!;
      const results = await Promise.allSettled([
        service.suspendMember({ actor: alice, memberId: first.id }),
        service.suspendMember({ actor: root, memberId: second.id }),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(await platform.platformMembers.count({ status: "active", roleId: adminRole.id })).toBe(1);
    });

    it("the database itself refuses to leave the platform without an administrator or to alter the system role", async () => {
      const { platform, adminRole, rootMember, service } = await boot();
      expect(await harness.probe.suspendMemberDirectly(rootMember.id)).toBe("rejected");
      expect(await harness.probe.deleteMemberDirectly(rootMember.id)).toBe("rejected");
      expect(await harness.probe.unassignAllRolesDirectly(rootMember.id)).toBe("rejected");
      expect(await harness.probe.updateRoleDirectly(adminRole.id)).toBe("rejected");
      expect(await harness.probe.deleteRoleDirectly(adminRole.id)).toBe("rejected");
      const plain = await service.createRole({ actor: root, key: "plain", name: "Plain", permissions: [] });
      expect(await harness.probe.grantWildcardDirectly(plain.id)).toBe("rejected");
      expect(await platform.platformMembers.findById(rootMember.id)).toMatchObject({ status: "active", roleIds: [adminRole.id] });
      // With a second administrator the first can go (as plain SQL too).
      await service.addMember({ actor: root, identity: alice, roleIds: [adminRole.id] });
      expect(await harness.probe.suspendMemberDirectly(rootMember.id)).toBe("applied");
    });
  });
}
