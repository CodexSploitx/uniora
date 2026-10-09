import { describe, expect, it } from "vitest";
import {
  AccessError,
  accessErrorToHttp,
  createAccessAdminService,
  createGuardedStorage,
  createInvitationService,
  createMemoryStorage,
  createOrganizationWithOwner,
  MembershipError,
  runAccessCommand,
} from "../index.js";

const owner = { provider: "p", subject: "owner" };
const mgr = { provider: "p", subject: "mgr" };
const ana = { provider: "p", subject: "ana" };

async function setup() {
  const raw = createMemoryStorage();
  for (const key of ["reports.read", "members.roles.manage", "members.invite", "roles.manage"]) await raw.permissions.register({ key });
  await createOrganizationWithOwner(raw, { organizationId: "org", organizationName: "Acme", ownerRoleId: "owner", membershipId: "m-owner", ownerIdentity: owner });
  await raw.roles.create({ id: "viewer", organizationId: "org", name: "Viewer", permissionKeys: ["reports.read"] });
  await raw.roles.create({ id: "manager", organizationId: "org", name: "Manager", permissionKeys: ["members.roles.manage", "members.invite", "roles.manage", "reports.read"] });
  await raw.memberships.create({ id: "m-mgr", organizationId: "org", identity: mgr, roleIds: ["manager"] });
  await raw.memberships.create({ id: "m-ana", organizationId: "org", identity: ana });
  const storage = createGuardedStorage(raw);
  const access = createAccessAdminService({ storage });
  const invitations = createInvitationService({ storage, acceptUrl: (token) => `https://app.test/invite/${token}` });
  return { services: { access, invitations }, raw };
}

const run = (services: Awaited<ReturnType<typeof setup>>["services"], command: string, actor: typeof mgr, params: unknown, includeAcceptUrl?: boolean) =>
  runAccessCommand(services, command, { actor, organizationId: "org", ...(includeAcceptUrl !== undefined ? { includeAcceptUrl } : {}) }, params);
const outcome = (promise: Promise<unknown>) => promise.then(() => "ok", (error: unknown) => (error as { code?: string }).code ?? String(error));

describe("runAccessCommand", () => {
  it("runs a command as the caller with a JSON-safe result", async () => {
    const { services } = await setup();
    const member = (await run(services, "assignRole", mgr, { membershipId: "m-ana", roleId: "viewer" })) as { roleIds: string[]; createdAt: string };
    expect(member.roleIds).toEqual(["viewer"]);
    expect(typeof member.createdAt).toBe("string");
    const until = new Date(Date.now() + 3_600_000).toISOString();
    expect(await run(services, "suspendMember", owner, { membershipId: "m-ana", until })).toMatchObject({ status: "suspended" });
    expect(await run(services, "removeMember", owner, { membershipId: "m-ana" })).toEqual({ removed: true });
  });

  it("hides the accept link unless the route asks for it", async () => {
    const { services } = await setup();
    const hidden = (await run(services, "inviteMember", mgr, { email: "new@example.com", roleIds: ["viewer"] })) as Record<string, unknown>;
    expect(hidden.acceptUrl).toBeUndefined();
    expect(hidden.invitation).toMatchObject({ email: "new@example.com" });
    const shown = (await run(services, "inviteMember", mgr, { email: "other@example.com", roleIds: ["viewer"] }, true)) as { acceptUrl: string };
    expect(shown.acceptUrl).toMatch(/^https:\/\/app\.test\/invite\//);
  });

  it("the services still decide: the rules and the permission gate hold behind the door", async () => {
    const { services } = await setup();
    expect(await outcome(run(services, "assignRole", ana, { membershipId: "m-ana", roleId: "viewer" }))).toBe("access_forbidden");
    expect(await outcome(run(services, "assignRole", mgr, { membershipId: "m-mgr", roleId: "viewer" }))).toBe("access_self_change");
    expect(await outcome(run(services, "assignRole", mgr, { membershipId: "m-owner", roleId: "viewer" }))).toBe("access_target_stronger");
    expect(await outcome(run(services, "assignRole", mgr, { membershipId: "m-ana", roleId: "owner" }))).toBe("access_owner_protected");
    expect(await outcome(run(services, "setRolePermissions", mgr, { roleId: "viewer", permissionKeys: ["members.invite"] }))).toBe("ok");
  });

  it("rejects unknown commands and any field the command does not declare", async () => {
    const { services } = await setup();
    expect(await outcome(run(services, "dropEverything", mgr, {}))).toBe("access_invalid");
    expect(await outcome(run(services, "assignRole", mgr, { membershipId: "m-ana", roleId: "viewer", actor: owner }))).toBe("access_invalid");
    expect(await outcome(run(services, "assignRole", mgr, { membershipId: "m-ana", roleId: "viewer", authorization: {} }))).toBe("access_invalid");
    expect(await outcome(run(services, "assignRole", mgr, { membershipId: "m-ana", roleId: "viewer", organizationId: "other" }))).toBe("access_invalid");
    expect(await outcome(run(services, "assignRole", mgr, { membershipId: "m-ana", roleId: "viewer", __proto__: { x: 1 }, constructor: 1 }))).toBe("access_invalid");
    expect(await outcome(run(services, "assignRole", mgr, { membershipId: "m-ana" }))).toBe("access_invalid");
    expect(await outcome(run(services, "assignRole", mgr, { membershipId: 5, roleId: "viewer" }))).toBe("access_invalid");
    expect(await outcome(run(services, "assignRole", mgr, null))).toBe("access_invalid");
    expect(await outcome(run(services, "suspendMember", owner, { membershipId: "m-ana", until: "not a date" }))).toBe("access_invalid");
    expect(await outcome(run(services, "deleteRole", mgr, { roleId: "viewer", members: { reassignTo: "x", other: 1 } }))).toBe("access_invalid");
    expect(await outcome(run(services, "setRolePermissions", mgr, { roleId: "viewer", permissionKeys: "reports.read" }))).toBe("access_invalid");
    expect(await outcome(run({ access: services.access }, "inviteMember", mgr, { email: "x@example.com", roleIds: ["viewer"] }))).toBe("access_invalid");
  });
});

describe("accessErrorToHttp", () => {
  it("answers the plain no, the reasoned no, missing rows, conflicts and bad input; ignores everything else", () => {
    const http = (code: ConstructorParameters<typeof AccessError>[1]) => accessErrorToHttp(new AccessError("m", code));
    expect(http("access_forbidden")).toEqual({ status: 403, body: { error: "forbidden", message: "You are not allowed to do that." } });
    for (const code of ["access_self_change", "access_escalation", "access_target_stronger", "access_owner_protected"] as const) {
      expect(http(code)).toMatchObject({ status: 403, body: { error: "forbidden", reason: code } });
    }
    expect(http("access_invalid")?.status).toBe(400);
    expect(http("access_authorization_required")).toMatchObject({ status: 500, body: { message: "Something went wrong." } });
    expect(http("access_storage_not_guarded")?.status).toBe(500);
    expect(accessErrorToHttp(new MembershipError("m", "membership_not_found"))?.status).toBe(404);
    expect(accessErrorToHttp(new MembershipError("m", "membership_version_conflict"))?.status).toBe(409);
    expect(accessErrorToHttp(new MembershipError("m", "last_owner"))?.status).toBe(409);
    expect(accessErrorToHttp(new Error("boom"))).toBeNull();
  });
});
