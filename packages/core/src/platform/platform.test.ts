import { describe, expect, it } from "vitest";
import {
  PLATFORM_PERMISSIONS,
  bootstrapPlatform,
  createAuthorizationEngine,
  createMemoryPlatformStorage,
  createMemoryStorage,
  createPlatformEngine,
  createPlatformService,
  PlatformError,
  isValidPlatformPermission,
  platformErrorToHttp,
  platformPermissionsCover,
  runPlatformCommand,
} from "../index.js";
import type { Identity } from "../index.js";
import { issuePlatformAuthorization } from "./authorization.js";

const root: Identity = { provider: "auth", subject: "root" };
const alice: Identity = { provider: "auth", subject: "alice" };
const bob: Identity = { provider: "auth", subject: "bob" };

async function setup(options: { stepUp?: () => boolean } = {}) {
  const storage = createMemoryStorage();
  const platform = createMemoryPlatformStorage({ auditLogs: storage.auditLogs });
  const { role: adminRole, member: rootMember } = await bootstrapPlatform({ platform, admin: root });
  const service = createPlatformService({ platform, storage, ...(options.stepUp ? { stepUp: options.stepUp } : {}) });
  return { storage, platform, service, adminRole, rootMember };
}

describe("platform permissions", () => {
  it("validates keys and wildcard coverage", () => {
    expect(isValidPlatformPermission("platform.organizations.read")).toBe(true);
    expect(isValidPlatformPermission("platform.*")).toBe(true);
    expect(isValidPlatformPermission("organizations.read")).toBe(false);
    expect(isValidPlatformPermission("platform.Orgs")).toBe(false);
    expect(isValidPlatformPermission("platform.x.*", { allowWildcard: false })).toBe(false);
    expect(platformPermissionsCover(["platform.organizations.*"], "platform.organizations.read")).toBe(true);
    expect(platformPermissionsCover(["platform.organizations.*"], "platform.members.read")).toBe(false);
    expect(platformPermissionsCover(["platform.organizations.*"], "platform.*")).toBe(false);
    expect(platformPermissionsCover(["platform.*"], "platform.organizations.*")).toBe(true);
  });
});

describe("bootstrap", () => {
  it("creates the system role and the first administrator exactly once", async () => {
    const { platform, adminRole, rootMember } = await setup();
    expect(adminRole).toMatchObject({ key: "platform_admin", isSystem: true, permissions: ["platform.*"] });
    expect(rootMember.roleIds).toEqual([adminRole.id]);
    await expect(bootstrapPlatform({ platform, admin: alice })).rejects.toMatchObject({ code: "platform_already_initialized" });
    const audit = await platform.auditLogs.search({ actionPrefix: "platform." });
    expect(audit.map((entry) => entry.action)).toEqual(["platform.bootstrapped"]);
    expect(audit[0]!.organizationId).toBeUndefined();
  });
});

describe("platform engine", () => {
  it("allows an active administrator, denies strangers and suspended members, and fails closed", async () => {
    const { platform, service } = await setup();
    const engine = createPlatformEngine(platform);
    expect(await engine.can({ identity: root, permission: "platform.billing.refund" })).toBe(true);
    expect(await engine.can({ identity: alice, permission: "platform.billing.refund" })).toBe(false);
    expect(await engine.can({ identity: root, permission: "platform.*" })).toBe(false);
    expect(await engine.can({ identity: { provider: "", subject: "" }, permission: "platform.x.y" })).toBe(false);
    const role = await service.createRole({ actor: root, key: "support", name: "Support", permissions: ["platform.organizations.read"] });
    const member = await service.addMember({ actor: root, identity: alice, roleIds: [role.id] });
    expect(await engine.can({ identity: alice, permission: "platform.organizations.read" })).toBe(true);
    expect(await engine.can({ identity: alice, permission: "platform.organizations.manage" })).toBe(false);
    await service.suspendMember({ actor: root, memberId: member.id, reason: "offboarding" });
    expect(await engine.can({ identity: alice, permission: "platform.organizations.read" })).toBe(false);
  });

  it("a broken decision hook never changes the answer", async () => {
    const { platform } = await setup();
    const engine = createPlatformEngine(platform, { onDecision: () => { throw new Error("boom"); } });
    expect(await engine.can({ identity: root, permission: "platform.x.y" })).toBe(true);
  });
});

