import { describe, expect, it, vi } from "vitest";
import {
  AccessError,
  GUARDED_WRITES,
  createAccessAdminService,
  createAuditedStorage,
  createGuardedStorage,
  createInvitationService,
  createOrganizationWithOwner,
  createTrustedAccessStorage,
  isGuardedStorage,
  leaveOrganization,
  transferOwnership,
} from "@uniora/core";
import type { Identity, UnioraStorage } from "@uniora/core";

const owner: Identity = { provider: "auth", subject: "owner" };
const mgr: Identity = { provider: "auth", subject: "mgr" }; // "manager": administers members and roles, holds reports.write
const peer: Identity = { provider: "auth", subject: "peer" }; // same roles as mgr
const lim: Identity = { provider: "auth", subject: "lim" }; // "limited": members.roles.manage only
const ana: Identity = { provider: "auth", subject: "ana" }; // viewer
const bill: Identity = { provider: "auth", subject: "bill" }; // billing
const nobody: Identity = { provider: "auth", subject: "nobody" }; // a member without roles
const stranger: Identity = { provider: "auth", subject: "stranger" }; // not a member of org-1

/** What the suite needs from one adapter: a fresh, empty storage for each test. */
export interface AccessHarness {
  readonly name: string;
  storage(): UnioraStorage;
}

const codeOf = (promise: Promise<unknown>): Promise<string> =>
  promise.then(
    () => "ok",
    (error: unknown) => (error as { code?: string }).code ?? String(error),
  );

const MANAGER_KEYS = ["members.roles.manage", "members.invite", "members.block", "members.remove", "roles.manage", "reports.write"];

/** The organizations, roles and members every scenario starts from, written through the plain storage (as a seeding script would). */
async function seed(storage: UnioraStorage) {
  for (const key of ["reports.read", "billing.manage", "members.roles.manage", "members.invite", "members.block", "members.remove", "roles.manage"]) {
    await storage.permissions.register({ key });
  }
  await storage.permissions.register({ key: "reports.write", implies: ["reports.read"] });
  await createOrganizationWithOwner(storage, { organizationId: "org-1", organizationName: "Acme", ownerRoleId: "role-owner", membershipId: "m-owner", ownerIdentity: owner });
  await createOrganizationWithOwner(storage, { organizationId: "org-2", organizationName: "Other", ownerRoleId: "role-owner-2", membershipId: "m-owner-2", ownerIdentity: stranger });
  const role = (id: string, name: string, permissionKeys: string[], organizationId = "org-1") => storage.roles.create({ id, organizationId, name, permissionKeys });
  await role("role-viewer", "Viewer", ["reports.read"]);
  await role("role-writer", "Writer", ["reports.write"]);
  await role("role-billing", "Billing", ["billing.manage"]);
  await role("role-manager", "Manager", MANAGER_KEYS);
  await role("role-limited", "Limited", ["members.roles.manage"]);
  await role("role-other", "Other viewer", ["reports.read"], "org-2");
  const member = (id: string, identity: Identity, roleIds: string[]) => storage.memberships.create({ id, organizationId: "org-1", identity, roleIds });
  await member("m-mgr", mgr, ["role-manager"]);
  await member("m-peer", peer, ["role-manager"]);
  await member("m-lim", lim, ["role-limited"]);
  await member("m-ana", ana, ["role-viewer"]);
  await member("m-bill", bill, ["role-billing"]);
  await member("m-nobody", nobody, []);
  const guarded = createGuardedStorage(storage);
  return { raw: storage, guarded, service: createAccessAdminService({ storage: guarded }) };
}

type World = Awaited<ReturnType<typeof seed>>;

const org = (actor: Identity) => ({ organizationId: "org-1", actor });
const refusals = async (storage: UnioraStorage) => (await storage.auditLogs.search({ action: "access.change_refused" }));

