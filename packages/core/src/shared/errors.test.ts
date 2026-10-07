import { describe, expect, it } from "vitest";
import {
  FeatureError,
  IdentityLinkError,
  InvitationError,
  MembershipError,
  OrganizationError,
  PermissionError,
  RoleError,
  UnioraError,
  createMemoryStorage,
} from "../index.js";

const identity = { provider: "p", subject: "s" };

describe("stable error codes", () => {
  it("every error class is a UnioraError with a code, and the code survives instanceof checks", () => {
    for (const error of [
      new MembershipError("x"),
      new RoleError("x"),
      new PermissionError("x"),
      new FeatureError("x"),
      new OrganizationError("x"),
      new IdentityLinkError("x"),
      new InvitationError("x", "expired"),
    ]) {
      expect(error).toBeInstanceOf(UnioraError);
      expect(error).toBeInstanceOf(Error);
      expect(typeof error.code).toBe("string");
    }
    expect(new InvitationError("x", "expired").code).toBe("invitation_expired");
  });

  it.each([
    [MembershipError, "Membership not found: m1", "membership_not_found"],
    [MembershipError, "Role not found: r1", "role_not_found"],
    [MembershipError, 'Identity p:s already has a membership in organization "o".', "membership_exists"],
    [MembershipError, 'A membership with id "m" already exists.', "membership_exists"],
    [MembershipError, 'Cannot assign role "r" to membership "m": the role belongs to a different organization than the membership.', "role_wrong_organization"],
    [MembershipError, 'Cannot assign role "r" to membership "m": the role does not exist or belongs to a different organization than "o".', "role_wrong_organization"],
    [MembershipError, 'Cannot assign the protected Owner role "r" via assignRole() — use assignOwnerRole() instead.', "owner_role_protected"],
    [MembershipError, 'Cannot unassign the protected Owner role "r" via unassignRole() — use unassignOwnerRole() instead.', "owner_role_protected"],
    [MembershipError, 'Role "r" is not the protected Owner role — use assignRole() instead.', "not_owner_role"],
    [MembershipError, "Cannot remove the organization's last Owner — every organization must keep at least one.", "last_owner"],
    [MembershipError, "x: it is already linked as an alias of another identity (see IdentityLinkRepository.link)", "identity_aliased"],
    [RoleError, "Role not found: r", "role_not_found"],
    [RoleError, 'A role named "x" already exists in this organization.', "role_exists"],
    [RoleError, 'A role with id "x" already exists.', "role_exists"],
    [RoleError, 'A role with key "x" already exists in this organization.', "role_key_exists"],
    [RoleError, "Cannot modify permissions on the protected Owner role.", "owner_role_protected"],
    [RoleError, "Cannot delete the protected Owner role.", "owner_role_protected"],
    [RoleError, 'Organization "o" already has an Owner role.', "owner_role_exists"],
    [RoleError, 'Role key "owner" is reserved for the protected Owner role.', "role_key_reserved"],
    [RoleError, "Role name cannot be empty.", "role_name_invalid"],
    [RoleError, "Role key cannot be empty.", "role_key_invalid"],
    [RoleError, 'Could not derive a unique key from this role name — "a" is already taken in this organization. Pass an explicit `key`.', "role_key_exists"],
    [OrganizationError, 'Could not derive a unique slug from this organization name — "a" is already taken. Pass an explicit `slug`.', "organization_slug_taken"],
    [PermissionError, "Permission not found: a.b", "permission_not_found"],
    [PermissionError, 'Cannot unregister permission "a.b": it is still granted to at least one role. Revoke it everywhere first.', "permission_in_use"],
    [PermissionError, "Permission key cannot be empty.", "permission_key_invalid"],
    [PermissionError, "Permission name cannot be empty.", "permission_name_invalid"],
    [FeatureError, 'Feature "x" is not registered.', "feature_unknown"],
    [FeatureError, 'Feature "x" is not registered. Call features.register() first.', "feature_unknown"],
    [FeatureError, 'Cannot unregister feature "x": it is still enabled for at least one organization. Disable it everywhere first.', "feature_in_use"],
    [FeatureError, "Feature key cannot be empty.", "feature_key_invalid"],
    [FeatureError, "Feature name cannot be empty.", "feature_name_invalid"],
    [OrganizationError, 'An organization with slug "x" already exists.', "organization_slug_taken"],
    [OrganizationError, 'An organization with id "x" already exists.', "organization_exists"],
    [OrganizationError, "Organization name cannot be empty.", "organization_name_invalid"],
    [OrganizationError, "Organization slug cannot be empty.", "organization_slug_invalid"],
    [IdentityLinkError, "Cannot link an identity to itself.", "identity_link_self"],
    [IdentityLinkError, "Cannot link: the 'from' identity was linked concurrently by another request.", "identity_link_busy"],
    [IdentityLinkError, "Cannot link: the 'from' identity is already linked to a different target.", "identity_link_conflict"],
  ] as const)("%s(%j) -> %s", (ErrorClass, message, code) => {
    expect(new ErrorClass(message).code).toBe(code);
  });

  it("an explicit code wins over the one inferred from the message", () => {
    expect(new FeatureError("anything at all", "feature_in_use").code).toBe("feature_in_use");
  });

  it("errors thrown by storage carry the code, so callers never match on text", async () => {
    const storage = createMemoryStorage();
    await storage.organizations.create({ id: "o", name: "Acme" });
    const role = await storage.roles.createOwnerRole({ id: "r", organizationId: "o" });
    const membership = await storage.memberships.create({ id: "m", organizationId: "o", identity });

    await expect(storage.memberships.assignRole("nope", "r")).rejects.toMatchObject({ code: "membership_not_found" });
    await expect(storage.memberships.assignRole(membership.id, role.id)).rejects.toMatchObject({ code: "owner_role_protected" });
    await expect(storage.features.enable("o", "ghost")).rejects.toMatchObject({ code: "feature_unknown" });
    await storage.memberships.assignOwnerRole(membership.id, role.id);
    await expect(storage.memberships.delete(membership.id)).rejects.toMatchObject({ code: "last_owner" });
  });
});