describe("isolation from organizations", () => {
  it("an organization Owner has no platform power and a platform administrator has no organization power", async () => {
    const { storage, platform, service } = await setup();
    await storage.organizations.create({ id: "org", name: "Acme" });
    const owner = await storage.roles.createOwnerRole({ id: "owner", organizationId: "org" });
    await storage.memberships.create({ id: "m-alice", organizationId: "org", identity: alice });
    await storage.memberships.assignOwnerRole("m-alice", owner.id);
    const orgEngine = createAuthorizationEngine(storage);
    expect(await orgEngine.can({ identity: alice, organizationId: "org", permission: "anything.at_all" })).toBe(true);
    expect(await createPlatformEngine(platform).can({ identity: alice, permission: "platform.organizations.read" })).toBe(false);
    await expect(service.addMember({ actor: alice, identity: bob, roleIds: [] })).rejects.toMatchObject({ code: "platform_forbidden" });

    // The platform administrator is not a member of "org": the organization engine denies them.
    expect(await orgEngine.can({ identity: root, organizationId: "org", permission: "anything.at_all" })).toBe(false);
  });

  it("one identity can be a platform administrator and an organization Owner at the same time", async () => {
    const { storage, platform } = await setup();
    await storage.organizations.create({ id: "org", name: "Acme" });
    const owner = await storage.roles.createOwnerRole({ id: "owner", organizationId: "org" });
    await storage.memberships.create({ id: "m-root", organizationId: "org", identity: root });
    await storage.memberships.assignOwnerRole("m-root", owner.id);
    expect(await createAuthorizationEngine(storage).can({ identity: root, organizationId: "org", permission: "x.y" })).toBe(true);
    expect(await createPlatformEngine(platform).can({ identity: root, permission: "platform.x.y" })).toBe(true);
  });

  it("does not follow identity links", async () => {
    const { storage, platform } = await setup();
    await storage.identityLinks.link({ from: alice, to: root, actor: root }).catch(() => undefined);
    expect(await createPlatformEngine(platform).can({ identity: alice, permission: "platform.x.y" })).toBe(false);
  });
});

describe("storage-level authorization", () => {
  it("refuses every write that did not come through the service", async () => {
    const { platform, adminRole } = await setup();
    const forged = { actor: root } as never;
    await expect(platform.platformRoles.create({ id: "r", key: "evil", name: "Evil", permissions: ["platform.x.y"], authorization: forged })).rejects.toMatchObject({
      code: "platform_authorization_required",
    });
    await expect(platform.platformMembers.add({ id: "m", identity: alice, roleIds: [adminRole.id], addedBy: root, authorization: forged })).rejects.toMatchObject({
      code: "platform_authorization_required",
    });
    await expect(platform.platformMembers.add({ id: "m", identity: alice, roleIds: [adminRole.id], addedBy: root, authorization: undefined as never })).rejects.toMatchObject({
      code: "platform_authorization_required",
    });
  });
});

