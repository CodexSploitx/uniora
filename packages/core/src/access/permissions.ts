/**
 * The permission keys the access service (and the invitation service, when it enforces the rules) ask the authorization engine
 * about. Register them in your catalog and give them to the roles that should administer members; override any of them with
 * `createAccessAdminService({ permissions })`.
 */
export const ACCESS_PERMISSIONS = {
  /** Give a role to a member or take one away. */
  membersRoles: "members.roles.manage",
  /** Create, resend and revoke invitations. */
  membersInvite: "members.invite",
  /** Block, suspend and unblock a member. */
  membersBlock: "members.block",
  /** Remove a member from the organization. */
  membersRemove: "members.remove",
  /** Create, edit, clone and delete roles and change what a role holds. */
  rolesManage: "roles.manage",
} as const;

export type AccessPermissionKeys = { [K in keyof typeof ACCESS_PERMISSIONS]: string };

/** The advisory lock every change of who holds which power takes, so two of them in one organization never interleave. */
export function accessLockKey(organizationId: string): string {
  return `uniora:access:${organizationId}`;
}