/** Everything the access rules promise, over one storage adapter. Real database, never mocks (except the clock, to age a token). */
export function defineAccessScenarios(harness: AccessHarness): void {
  describe(`${harness.name} — access administration (anti-escalation)`, () => {
    const world = async (): Promise<World> => seed(harness.storage());

    describe("the guard", () => {
      it("refuses every guarded write that carries no authorization, and lets reads and harmless writes through", async () => {
        const { guarded } = await world();
        expect(isGuardedStorage(guarded)).toBe(true);
        expect(GUARDED_WRITES).toContain("memberships.assignRole");
        const refused = (promise: Promise<unknown>) => codeOf(promise);
        const calls: Array<[string, Promise<unknown>]> = [
          ["assignRole", guarded.memberships.assignRole("m-nobody", "role-viewer")],
          ["unassignRole", guarded.memberships.unassignRole("m-ana", "role-viewer")],
          ["assignOwnerRole", guarded.memberships.assignOwnerRole("m-nobody", "role-owner")],
          ["unassignOwnerRole", guarded.memberships.unassignOwnerRole("m-owner", "role-owner")],
          ["create with roles", guarded.memberships.create({ id: "m-x", organizationId: "org-1", identity: { provider: "auth", subject: "x" }, roleIds: ["role-viewer"] })],
          ["block", guarded.memberships.block("m-ana", { actor: owner })],
          ["suspend", guarded.memberships.suspend("m-ana", { actor: owner, until: new Date(Date.now() + 60_000) })],
          ["unblock", guarded.memberships.unblock("m-ana", { actor: owner })],
          ["delete", guarded.memberships.delete("m-ana")],
          ["roles.create", guarded.roles.create({ id: "r-x", organizationId: "org-1", name: "X", permissionKeys: ["reports.read"] })],
          ["roles.clone", guarded.roles.clone("role-viewer", { id: "r-y", name: "Y" })],
          ["roles.rename", guarded.roles.rename("role-viewer", "Renamed")],
          ["roles.update", guarded.roles.update("role-viewer", { description: "d" })],
          ["roles.grantPermission", guarded.roles.grantPermission("role-viewer", "billing.manage")],
          ["roles.revokePermission", guarded.roles.revokePermission("role-viewer", "reports.read")],
          ["roles.setPermissions", guarded.roles.setPermissions("role-viewer", ["billing.manage"])],
          ["roles.delete", guarded.roles.delete("role-viewer")],
          [
            "invitations.create",
            guarded.invitations.create({
              id: "i-x",
              organizationId: "org-1",
              email: "x@example.com",
              roleIds: ["role-viewer"],
              tokenHash: "h".repeat(64),
              invitedBy: mgr,
              createdAt: new Date(),
              expiresAt: new Date(Date.now() + 60_000),
            }),
          ],
          ["invitations.rotateToken", guarded.invitations.rotateToken("i-x", { tokenHash: "g".repeat(64), expiresAt: new Date(Date.now() + 60_000) })],
          ["invitations.revoke", guarded.invitations.revoke("i-x", new Date())],
        ];
        for (const [name, call] of calls) expect(await refused(call), name).toBe("access_authorization_required");
        // Nothing changed.
        expect((await guarded.memberships.findById("m-ana"))?.roleIds).toEqual(["role-viewer"]);
        expect((await guarded.roles.findByIds(["role-viewer"]))[0]?.permissionKeys).toEqual(["reports.read"]);
        // A member created WITHOUT roles holds no power: it is not guarded. Reads and audit writes are untouched.
        await guarded.memberships.create({ id: "m-plain", organizationId: "org-1", identity: { provider: "auth", subject: "plain" } });
        expect(await guarded.memberships.findByIdentity("org-1", { provider: "auth", subject: "plain" })).not.toBeNull();
        await guarded.auditLogs.record({ id: "a-1", organizationId: "org-1", actor: owner, action: "host.did_something", target: { type: "x", id: "1" } });
      });

      it("ties each token to one operation on one target, once, for a short time, and refuses forged ones", async () => {
        const { guarded, raw } = await world();
        // Capture the token the service passes to the guard, without letting the write happen yet.
        const seen: Array<{ membershipId: string; roleId: string; authorization: unknown }> = [];
        let hold = true;
        const capture = (storage: UnioraStorage): UnioraStorage => ({
          ...storage,
          memberships: {
            ...storage.memberships,
            assignRole: async (membershipId, roleId, options) => {
              seen.push({ membershipId, roleId, authorization: options?.authorization });
              if (hold) throw new Error("held back");
              return storage.memberships.assignRole(membershipId, roleId, options);
            },
          },
          transaction: (callback) => storage.transaction((tx) => callback({ ...tx, memberships: capture({ ...storage, ...tx } as UnioraStorage).memberships })),
        });
        const service = createAccessAdminService({ storage: capture(guarded) });
        await expect(service.assignRole({ ...org(mgr), membershipId: "m-nobody", roleId: "role-viewer" })).rejects.toThrow("held back");
        const token = seen[0]!.authorization as never;
        expect(token).toBeTruthy();

        const use = (membershipId: string, roleId: string, authorization: unknown) =>
          codeOf(guarded.memberships.assignRole(membershipId, roleId, { authorization: authorization as never }));
        // Another target, another role, a look-alike object, a spread copy of the real thing, and nothing at all.
        expect(await use("m-ana", "role-viewer", token)).toBe("access_authorization_required");
        expect(await use("m-nobody", "role-writer", token)).toBe("access_authorization_required");
        expect(await use("m-nobody", "role-viewer", { actor: mgr })).toBe("access_authorization_required");
        expect(await use("m-nobody", "role-viewer", { ...(token as object) })).toBe("access_authorization_required");
        expect(await use("m-nobody", "role-viewer", undefined)).toBe("access_authorization_required");
        // Another operation: a token for assigning cannot unassign, delete or block.
        expect(await codeOf(guarded.memberships.unassignRole("m-nobody", "role-viewer", { authorization: token }))).toBe("access_authorization_required");
        expect(await codeOf(guarded.memberships.delete("m-nobody", { authorization: token }))).toBe("access_authorization_required");
        // Too old.
        const now = Date.now();
        const clock = vi.spyOn(Date, "now").mockReturnValue(now + 61_000);
        try {
          expect(await use("m-nobody", "role-viewer", token)).toBe("access_authorization_required");
        } finally {
          clock.mockRestore();
        }
        // The right use works exactly once.
        expect(await use("m-nobody", "role-viewer", token)).toBe("ok");
        expect(await use("m-nobody", "role-viewer", token)).toBe("access_authorization_required");
        expect((await raw.memberships.findById("m-nobody"))?.roleIds).toEqual(["role-viewer"]);
        hold = false;
      });

      it("keeps the founding flows working on a guarded storage, and sends ownership transfers through a named trusted storage", async () => {
        const { guarded } = await world();
        await createOrganizationWithOwner(guarded, { organizationId: "org-3", organizationName: "Third", ownerRoleId: "role-owner-3", membershipId: "m-owner-3", ownerIdentity: owner });
        expect((await guarded.memberships.findById("m-owner-3"))?.roleIds).toEqual(["role-owner-3"]);
        expect(await leaveOrganization(guarded, { organizationId: "org-1", identity: nobody })).toBe(true);
        expect(await guarded.memberships.findById("m-nobody")).toBeNull();

        await expect(transferOwnership(guarded, { organizationId: "org-1", fromMembershipId: "m-owner", toMembershipId: "m-mgr", actor: owner })).rejects.toMatchObject({
          code: "access_authorization_required",
        });
        expect(() => createTrustedAccessStorage(guarded, { actor: owner, reason: "  " })).toThrow(AccessError);
        const trusted = createTrustedAccessStorage(guarded, { actor: owner, reason: "ownership handover agreed with the customer" });
        await transferOwnership(trusted, { organizationId: "org-1", fromMembershipId: "m-owner", toMembershipId: "m-mgr", actor: owner });
        expect((await guarded.memberships.findById("m-mgr"))?.roleIds).toContain("role-owner");
        // Back-office writes keep working, and keep the audit trail when the audited storage is wrapped first.
        await createTrustedAccessStorage(createAuditedStorage(guarded, { actor: owner }), { actor: owner, reason: "seed" }).memberships.assignRole("m-ana", "role-writer");
        expect((await guarded.memberships.findById("m-ana"))?.roleIds).toContain("role-writer");
        expect((await guarded.auditLogs.search({ action: "membership.role_assigned" })).length).toBe(1);
      });

      it("makes the service refuse a storage that is not guarded unless that is accepted, and still applies the rules when it is", async () => {
        const { raw } = await world();
        expect(() => createAccessAdminService({ storage: raw })).toThrow(/createGuardedStorage/);
        try {
          createAccessAdminService({ storage: raw });
        } catch (error) {
          expect((error as AccessError).code).toBe("access_storage_not_guarded");
        }
        const service = createAccessAdminService({ storage: raw, allowUnguardedStorage: true });
        expect(await codeOf(service.assignRole({ ...org(mgr), membershipId: "m-nobody", roleId: "role-billing" }))).toBe("access_escalation");
        expect(await codeOf(service.assignRole({ ...org(mgr), membershipId: "m-nobody", roleId: "role-viewer" }))).toBe("ok");
        // Nothing stops other code from writing directly: that is what the guard is for.
        await raw.memberships.assignRole("m-nobody", "role-billing");
        expect((await raw.memberships.findById("m-nobody"))?.roleIds).toContain("role-billing");
      });
    });

    describe("rule 1: you can only give what you hold", () => {
      it("lets a manager give roles inside their own permissions (implications included) and refuses the rest", async () => {
        const { service, guarded } = await world();
        // reports.write implies reports.read, so Viewer is within reach; Writer is the manager's own; Limited is a subset.
        for (const roleId of ["role-viewer", "role-writer", "role-limited"]) {
          const after = await service.assignRole({ ...org(mgr), membershipId: "m-nobody", roleId });
          expect(after.roleIds).toContain(roleId);
        }
        expect(await codeOf(service.assignRole({ ...org(mgr), membershipId: "m-nobody", roleId: "role-billing" }))).toBe("access_escalation");
        expect((await guarded.memberships.findById("m-nobody"))?.roleIds).not.toContain("role-billing");
        // The Owner holds everything, so the Owner can give the same role.
        expect((await service.assignRole({ ...org(owner), membershipId: "m-nobody", roleId: "role-billing" })).roleIds).toContain("role-billing");
      });

      it("treats a role that grew after it was handed out like any other: the actor must hold what it holds now", async () => {
        const { service, raw } = await world();
        await raw.roles.grantPermission("role-viewer", "billing.manage");
        expect(await codeOf(service.assignRole({ ...org(mgr), membershipId: "m-nobody", roleId: "role-viewer" }))).toBe("access_escalation");
        expect(await codeOf(service.assignRole({ ...org(owner), membershipId: "m-nobody", roleId: "role-viewer" }))).toBe("ok");
      });
    });

    describe("rule 2: nobody changes their own roles", () => {
      it("refuses a manager and the Owner alike on their own membership", async () => {
        const { service, guarded } = await world();
        for (const who of [{ actor: mgr, membershipId: "m-mgr" }, { actor: owner, membershipId: "m-owner" }]) {
          const ref = { organizationId: "org-1", actor: who.actor, membershipId: who.membershipId };
          expect(await codeOf(service.assignRole({ ...ref, roleId: "role-viewer" })), "assign").toBe("access_self_change");
          expect(await codeOf(service.unassignRole({ ...ref, roleId: "role-viewer" })), "unassign").toBe("access_self_change");
          expect(await codeOf(service.blockMember(ref)), "block").toBe("access_self_change");
          expect(await codeOf(service.suspendMember({ ...ref, until: new Date(Date.now() + 60_000) })), "suspend").toBe("access_self_change");
          expect(await codeOf(service.unblockMember(ref)), "unblock").toBe("access_self_change");
          expect(await codeOf(service.removeMember(ref)), "remove").toBe("access_self_change");
        }
        expect((await guarded.memberships.findById("m-mgr"))?.roleIds).toEqual(["role-manager"]);
      });

      it("follows a linked identity to the same membership", async () => {
        const { service, raw } = await world();
        const alias: Identity = { provider: "other-auth", subject: "mgr-alias" };
        await raw.identityLinks.link({ from: alias, to: mgr, actor: owner });
        expect(await codeOf(service.assignRole({ organizationId: "org-1", actor: alias, membershipId: "m-mgr", roleId: "role-viewer" }))).toBe("access_self_change");
      });
    });

    describe("rule 3: you do not touch whoever holds more power than you", () => {
      it("keeps a manager away from the Owner and from a member with permissions the manager lacks", async () => {
        const { service, guarded } = await world();
        for (const target of ["m-owner", "m-bill"]) {
          const ref = { ...org(mgr), membershipId: target };
          expect(await codeOf(service.assignRole({ ...ref, roleId: "role-viewer" })), `assign ${target}`).toBe("access_target_stronger");
          expect(await codeOf(service.unassignRole({ ...ref, roleId: target === "m-bill" ? "role-billing" : "role-viewer" })), `unassign ${target}`).toBe(
            target === "m-owner" ? "access_target_stronger" : "access_target_stronger",
          );
          expect(await codeOf(service.blockMember(ref)), `block ${target}`).toBe("access_target_stronger");
          expect(await codeOf(service.removeMember(ref)), `remove ${target}`).toBe("access_target_stronger");
        }
        expect((await guarded.memberships.findById("m-bill"))?.roleIds).toEqual(["role-billing"]);
        expect((await guarded.memberships.findById("m-owner"))?.status).toBe("active");
      });

      it("lets peers and the Owner reach downwards, and compares sets, not ranks", async () => {
        const { service, guarded } = await world();
        // A peer with the same permissions is within reach; a member with fewer is too.
        expect((await service.assignRole({ ...org(mgr), membershipId: "m-peer", roleId: "role-viewer" })).roleIds).toContain("role-viewer");
        expect((await service.blockMember({ ...org(mgr), membershipId: "m-ana", reason: "left the company" })).status).toBe("blocked");
        expect((await service.unblockMember({ ...org(mgr), membershipId: "m-ana" })).status).toBe("active");
        // The Owner reaches everyone but themselves, the manager included.
        expect((await service.suspendMember({ ...org(owner), membershipId: "m-mgr", until: new Date(Date.now() + 3_600_000) })).status).toBe("suspended");
        // Neither of two administrators with different permissions can touch the other.
        await service.unblockMember({ ...org(owner), membershipId: "m-mgr" });
        const dev = { provider: "auth", subject: "dev" };
        const trusted = createTrustedAccessStorage(guarded, { actor: owner, reason: "fixture" });
        await trusted.roles.create({ id: "role-dev", organizationId: "org-1", name: "Dev", permissionKeys: ["members.roles.manage", "billing.manage"] });
        await trusted.memberships.create({ id: "m-dev", organizationId: "org-1", identity: dev, roleIds: ["role-dev"] });
        expect(await codeOf(service.assignRole({ ...org(mgr), membershipId: "m-dev", roleId: "role-viewer" }))).toBe("access_target_stronger");
        expect(await codeOf(service.assignRole({ ...org(dev), membershipId: "m-mgr", roleId: "role-viewer" }))).toBe("access_target_stronger");
      });
    });

    describe("rule 4: the Owner role stays out of the service", () => {
      it("refuses to give or take the Owner role, even to or from the Owner", async () => {
        const { service, guarded } = await world();
        expect(await codeOf(service.assignRole({ ...org(owner), membershipId: "m-nobody", roleId: "role-owner" }))).toBe("access_owner_protected");
        expect(await codeOf(service.unassignRole({ ...org(owner), membershipId: "m-mgr", roleId: "role-owner" }))).toBe("access_owner_protected");
        expect(await codeOf(service.updateRole({ ...org(owner), roleId: "role-owner", name: "Boss" }))).toBe("access_owner_protected");
        expect(await codeOf(service.setRolePermissions({ ...org(owner), roleId: "role-owner", permissionKeys: [] }))).toBe("access_owner_protected");
        expect((await guarded.memberships.findById("m-nobody"))?.roleIds).toEqual([]);
        // The way to move it is the one that always existed, and it is explicit.
        const trusted = createTrustedAccessStorage(guarded, { actor: owner, reason: "documented ownership grant" });
        await trusted.memberships.assignOwnerRole("m-peer", "role-owner");
        expect((await guarded.memberships.findById("m-peer"))?.roleIds).toContain("role-owner");
      });
    });

    describe("the permission gate and the audit trail", () => {
      it("answers a plain refusal, without a trace, to anyone who lacks the permission, is blocked, or is not in the organization", async () => {
        const { service, guarded } = await world();
        const attempt = (actor: Identity) => codeOf(service.assignRole({ ...org(actor), membershipId: "m-nobody", roleId: "role-viewer" }));
        expect(await attempt(ana)).toBe("access_forbidden"); // a member without members.roles.manage
        expect(await attempt(stranger)).toBe("access_forbidden"); // not a member of org-1
        expect(await attempt({ provider: "auth", subject: "ghost" })).toBe("access_forbidden");
        await service.blockMember({ ...org(owner), membershipId: "m-mgr" });
        expect(await attempt(mgr)).toBe("access_forbidden"); // blocked members are denied everything
        expect(await refusals(guarded)).toHaveLength(0);
        expect((await guarded.memberships.findById("m-nobody"))?.roleIds).toEqual([]);
      });

      it("treats a member or role of another organization as missing", async () => {
        const { service } = await world();
        const asStranger = { organizationId: "org-2", actor: stranger };
        expect(await codeOf(service.assignRole({ ...asStranger, membershipId: "m-nobody", roleId: "role-other" }))).toBe("membership_not_found");
        expect(await codeOf(service.assignRole({ ...asStranger, membershipId: "m-owner-2", roleId: "role-viewer" }))).toBe("role_not_found");
        expect(await codeOf(service.assignRole({ ...org(owner), membershipId: "m-owner-2", roleId: "role-viewer" }))).toBe("membership_not_found");
      });

      it("audits what it changes with the actor, and what the rules stopped as access.change_refused", async () => {
        const { service, guarded } = await world();
        await service.assignRole({ ...org(mgr), membershipId: "m-nobody", roleId: "role-viewer" });
        const changed = await guarded.auditLogs.search({ action: "membership.role_assigned" });
        expect(changed).toHaveLength(1);
        expect(changed[0]).toMatchObject({ organizationId: "org-1", actor: mgr, target: { type: "membership", id: "m-nobody" } });

        await service.assignRole({ ...org(mgr), membershipId: "m-nobody", roleId: "role-billing" }).catch(() => undefined);
        await service.blockMember({ ...org(mgr), membershipId: "m-owner" }).catch(() => undefined);
        await service.assignRole({ ...org(mgr), membershipId: "m-mgr", roleId: "role-viewer" }).catch(() => undefined);
        await service.assignRole({ ...org(owner), membershipId: "m-nobody", roleId: "role-owner" }).catch(() => undefined);
        const trail = await refusals(guarded);
        expect(trail.map((entry) => (entry.metadata as { code: string }).code).sort()).toEqual(["access_escalation", "access_owner_protected", "access_self_change", "access_target_stronger"]);
        expect(trail.every((entry) => entry.organizationId === "org-1")).toBe(true);
        expect(trail.find((entry) => (entry.metadata as { code: string }).code === "access_escalation")).toMatchObject({ actor: mgr, metadata: { operation: "assignRole" } });
      });

      it("honours expectedVersion and leaves the member untouched on a conflict", async () => {
        const { service } = await world();
        expect(await codeOf(service.assignRole({ ...org(mgr), membershipId: "m-nobody", roleId: "role-viewer", expectedVersion: 99 }))).toBe("membership_version_conflict");
        const first = await service.assignRole({ ...org(mgr), membershipId: "m-nobody", roleId: "role-viewer", expectedVersion: 1 });
        expect(first.version).toBe(2);
      });

      it("removes a member and the last Owner stays protected by the repository underneath", async () => {
        const { service, guarded } = await world();
        await service.removeMember({ ...org(mgr), membershipId: "m-ana" });
        expect(await guarded.memberships.findById("m-ana")).toBeNull();
        expect(await codeOf(service.removeMember({ ...org(mgr), membershipId: "m-owner" }))).toBe("access_target_stronger");
        expect(await codeOf(service.removeMember({ ...org(owner), membershipId: "m-owner" }))).toBe("access_self_change");
      });
    });

    describe("roles: the same rules for what a role holds", () => {
      it("creates and clones roles only with permissions the author holds", async () => {
        const { service } = await world();
        const created = await service.createRole({ ...org(mgr), name: "Report reader", permissionKeys: ["reports.read"] });
        expect(created).toMatchObject({ organizationId: "org-1", permissionKeys: ["reports.read"] });
        expect(await codeOf(service.createRole({ ...org(mgr), name: "Money", permissionKeys: ["billing.manage"] }))).toBe("access_escalation");
        expect(await codeOf(service.createRole({ ...org(ana), name: "Nope", permissionKeys: [] }))).toBe("access_forbidden");
        const clone = await service.cloneRole({ ...org(mgr), roleId: "role-viewer", name: "Viewer 2" });
        expect(clone.permissionKeys).toEqual(["reports.read"]);
        expect(await codeOf(service.cloneRole({ ...org(mgr), roleId: "role-billing", name: "Billing 2" }))).toBe("access_escalation");
        expect((await service.createRole({ ...org(owner), name: "Money", permissionKeys: ["billing.manage"] })).permissionKeys).toEqual(["billing.manage"]);
      });

      it("puts permissions into a role only if the actor holds them, and edits only roles within reach", async () => {
        const { service, guarded } = await world();
        const widened = await service.setRolePermissions({ ...org(mgr), roleId: "role-viewer", permissionKeys: ["reports.read", "reports.write"] });
        expect(widened.granted).toEqual(["reports.write"]);
        expect(await codeOf(service.setRolePermissions({ ...org(mgr), roleId: "role-viewer", permissionKeys: ["billing.manage"] }))).toBe("access_escalation");
        expect(await codeOf(service.grantRolePermission({ ...org(mgr), roleId: "role-viewer", permissionKey: "billing.manage" }))).toBe("access_escalation");
        expect((await service.grantRolePermission({ ...org(mgr), roleId: "role-limited", permissionKey: "reports.read" })).permissionKeys).toContain("reports.read");
        expect((await service.revokeRolePermission({ ...org(mgr), roleId: "role-limited", permissionKey: "reports.read" })).permissionKeys).not.toContain("reports.read");
        // Billing holds a permission the manager lacks: the manager cannot rewrite it, rename it, empty it or delete it.
        expect(await codeOf(service.setRolePermissions({ ...org(mgr), roleId: "role-billing", permissionKeys: [] }))).toBe("access_target_stronger");
        expect(await codeOf(service.revokeRolePermission({ ...org(mgr), roleId: "role-billing", permissionKey: "billing.manage" }))).toBe("access_target_stronger");
        expect(await codeOf(service.updateRole({ ...org(mgr), roleId: "role-billing", name: "Cheap" }))).toBe("access_target_stronger");
        expect(await codeOf(service.deleteRole({ ...org(mgr), roleId: "role-billing" }))).toBe("access_target_stronger");
        expect((await guarded.roles.findByIds(["role-billing"]))[0]).toMatchObject({ name: "Billing", permissionKeys: ["billing.manage"] });
        expect((await service.updateRole({ ...org(mgr), roleId: "role-viewer", name: "Reader", description: "Reads reports" })).name).toBe("Reader");
        expect((await service.setRolePermissions({ ...org(owner), roleId: "role-billing", permissionKeys: [] })).revoked).toEqual(["billing.manage"]);
      });

      it("deletes a role within reach and hands its members only a role the actor could give", async () => {
        const { service, guarded } = await world();
        expect(await codeOf(service.deleteRole({ ...org(mgr), roleId: "role-viewer", members: { reassignTo: "role-billing" } }))).toBe("access_escalation");
        expect((await guarded.memberships.findById("m-ana"))?.roleIds).toEqual(["role-viewer"]);
        await service.deleteRole({ ...org(mgr), roleId: "role-viewer", members: { reassignTo: "role-writer" } });
        expect((await guarded.memberships.findById("m-ana"))?.roleIds).toEqual(["role-writer"]);
        expect(await codeOf(service.deleteRole({ ...org(ana), roleId: "role-writer" }))).toBe("access_forbidden");
      });
    });

    describe("concurrency", () => {
      it("serializes the changes of one organization, so a decision and the write it allows see the same roles", async () => {
        const { service, guarded } = await world();
        // The manager gives roles while the Owner takes the manager role away, many times over. Whatever the interleaving, every
        // call either succeeds or is refused by the rules; none fails for another reason, and the member ends consistent.
        for (let round = 0; round < 6; round++) {
          const results = await Promise.all([
            codeOf(service.assignRole({ ...org(mgr), membershipId: "m-nobody", roleId: "role-viewer" })),
            codeOf(service.unassignRole({ ...org(owner), membershipId: "m-mgr", roleId: "role-manager" })),
            codeOf(service.assignRole({ ...org(owner), membershipId: "m-mgr", roleId: "role-manager" })),
            codeOf(service.unassignRole({ ...org(mgr), membershipId: "m-nobody", roleId: "role-viewer" })),
          ]);
          for (const code of results) expect(["ok", "access_forbidden", "access_escalation", "access_target_stronger"]).toContain(code);
        }
        const nobodyRoles = (await guarded.memberships.findById("m-nobody"))?.roleIds ?? [];
        expect(nobodyRoles.length).toBeLessThanOrEqual(1);
      });
    });

    describe("invitations", () => {
      const invitationService = (storage: UnioraStorage, extra: Partial<Parameters<typeof createInvitationService>[0]> = {}) =>
        createInvitationService({ storage, acceptUrl: (token) => `https://app.test/invite/${token}`, resendCooldownMs: 0, ...extra } as Parameters<typeof createInvitationService>[0]);
      const tokenOf = (result: { acceptUrl: string | null }) => result.acceptUrl!.split("/").pop()!;
      const invite = (invitations: ReturnType<typeof invitationService>, invitedBy: Identity, email: string, roleIds: string[]) =>
        invitations.invite({ organizationId: "org-1", email, roleIds, invitedBy });
      const newcomer: Identity = { provider: "auth", subject: "newcomer" };

      it("is enforced by default on a guarded storage: the inviter needs members.invite and must hold the roles they offer", async () => {
        const { guarded } = await world();
        const invitations = invitationService(guarded);
        const sent = await invite(invitations, mgr, "new@example.com", ["role-viewer", "role-writer"]);
        expect([...sent.invitation.roleIds].sort()).toEqual(["role-viewer", "role-writer"]);
        expect(await codeOf(invite(invitations, mgr, "money@example.com", ["role-billing"]))).toBe("access_escalation");
        expect(await codeOf(invite(invitations, ana, "other@example.com", ["role-viewer"]))).toBe("access_forbidden");
        expect(await codeOf(invite(invitations, owner, "money@example.com", ["role-billing"]))).toBe("ok");
        expect((await refusals(guarded)).map((entry) => (entry.metadata as { code: string }).code)).toEqual(["access_escalation"]);
      });

      it("can be switched off on a guarded storage only by writing as a trusted storage, and needs a nod on an unguarded one", async () => {
        const { guarded, raw } = await world();
        expect(await codeOf(invite(invitationService(guarded, { access: false }), mgr, "a@example.com", ["role-viewer"]))).toBe("access_authorization_required");
        const trusted = createTrustedAccessStorage(guarded, { actor: owner, reason: "host authorizes invitations itself" });
        expect(await codeOf(invite(invitationService(trusted, { access: false }), ana, "a@example.com", ["role-billing"]))).toBe("ok");
        expect(() => invitationService(raw, { access: true })).toThrow(/createGuardedStorage/);
        const optedIn = invitationService(raw, { access: { allowUnguardedStorage: true } });
        expect(await codeOf(invite(optedIn, mgr, "b@example.com", ["role-billing"]))).toBe("access_escalation");
        // Without the option an unguarded storage behaves as it always did: the host decides.
        expect(await codeOf(invite(invitationService(raw), ana, "c@example.com", ["role-billing"]))).toBe("ok");
      });

      it("gives the roles on accept and reports what the inviter could no longer give", async () => {
        const { guarded, raw } = await world();
        const invitations = invitationService(guarded);
        const sent = await invite(invitations, mgr, "new@example.com", ["role-viewer", "role-writer"]);
        // Between the invitation and the answer, the Viewer role grows past the manager.
        await raw.roles.grantPermission("role-viewer", "billing.manage");
        const accepted = await invitations.accept({ token: tokenOf(sent), identity: newcomer, verifiedEmail: "new@example.com" });
        expect(accepted.membership.roleIds).toEqual(["role-writer"]);
        expect(accepted.rolesSkipped).toEqual(["role-viewer"]);
        expect(accepted.alreadyMember).toBe(false);
      });

      it("refuses the whole acceptance, leaving the invitation pending, when the inviter can give nothing any more", async () => {
        const { guarded, raw } = await world();
        const invitations = invitationService(guarded);
        const sent = await invite(invitations, mgr, "new@example.com", ["role-viewer"]);
        await raw.memberships.unassignRole("m-mgr", "role-manager"); // demoted before the invitee answers
        expect(await codeOf(invitations.accept({ token: tokenOf(sent), identity: newcomer, verifiedEmail: "new@example.com" }))).toBe("invitation_roles_unavailable");
        expect(await guarded.memberships.findByIdentity("org-1", newcomer)).toBeNull();
        expect((await guarded.invitations.findById(sent.invitation.id))?.status).toBe("pending");
        // The Owner revokes it and invites again, and then it works.
        await invitations.revoke({ organizationId: "org-1", invitationId: sent.invitation.id, actor: owner });
        const again = await invite(invitations, owner, "new@example.com", ["role-viewer"]);
        const accepted = await invitations.accept({ token: tokenOf(again), identity: newcomer, verifiedEmail: "new@example.com" });
        expect(accepted.membership.roleIds).toEqual(["role-viewer"]);
      });

      it("never lets the inviter give themselves roles through their own address, nor touch an existing member above them", async () => {
        const { guarded } = await world();
        const invitations = invitationService(guarded);
        const self = await invite(invitations, mgr, "mgr@example.com", ["role-viewer"]);
        expect(await codeOf(invitations.accept({ token: tokenOf(self), identity: mgr, verifiedEmail: "mgr@example.com" }))).toBe("invitation_roles_unavailable");
        const above = await invite(invitations, mgr, "bill@example.com", ["role-viewer"]);
        expect(await codeOf(invitations.accept({ token: tokenOf(above), identity: bill, verifiedEmail: "bill@example.com" }))).toBe("invitation_roles_unavailable");
        expect((await guarded.memberships.findByIdentity("org-1", bill))?.roleIds).toEqual(["role-billing"]);
        // An existing member below the inviter simply gains the roles.
        const below = await invite(invitations, mgr, "ana@example.com", ["role-writer"]);
        const accepted = await invitations.accept({ token: tokenOf(below), identity: ana, verifiedEmail: "ana@example.com" });
        expect(accepted).toMatchObject({ alreadyMember: true, rolesSkipped: [] });
        expect(accepted.membership.roleIds.sort()).toEqual(["role-viewer", "role-writer"]);
      });

      it("applies the same gate to resend, revoke and the replay of an idempotent invitation", async () => {
        const { guarded } = await world();
        const invitations = invitationService(guarded);
        const key = "retry-1";
        const first = await invitations.invite({ organizationId: "org-1", email: "new@example.com", roleIds: ["role-viewer"], invitedBy: mgr, idempotencyKey: key });
        expect(first.replayed).not.toBe(true);
        expect(await codeOf(invitations.invite({ organizationId: "org-1", email: "new@example.com", roleIds: ["role-viewer"], invitedBy: ana, idempotencyKey: key }))).toBe("access_forbidden");
        const replay = await invitations.invite({ organizationId: "org-1", email: "new@example.com", roleIds: ["role-viewer"], invitedBy: mgr, idempotencyKey: key });
        expect(replay.replayed).toBe(true);

        const withMoney = await invite(invitations, owner, "money@example.com", ["role-billing"]);
        const ref = (actor: Identity, id: string) => ({ organizationId: "org-1", invitationId: id, actor });
        expect(await codeOf(invitations.resend(ref(ana, first.invitation.id)))).toBe("access_forbidden");
        expect(await codeOf(invitations.resend(ref(mgr, withMoney.invitation.id)))).toBe("access_escalation");
        expect(await codeOf(invitations.revoke(ref(mgr, withMoney.invitation.id)))).toBe("access_escalation");
        expect(await codeOf(invitations.resend(ref(mgr, first.invitation.id)))).toBe("ok");
        expect((await invitations.revoke(ref(mgr, first.invitation.id))).status).toBe("revoked");
        expect((await guarded.invitations.findById(withMoney.invitation.id))?.status).toBe("pending");
        expect((await invitations.revoke(ref(owner, withMoney.invitation.id))).status).toBe("revoked");
      });
    });
  });
}