describe("platform service rules", () => {
  it("lets nobody change their own roles, status or membership", async () => {
    const { service, rootMember } = await setup();
    await expect(service.suspendMember({ actor: root, memberId: rootMember.id })).rejects.toMatchObject({ code: "platform_self_change" });
    await expect(service.removeMember({ actor: root, memberId: rootMember.id })).rejects.toMatchObject({ code: "platform_self_change" });
    await expect(service.addMember({ actor: root, identity: root, roleIds: [] })).rejects.toMatchObject({ code: "platform_self_change" });
  });

  it("blocks escalation: roles and members above your own permissions are out of reach", async () => {
    const { service, adminRole, rootMember } = await setup();
    const manager = await service.createRole({ actor: root, key: "team_lead", name: "Team lead", permissions: ["platform.members.manage", "platform.roles.manage"] });
    await service.addMember({ actor: root, identity: alice, roleIds: [manager.id] });
    // cannot create a role with permissions it does not hold
    await expect(service.createRole({ actor: alice, key: "big", name: "Big", permissions: ["platform.organizations.manage"] })).rejects.toMatchObject({ code: "platform_escalation" });
    // cannot hand out the administrator role
    await expect(service.addMember({ actor: alice, identity: bob, roleIds: [adminRole.id] })).rejects.toMatchObject({ code: "platform_escalation" });
    // cannot touch an administrator
    await expect(service.suspendMember({ actor: alice, memberId: rootMember.id })).rejects.toMatchObject({ code: "platform_escalation" });
    await expect(service.removeMember({ actor: alice, memberId: rootMember.id })).rejects.toMatchObject({ code: "platform_escalation" });
    // can create a role inside its own limits
    const ok = await service.createRole({ actor: alice, key: "viewer", name: "Viewer", permissions: ["platform.members.manage"] });
    expect(ok.permissions).toEqual(["platform.members.manage"]);
    // the wildcard is reserved
    await expect(service.createRole({ actor: root, key: "all", name: "All", permissions: ["platform.*"] })).rejects.toMatchObject({ code: "platform_permission_invalid" });
  });

  it("protects the system role and never lets administrators lock each other out", async () => {
    const { service, adminRole, rootMember } = await setup();
    await service.addMember({ actor: root, identity: alice, roleIds: [adminRole.id] });
    await expect(service.updateRole({ actor: root, roleId: adminRole.id, name: "Boss" })).rejects.toMatchObject({ code: "platform_role_system" });
    await expect(service.deleteRole({ actor: root, roleId: adminRole.id })).rejects.toMatchObject({ code: "platform_role_system" });
    // Two administrators suspending each other: the first wins, the second is already suspended and cannot act.
    await service.suspendMember({ actor: alice, memberId: rootMember.id });
    await expect(service.suspendMember({ actor: root, memberId: (await service.listMembers({ actor: alice })).find((m) => m.identity.subject === "alice")!.id })).rejects.toMatchObject({
      code: "platform_forbidden",
    });
  });

  it("the storage itself refuses to leave the platform without an active administrator", async () => {
    const { platform, adminRole, rootMember } = await setup();
    const token = () => issuePlatformAuthorization(root, ["member.status", "member.role", "member.remove"], { trusted: true });
    await expect(platform.platformMembers.setStatus(rootMember.id, "suspended", { by: root, authorization: token() })).rejects.toMatchObject({ code: "platform_last_admin" });
    await expect(platform.platformMembers.unassignRole(rootMember.id, adminRole.id, { by: root, authorization: token() })).rejects.toMatchObject({ code: "platform_last_admin" });
    await expect(platform.platformMembers.remove(rootMember.id, { by: root, authorization: token() })).rejects.toMatchObject({ code: "platform_last_admin" });
    expect((await platform.platformMembers.findById(rootMember.id))?.status).toBe("active");
  });

  it("requires a recent re-authentication when a step-up hook is configured, for changes only", async () => {
    let fresh = false;
    const { service } = await setup({ stepUp: () => fresh });
    await expect(service.createRole({ actor: root, key: "support", name: "Support", permissions: ["platform.organizations.read"] })).rejects.toMatchObject({
      code: "platform_step_up_required",
    });
    await expect(service.listMembers({ actor: root })).resolves.toHaveLength(1);
    fresh = true;
    await expect(service.createRole({ actor: root, key: "support", name: "Support", permissions: ["platform.organizations.read"] })).resolves.toBeDefined();
  });

  it("audits every change with the actor, as global entries", async () => {
    const { platform, service } = await setup();
    const role = await service.createRole({ actor: root, key: "support", name: "Support", permissions: ["platform.organizations.read"] });
    const member = await service.addMember({ actor: root, identity: alice, roleIds: [role.id] });
    await service.suspendMember({ actor: root, memberId: member.id, reason: "audit" });
    await service.reactivateMember({ actor: root, memberId: member.id });
    await service.removeMember({ actor: root, memberId: member.id });
    await service.deleteRole({ actor: root, roleId: role.id });
    const entries = await platform.auditLogs.search({ actionPrefix: "platform." });
    expect(entries.map((entry) => entry.action).sort()).toEqual(
      ["platform.bootstrapped", "platform.member_added", "platform.member_reactivated", "platform.member_removed", "platform.member_suspended", "platform.role_created", "platform.role_deleted"].sort(),
    );
    expect(entries.every((entry) => entry.organizationId === undefined)).toBe(true);
    expect(entries.every((entry) => entry.actor.subject === "root")).toBe(true);
  });

  it("refuses stale versions", async () => {
    const { service } = await setup();
    const role = await service.createRole({ actor: root, key: "support", name: "Support", permissions: ["platform.organizations.read"] });
    await service.updateRole({ actor: root, roleId: role.id, name: "Support 2", expectedVersion: 1 });
    await expect(service.updateRole({ actor: root, roleId: role.id, name: "Support 3", expectedVersion: 1 })).rejects.toMatchObject({ code: "platform_version_conflict" });
  });

  it("refuses to delete a role that is still held", async () => {
    const { service } = await setup();
    const role = await service.createRole({ actor: root, key: "support", name: "Support", permissions: ["platform.organizations.read"] });
    await service.addMember({ actor: root, identity: alice, roleIds: [role.id] });
    await expect(service.deleteRole({ actor: root, roleId: role.id })).rejects.toMatchObject({ code: "platform_role_in_use" });
  });
});

