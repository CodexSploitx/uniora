import type { Identity } from "../identity/types.js";
import type { Membership } from "../membership/types.js";
import type { Role } from "../role/types.js";
import type { UnioraStorage, UnioraTransaction } from "../storage/types.js";

/** What a party can do, as the engine would answer: every permission (the Owner), or exactly these keys and what they imply. */
export interface Holdings {
  /** Holds the protected Owner role: every permission, now and in the future. */
  readonly owner: boolean;
  /** The permission keys held, already closed over implications (`appointments.write` brings `appointments.read`). */
  readonly keys: ReadonlySet<string>;
}

/** Nothing: a party that is blocked, suspended, not a member, or in an organization that is not active. */
export const NO_HOLDINGS: Holdings = { owner: false, keys: new Set() };

/** What something needs to be given, edited or touched: the Owner role, or this list of keys. */
export interface Needs {
  readonly owner: boolean;
  readonly keys: Iterable<string>;
}

type Scope = Pick<UnioraStorage | UnioraTransaction, "organizations" | "memberships" | "roles" | "permissions" | "supportGrants" | "identityLinks">;

/** The roles of `membership` that really belong to its organization, as the engine trusts them. */
async function rolesOf(scope: Pick<Scope, "roles">, membership: Membership): Promise<Role[]> {
  if (membership.roleIds.length === 0) return [];
  return (await scope.roles.findByIds(membership.roleIds)).filter((role) => role.organizationId === membership.organizationId);
}

/** What the roles of a member add up to (no status check, no expansion): the power a rule compares against. */
export async function needsOfMembership(scope: Pick<Scope, "roles">, membership: Membership): Promise<Needs> {
  const roles = await rolesOf(scope, membership);
  return needsOfRoles(roles);
}

export function needsOfRoles(roles: readonly Role[]): Needs {
  const keys = new Set<string>();
  for (const role of roles) for (const key of role.permissionKeys) keys.add(key);
  return { owner: roles.some((role) => role.isOwnerRole), keys };
}

/**
 * What `identity` can do in the organization, computed the way `engine.can` decides it: nothing while the organization is not
 * active or the member is blocked or suspended; otherwise the Owner flag, the keys of its roles of this organization and of its
 * active support grants, closed over implications. Compared with `covers`, never used to ALLOW anything on its own: the
 * permission gate of each operation is still a plain `engine.can`.
 */
export async function holdingsOf(scope: Scope, organizationId: string, identity: Identity): Promise<Holdings> {
  const organization = await scope.organizations.findById(organizationId);
  if (!organization || organization.status !== "active") return NO_HOLDINGS;
  const membership = await scope.memberships.findByIdentity(organizationId, identity);
  if (membership && membership.status !== "active") return NO_HOLDINGS;

  const roles = membership ? await rolesOf(scope, membership) : [];
  const owner = roles.some((role) => role.isOwnerRole);
  const keys = new Set<string>();
  for (const role of roles) for (const key of role.permissionKeys) keys.add(key);

  // A temporary support grant is held by the operator under their identity or the one it resolves to (as the engine reads it).
  const resolved = await scope.identityLinks.resolve(identity);
  const identities = resolved.provider === identity.provider && resolved.subject === identity.subject ? [identity] : [identity, resolved];
  for (const key of await scope.supportGrants.activePermissions(organizationId, identities)) keys.add(key);

  if (owner) return { owner: true, keys };
  return { owner: false, keys: new Set(keys.size === 0 ? [] : await scope.permissions.expand([...keys])) };
}

/** Whether `holder` already has everything `needs` asks for: the Owner flag if it is asked, and every key. */
export function covers(holder: Holdings, needs: Needs): boolean {
  if (holder.owner) return true;
  if (needs.owner) return false;
  for (const key of needs.keys) if (!holder.keys.has(key)) return false;
  return true;
}

/** Union of two needs (a role's keys before and after a change). */
export function joinNeeds(a: Needs, b: Needs): Needs {
  return { owner: a.owner || b.owner, keys: new Set([...a.keys, ...b.keys]) };
}

export function needsOfRole(role: Role): Needs {
  return { owner: role.isOwnerRole, keys: role.permissionKeys };
}

/** Whether `membership` is the member `identity` resolves to in its organization (the actor's own membership). */
export async function isSameMember(scope: Pick<Scope, "memberships">, identity: Identity, membership: Membership): Promise<boolean> {
  const mine = await scope.memberships.findByIdentity(membership.organizationId, identity);
  return mine !== null && mine.id === membership.id;
}