describe("platform operations on organizations", () => {
  it("lists and changes the status of organizations with the right permissions only", async () => {
    const { storage, service } = await setup();
    await storage.organizations.create({ id: "org", name: "Acme" });
    const reader = await service.createRole({ actor: root, key: "reader", name: "Reader", permissions: [PLATFORM_PERMISSIONS.organizationsRead] });
    await service.addMember({ actor: root, identity: alice, roleIds: [reader.id] });
    expect((await service.listOrganizations({ actor: alice })).map((org) => org.id)).toEqual(["org"]);
    await expect(service.setOrganizationStatus({ actor: alice, organizationId: "org", status: "suspended" })).rejects.toMatchObject({ code: "platform_forbidden" });
    const updated = await service.setOrganizationStatus({ actor: root, organizationId: "org", status: "suspended", reason: "unpaid" });
    expect(updated.status).toBe("suspended");
    const trail = await storage.auditLogs.search({ organizationId: "org", action: "organization.status_changed" });
    expect(trail).toHaveLength(1);
  });

  it("opens a support grant only for the actor and ends it on request", async () => {
    const { storage, service } = await setup();
    await storage.organizations.create({ id: "org", name: "Acme" });
    await storage.permissions.register({ key: "reports.read", name: "Read reports" });
    const grant = await service.grantSupportAccess({
      actor: root,
      organizationId: "org",
      permissions: ["reports.read"],
      reason: "Ticket 1",
      expiresAt: new Date(Date.now() + 3600_000),
    });
    expect(grant.operator).toEqual(root);
    expect(await createAuthorizationEngine(storage).can({ identity: root, organizationId: "org", permission: "reports.read" })).toBe(true);
    await service.revokeSupportAccess({ actor: root, grantId: grant.id });
    expect(await createAuthorizationEngine(storage).can({ identity: root, organizationId: "org", permission: "reports.read" })).toBe(false);
    await expect(
      service.grantSupportAccess({ actor: alice, organizationId: "org", permissions: ["reports.read"], reason: "x", expiresAt: new Date(Date.now() + 3600_000) }),
    ).rejects.toMatchObject({ code: "platform_forbidden" });
  });

  it("needs the organization storage for organization operations", async () => {
    const platform = createMemoryPlatformStorage();
    await bootstrapPlatform({ platform, admin: root });
    const service = createPlatformService({ platform });
    await expect(service.listOrganizations({ actor: root })).rejects.toMatchObject({ code: "platform_support_unavailable" });
  });
});

describe("platform commands (the door of a request handler)", () => {
  it("validates input field by field, rejects unknown fields and cannot smuggle an actor or an authorization", async () => {
    const { service } = await setup();
    const run = (command: string, params: unknown, actor: Identity = root) => runPlatformCommand(service, command, { actor }, params);
    await expect(run("nope", {})).rejects.toMatchObject({ code: "platform_invalid" });
    await expect(run("createRole", { key: "x_role", name: "X", permissions: [], actor: alice })).rejects.toMatchObject({ code: "platform_invalid" });
    await expect(run("createRole", { key: "x_role", name: "X", permissions: [], authorization: {} })).rejects.toMatchObject({ code: "platform_invalid" });
    await expect(run("createRole", { key: "x_role", permissions: [] })).rejects.toMatchObject({ code: "platform_invalid" });
    await expect(run("createRole", [])).rejects.toMatchObject({ code: "platform_invalid" });
    const role = (await run("createRole", { key: "support", name: "Support", permissions: ["platform.organizations.read"] })) as { id: string; createdAt: string };
    expect(typeof role.createdAt).toBe("string");
    const member = (await run("addMember", { provider: "auth", subject: "alice", roleIds: [role.id] })) as { id: string };
    // the actor is the one the handler resolved, whatever the body says
    await expect(run("addMember", { provider: "auth", subject: "bob", roleIds: [] }, alice)).rejects.toMatchObject({ code: "platform_forbidden" });
    expect(await run("listMembers", { status: "active" })).toHaveLength(2);
    await expect(run("listMembers", { status: "weird" })).rejects.toMatchObject({ code: "platform_invalid" });
    expect(await run("suspendMember", { memberId: member.id })).toMatchObject({ status: "suspended" });
    expect(await run("removeMember", { memberId: member.id })).toEqual({ removed: true });
  });

  it("maps errors to responses without explaining refusals", () => {
    expect(platformErrorToHttp(new PlatformError("secret detail", "platform_escalation"))).toEqual({
      status: 403,
      body: { error: "forbidden", message: "You are not allowed to do that." },
    });
    expect(platformErrorToHttp(new PlatformError("x", "platform_step_up_required"))?.status).toBe(428);
    expect(platformErrorToHttp(new PlatformError("x", "platform_last_admin"))?.status).toBe(409);
    expect(platformErrorToHttp(new PlatformError("x", "platform_member_not_found"))?.status).toBe(404);
    expect(platformErrorToHttp(new PlatformError("x", "platform_authorization_required"))?.status).toBe(500);
    expect(platformErrorToHttp(new Error("boom"))).toBeNull();
  });
});

describe("red-team regressions", () => {
  it("a storage authorization is single-use per operation", async () => {
    const { platform, adminRole } = await setup();
    const token = issuePlatformAuthorization(root, ["member.add"]);
    const add = (subject: string) => platform.platformMembers.add({ id: subject, identity: { provider: "auth", subject }, roleIds: [adminRole.id], addedBy: root, authorization: token });
    await add("one");
    await expect(add("two")).rejects.toMatchObject({ code: "platform_authorization_required" });
  });

  it("does not run the step-up hook for somebody who could not do the operation anyway", async () => {
    const storage = createMemoryStorage();
    const platform = createMemoryPlatformStorage({ auditLogs: storage.auditLogs });
    const { member } = await bootstrapPlatform({ platform, admin: root });
    let calls = 0;
    const service = createPlatformService({ platform, storage, stepUp: () => (calls++, false) });
    await expect(service.suspendMember({ actor: bob, memberId: member.id })).rejects.toMatchObject({ code: "platform_forbidden" });
    expect(calls).toBe(0);
    await expect(service.suspendMember({ actor: root, memberId: member.id })).rejects.toMatchObject({ code: "platform_step_up_required" });
    expect(calls).toBe(1);
  });

  it("a hanging onDecision hook never delays a decision", async () => {
    const storage = createMemoryStorage();
    const platform = createMemoryPlatformStorage({ auditLogs: storage.auditLogs });
    await bootstrapPlatform({ platform, admin: root });
    const engine = createPlatformEngine(platform, { onDecision: () => new Promise<void>(() => undefined) });
    expect(await engine.can({ identity: root, permission: PLATFORM_PERMISSIONS.rolesManage })).toBe(true);
  });

  it("the command door rejects inherited names and copies arrays", async () => {
    const { service } = await setup();
    const run = (params: unknown) => runPlatformCommand(service, "createRole", { actor: root }, params);
    for (const key of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
      await expect(run(JSON.parse(`{"key":"zz_role","name":"Z","permissions":[],"${key}":1}`))).rejects.toMatchObject({ code: "platform_invalid" });
    }
    const permissions = ["platform.audit.read"];
    const created = (await run({ key: "audit_role", name: "A", permissions })) as { permissions: string[] };
    permissions.push("platform.*");
    expect(created.permissions).toEqual(["platform.audit.read"]);
  });

  it("records refused escalations and self-changes, but not plain refusals", async () => {
    const { platform, service } = await setup();
    const role = await service.createRole({ actor: root, key: "lim", name: "Lim", permissions: [PLATFORM_PERMISSIONS.membersManage, PLATFORM_PERMISSIONS.rolesManage] });
    await service.addMember({ actor: root, identity: alice, roleIds: [role.id] });
    await expect(service.createRole({ actor: alice, key: "big", name: "Big", permissions: ["platform.organizations.*"] })).rejects.toMatchObject({ code: "platform_escalation" });
    await expect(service.createRole({ actor: bob, key: "big", name: "Big", permissions: [] })).rejects.toMatchObject({ code: "platform_forbidden" });
    const refused = await platform.auditLogs.search({ action: "platform.change_refused" });
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ actor: alice, metadata: { operation: "role.create", code: "platform_escalation" } });
  });

  it("an organization status request that changes nothing leaves no platform trail", async () => {
    const { storage, platform, service } = await setup();
    await storage.organizations.create({ id: "org", name: "Acme" });
    await service.setOrganizationStatus({ actor: root, organizationId: "org", status: "active" });
    expect(await platform.auditLogs.search({ action: "platform.organization_status_changed" })).toHaveLength(0);
    await service.setOrganizationStatus({ actor: root, organizationId: "org", status: "suspended" });
    expect(await platform.auditLogs.search({ action: "platform.organization_status_changed" })).toHaveLength(1);
  });

  it("ends an operator's own support grants when they are suspended, removed or lose the permission", async () => {
    const { storage, service } = await setup();
    await storage.organizations.create({ id: "org", name: "Acme" });
    await storage.permissions.register({ key: "reports.read", name: "Read reports" });
    const role = await service.createRole({ actor: root, key: "support", name: "Support", permissions: [PLATFORM_PERMISSIONS.supportGrant] });
    const member = await service.addMember({ actor: root, identity: alice, roleIds: [role.id] });
    const org = createAuthorizationEngine(storage);
    const open = () => service.grantSupportAccess({ actor: alice, organizationId: "org", permissions: ["reports.read"], reason: "Ticket", expiresAt: new Date(Date.now() + 3600_000) });
    const works = () => org.can({ identity: alice, organizationId: "org", permission: "reports.read" });

    await open();
    expect(await works()).toBe(true);
    await service.suspendMember({ actor: root, memberId: member.id });
    expect(await works()).toBe(false);

    await service.reactivateMember({ actor: root, memberId: member.id });
    await open();
    expect(await works()).toBe(true);
    await service.updateRole({ actor: root, roleId: role.id, permissions: [PLATFORM_PERMISSIONS.organizationsRead] });
    expect(await works()).toBe(false);

    await service.updateRole({ actor: root, roleId: role.id, permissions: [PLATFORM_PERMISSIONS.supportGrant] });
    await open();
    await service.removeMember({ actor: root, memberId: member.id });
    expect(await works()).toBe(false);
  });

  it("can cap the organization permissions a platform operator may open", async () => {
    const storage = createMemoryStorage();
    const platform = createMemoryPlatformStorage({ auditLogs: storage.auditLogs });
    await bootstrapPlatform({ platform, admin: root });
    await storage.organizations.create({ id: "org", name: "Acme" });
    await storage.permissions.register({ key: "reports.read", name: "Read reports" });
    await storage.permissions.register({ key: "billing.manage", name: "Manage billing" });
    const service = createPlatformService({ platform, storage, supportGrantablePermissions: ["reports.read"] });
    const base = { actor: root, organizationId: "org", reason: "Ticket", expiresAt: new Date(Date.now() + 3600_000) };
    await expect(service.grantSupportAccess({ ...base, permissions: ["billing.manage"] })).rejects.toMatchObject({ code: "platform_escalation" });
    await expect(service.grantSupportAccess({ ...base, permissions: ["reports.read"] })).resolves.toMatchObject({ permissions: ["reports.read"] });
  });
});
