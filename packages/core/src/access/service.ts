import type { Identity } from "../identity/types.js";
import type { Membership } from "../membership/types.js";
import type { Role } from "../role/types.js";
import type { UnioraStorage, UnioraTransaction } from "../storage/types.js";
import { createAuthorizationEngine } from "../authorization/engine.js";
import type { AuthorizationEngine, AuthorizationEngineOptions } from "../authorization/engine.js";
import { createAuditedStorage } from "../storage/audited.js";
import { MembershipError } from "../membership/repository.js";
import { RoleError } from "../role/repository.js";
import type { DeleteRoleMembers, SetRolePermissionsResult } from "../role/repository.js";
import { randomId } from "../invitation/token.js";
import { AccessError } from "./errors.js";
import { recordAccessRefusal } from "./refusal.js";
import { accessSet, issueAccessAuthorization } from "./authorization.js";
import type { AccessAuthorization, AccessBinding } from "./authorization.js";
import { isGuardedStorage } from "./guard.js";
import { ACCESS_PERMISSIONS, accessLockKey } from "./permissions.js";
import type { AccessPermissionKeys } from "./permissions.js";
import { covers, holdingsOf, isSameMember, joinNeeds, needsOfMembership, needsOfRole } from "./power.js";
import type { Holdings, Needs } from "./power.js";

export interface AccessAdminServiceOptions {
  /** Wrap it with `createGuardedStorage` first: otherwise nothing stops other code from writing power directly. */
  storage: UnioraStorage;
  /** Passed to the engine the service builds (for example `ownerRequiresRegisteredPermission` or `onDecision`). */
  engine?: AuthorizationEngineOptions;
  /** Replace any of the default permission keys. */
  permissions?: Partial<AccessPermissionKeys>;
  /**
   * Accept a storage that is not wrapped by `createGuardedStorage`. The rules still apply to every call of the service, but
   * any other code that holds the storage can still hand out power without them. Off by default (`access_storage_not_guarded`).
   */
  allowUnguardedStorage?: boolean;
}

/** Everything the service does on someone's behalf names that someone (from YOUR authentication, never from a request body). */
export interface AccessActor {
  /** The authenticated caller. It is the identity the engine is asked about and the actor of the audit entries. */
  actor: Identity;
  organizationId: string;
}

export interface MemberRef extends AccessActor {
  membershipId: string;
  /** Apply only if the membership is still at this `version`; otherwise `membership_version_conflict`. */
  expectedVersion?: number;
}

export interface RoleRef extends AccessActor {
  roleId: string;
}

export interface CreateRoleCommand extends AccessActor {
  id?: string;
  name: string;
  key?: string;
  description?: string;
  permissionKeys?: string[];
}

/**
 * Who may give which power to whom: the sibling of `TeamService` for the roles and members of the ORGANIZATION. The repositories
 * underneath authorize nothing ("the host decides"); this service is the host's decision, written once and tested:
 *
 * 1. **No escalation.** You can only give (assign, offer in an invitation, put into a role) what you hold yourself: a role only
 *    if you hold every permission in it, a permission only if you hold it. The Owner holds everything.
 * 2. **Nobody changes their own roles**, status or membership: no giving yourself a role, taking one off, blocking or removing
 *    yourself (leaving is `leaveOrganization`).
 * 3. **You do not touch whoever holds more power than you**: a member (or a role) is within reach only if every permission
 *    they hold is also yours. An Owner can only be touched by an Owner.
 * 4. **The Owner role does not move through here.** It stays with `assignOwnerRole` / `transferOwnership`.
 *
 * On top of the rules, each operation needs its own permission (`ACCESS_PERMISSIONS`), asked of the authorization engine in the
 * same transaction as the change; changes of one organization are serialized with an advisory lock so a decision and the write
 * it allows see the same roles; every change is audited with the actor; and a refusal by one of the four rules leaves an
 * `access.change_refused` entry. The writes carry an `AccessAuthorization` that only this service can issue, and a storage
 * wrapped by `createGuardedStorage` refuses a write without one.
 *
 * Power is compared as permission sets: "holds more than you" means "holds a permission you do not hold" (implications
 * included), not a ranking, so two administrators with different permissions cannot touch each other. Editing or deleting a role
 * needs the role to be within your reach; the people who hold it are not scanned (a role can have millions of holders).
 */
export interface AccessAdminService {
  assignRole(input: MemberRef & { roleId: string }): Promise<Membership>;
  unassignRole(input: MemberRef & { roleId: string }): Promise<Membership>;
  blockMember(input: MemberRef & { reason?: string }): Promise<Membership>;
  suspendMember(input: MemberRef & { until: Date; reason?: string }): Promise<Membership>;
  unblockMember(input: MemberRef): Promise<Membership>;
  /** Removes the member from the organization (their team memberships go with it). Leaving by yourself is `leaveOrganization`. */
  removeMember(input: AccessActor & { membershipId: string }): Promise<void>;

  createRole(input: CreateRoleCommand): Promise<Role>;
  /** Name and/or description. */
  updateRole(input: RoleRef & { name?: string; description?: string | null; expectedVersion?: number }): Promise<Role>;
  /** Makes the role hold exactly `permissionKeys`. You must hold the role's current permissions and every new one. */
  setRolePermissions(input: RoleRef & { permissionKeys: string[]; expectedVersion?: number }): Promise<SetRolePermissionsResult>;
  grantRolePermission(input: RoleRef & { permissionKey: string }): Promise<Role>;
  revokeRolePermission(input: RoleRef & { permissionKey: string }): Promise<Role>;
  cloneRole(input: RoleRef & { id?: string; name: string; key?: string; description?: string }): Promise<Role>;
  deleteRole(input: RoleRef & { members?: DeleteRoleMembers }): Promise<void>;
}

const forbidden = (what: string) => new AccessError(`You are not allowed to ${what}.`, "access_forbidden");
const selfChange = (what: string) => new AccessError(`You cannot ${what} yourself; ask someone else.`, "access_self_change");
const escalation = (what: string) => new AccessError(`You cannot ${what} that holds permissions you do not hold yourself.`, "access_escalation");
const stronger = (what: string) => new AccessError(`${what} holds more power than you, so you cannot change it.`, "access_target_stronger");
const ownerProtected = () =>
  new AccessError("The Owner role does not move through the access service: use assignOwnerRole, unassignOwnerRole or transferOwnership.", "access_owner_protected");

function assertText(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2000) throw new AccessError(`"${name}" is required.`, "access_invalid");
  return value;
}

function assertActor(input: AccessActor): void {
  assertText(input?.organizationId, "organizationId");
  if (typeof input.actor?.provider !== "string" || input.actor.provider === "" || typeof input.actor.subject !== "string" || input.actor.subject === "") {
    throw new AccessError('"actor" must be an identity.', "access_invalid");
  }
}

export function createAccessAdminService(options: AccessAdminServiceOptions): AccessAdminService {
  if (!isGuardedStorage(options.storage) && options.allowUnguardedStorage !== true) {
    throw new AccessError(
      "The access service needs a storage wrapped by createGuardedStorage(...), or the writes it allows can be bypassed. Pass allowUnguardedStorage: true to accept that.",
      "access_storage_not_guarded",
    );
  }
  const keys: AccessPermissionKeys = { ...ACCESS_PERMISSIONS, ...options.permissions };

  interface Context {
    tx: UnioraTransaction;
    engine: AuthorizationEngine;
    actor: Identity;
    organizationId: string;
    holdings(): Promise<Holdings>;
  }

  /** One transaction: the engine reads through it, and the audited view records the actor, so decision, change and audit agree. */
  function run<T>(actor: Identity, organizationId: string, work: (ctx: Context) => Promise<T>): Promise<T> {
    const audited = createAuditedStorage(options.storage, { actor });
    return audited.transaction(async (tx) => {
      // Changes of power in one organization queue up: what is decided below is still true when it is written.
      await tx.lock?.(accessLockKey(organizationId));
      const engine = createAuthorizationEngine({ ...tx, transaction: options.storage.transaction.bind(options.storage) } as UnioraStorage, options.engine);
      let held: Promise<Holdings> | undefined;
      return work({ tx, engine, actor, organizationId, holdings: () => (held ??= holdingsOf(tx, organizationId, actor)) });
    });
  }

  /**
   * The permission gate, then the work in one transaction. A refusal by one of the four rules leaves a trace (only people who
   * passed the gate get there, so strangers cannot flood the log); it is written after the failed transaction, best effort.
   */
  async function write<T>(
    input: AccessActor,
    permission: string,
    what: string,
    operation: string,
    target: { type: string; id: string },
    work: (ctx: Context) => Promise<T>,
  ): Promise<T> {
    assertActor(input);
    const { actor, organizationId } = input;
    try {
      return await run(actor, organizationId, async (ctx) => {
        if (!(await ctx.engine.can({ identity: actor, organizationId, permission }))) throw forbidden(what);
        return work(ctx);
      });
    } catch (error) {
      await recordAccessRefusal(options.storage, error, { organizationId, actor, operation, target });
      throw error;
    }
  }

  const grant = (ctx: Context, binding: AccessBinding): AccessAuthorization => issueAccessAuthorization(ctx.actor, binding);

  async function memberOf(ctx: Context, membershipId: string): Promise<Membership> {
    const found = await ctx.tx.memberships.findById(assertText(membershipId, "membershipId"));
    // A member of another organization is the same as a missing one: the actor learns nothing about it.
    if (!found || found.organizationId !== ctx.organizationId) throw new MembershipError(`Membership not found: ${membershipId}`, "membership_not_found");
    return found;
  }

  async function roleOf(ctx: Context, roleId: string): Promise<Role> {
    const [found] = await ctx.tx.roles.findByIds([assertText(roleId, "roleId")]);
    if (!found || found.organizationId !== ctx.organizationId) throw new RoleError(`Role not found: ${roleId}`, "role_not_found");
    return found;
  }

  /** Rules 2 and 3 for a member: not yourself, and not someone holding more than you. */
  async function assertCanTouchMember(ctx: Context, target: Membership, what: string): Promise<void> {
    if (await isSameMember(ctx.tx, ctx.actor, target)) throw selfChange(what);
    if (!covers(await ctx.holdings(), await needsOfMembership(ctx.tx, target))) throw stronger("This member");
  }

  /** Rule 1 for a set of permissions (a role to give, keys to write into a role). */
  async function assertHolds(ctx: Context, needs: Needs, what: string): Promise<void> {
    if (!covers(await ctx.holdings(), needs)) throw escalation(what);
  }

  /** Rule 3 for a role: it is within reach only if everything it holds is yours. */
  async function assertCanTouchRole(ctx: Context, role: Role): Promise<void> {
    if (!covers(await ctx.holdings(), needsOfRole(role))) throw stronger("This role");
  }

  const memberTarget = (membershipId: string) => ({ type: "membership", id: membershipId });
  const roleTarget = (roleId: string) => ({ type: "role", id: roleId });

  async function reload(ctx: Context, membershipId: string): Promise<Membership> {
    return (await ctx.tx.memberships.findById(membershipId)) as Membership;
  }

  async function reloadRole(ctx: Context, roleId: string): Promise<Role> {
    const [role] = await ctx.tx.roles.findByIds([roleId]);
    return role as Role;
  }

  /** Common to giving and taking a role: the organization's own role, never the Owner role. */
  function assertRegular(role: Role): void {
    if (role.isOwnerRole) throw ownerProtected();
  }

  return {
    assignRole: (input) =>
      write(input, keys.membersRoles, "give roles to members", "assignRole", memberTarget(input.membershipId), async (ctx) => {
        const target = await memberOf(ctx, input.membershipId);
        const role = await roleOf(ctx, input.roleId);
        assertRegular(role);
        await assertCanTouchMember(ctx, target, "give roles to");
        await assertHolds(ctx, needsOfRole(role), "give a role");
        await ctx.tx.memberships.assignRole(target.id, role.id, {
          ...(input.expectedVersion !== undefined ? { expectedVersion: input.expectedVersion } : {}),
          authorization: grant(ctx, { operation: "member.role.assign", target: target.id, detail: role.id }),
        });
        return reload(ctx, target.id);
      }),

    unassignRole: (input) =>
      write(input, keys.membersRoles, "take roles away from members", "unassignRole", memberTarget(input.membershipId), async (ctx) => {
        const target = await memberOf(ctx, input.membershipId);
        const role = await roleOf(ctx, input.roleId);
        assertRegular(role);
        // Touching the member is enough: a role the member holds is part of the power the rule just compared.
        await assertCanTouchMember(ctx, target, "take roles away from");
        await ctx.tx.memberships.unassignRole(target.id, role.id, {
          ...(input.expectedVersion !== undefined ? { expectedVersion: input.expectedVersion } : {}),
          authorization: grant(ctx, { operation: "member.role.unassign", target: target.id, detail: role.id }),
        });
        return reload(ctx, target.id);
      }),

    blockMember: (input) =>
      write(input, keys.membersBlock, "block members", "blockMember", memberTarget(input.membershipId), async (ctx) => {
        const target = await memberOf(ctx, input.membershipId);
        await assertCanTouchMember(ctx, target, "block");
        return ctx.tx.memberships.block(target.id, {
          actor: ctx.actor,
          ...(input.reason !== undefined ? { reason: input.reason } : {}),
          ...(input.expectedVersion !== undefined ? { expectedVersion: input.expectedVersion } : {}),
          authorization: grant(ctx, { operation: "member.status", target: target.id, detail: "block" }),
        });
      }),

    suspendMember: (input) =>
      write(input, keys.membersBlock, "suspend members", "suspendMember", memberTarget(input.membershipId), async (ctx) => {
        const target = await memberOf(ctx, input.membershipId);
        await assertCanTouchMember(ctx, target, "suspend");
        return ctx.tx.memberships.suspend(target.id, {
          actor: ctx.actor,
          until: input.until,
          ...(input.reason !== undefined ? { reason: input.reason } : {}),
          ...(input.expectedVersion !== undefined ? { expectedVersion: input.expectedVersion } : {}),
          authorization: grant(ctx, { operation: "member.status", target: target.id, detail: "suspend" }),
        });
      }),

    unblockMember: (input) =>
      write(input, keys.membersBlock, "unblock members", "unblockMember", memberTarget(input.membershipId), async (ctx) => {
        const target = await memberOf(ctx, input.membershipId);
        await assertCanTouchMember(ctx, target, "lift the block of");
        return ctx.tx.memberships.unblock(target.id, {
          actor: ctx.actor,
          ...(input.expectedVersion !== undefined ? { expectedVersion: input.expectedVersion } : {}),
          authorization: grant(ctx, { operation: "member.status", target: target.id, detail: "unblock" }),
        });
      }),

    removeMember: (input) =>
      write(input, keys.membersRemove, "remove members", "removeMember", memberTarget(input.membershipId), async (ctx) => {
        const target = await memberOf(ctx, input.membershipId);
        await assertCanTouchMember(ctx, target, "remove");
        await ctx.tx.memberships.delete(target.id, { authorization: grant(ctx, { operation: "member.delete", target: target.id }) });
      }),

    createRole: (input) => {
      const id = input.id ?? randomId();
      return write(input, keys.rolesManage, "create roles", "createRole", roleTarget(id), async (ctx) => {
        // A role is never created with permissions its author does not hold: it would be a role nobody below the Owner can give.
        await assertHolds(ctx, { owner: false, keys: input.permissionKeys ?? [] }, "create a role");
        return ctx.tx.roles.create({
          id,
          organizationId: ctx.organizationId,
          name: input.name,
          ...(input.key !== undefined ? { key: input.key } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.permissionKeys !== undefined ? { permissionKeys: input.permissionKeys } : {}),
          authorization: grant(ctx, {
            operation: "role.create",
            target: id,
            detail: accessSet(input.permissionKeys),
            organizationId: ctx.organizationId,
          }),
        });
      });
    },

    updateRole: (input) =>
      write(input, keys.rolesManage, "edit roles", "updateRole", roleTarget(input.roleId), async (ctx) => {
        const role = await roleOf(ctx, input.roleId);
        assertRegular(role);
        await assertCanTouchRole(ctx, role);
        return ctx.tx.roles.update(role.id, {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.expectedVersion !== undefined ? { expectedVersion: input.expectedVersion } : {}),
          authorization: grant(ctx, { operation: "role.edit", target: role.id, detail: "update" }),
        });
      }),

    setRolePermissions: (input) =>
      write(input, keys.rolesManage, "change what roles hold", "setRolePermissions", roleTarget(input.roleId), async (ctx) => {
        const role = await roleOf(ctx, input.roleId);
        assertRegular(role);
        // The role as it is (touching it) and as it will be (writing into it) must both be within reach.
        await assertCanTouchRole(ctx, role);
        await assertHolds(ctx, joinNeeds(needsOfRole(role), { owner: false, keys: input.permissionKeys }), "put permissions into a role");
        return ctx.tx.roles.setPermissions(role.id, input.permissionKeys, {
          ...(input.expectedVersion !== undefined ? { expectedVersion: input.expectedVersion } : {}),
          authorization: grant(ctx, { operation: "role.permissions", target: role.id, detail: `set:${accessSet(input.permissionKeys)}` }),
        });
      }),

    grantRolePermission: (input) =>
      write(input, keys.rolesManage, "change what roles hold", "grantRolePermission", roleTarget(input.roleId), async (ctx) => {
        const role = await roleOf(ctx, input.roleId);
        assertRegular(role);
        await assertCanTouchRole(ctx, role);
        await assertHolds(ctx, { owner: false, keys: [input.permissionKey] }, "put a permission into a role");
        await ctx.tx.roles.grantPermission(role.id, input.permissionKey, {
          authorization: grant(ctx, { operation: "role.permissions", target: role.id, detail: `grant:${input.permissionKey}` }),
        });
        return reloadRole(ctx, role.id);
      }),

    revokeRolePermission: (input) =>
      write(input, keys.rolesManage, "change what roles hold", "revokeRolePermission", roleTarget(input.roleId), async (ctx) => {
        const role = await roleOf(ctx, input.roleId);
        assertRegular(role);
        await assertCanTouchRole(ctx, role);
        await ctx.tx.roles.revokePermission(role.id, input.permissionKey, {
          authorization: grant(ctx, { operation: "role.permissions", target: role.id, detail: `revoke:${input.permissionKey}` }),
        });
        return reloadRole(ctx, role.id);
      }),

    cloneRole: (input) => {
      const id = input.id ?? randomId();
      return write(input, keys.rolesManage, "create roles", "cloneRole", roleTarget(id), async (ctx) => {
        const source = await roleOf(ctx, input.roleId);
        assertRegular(source);
        await assertHolds(ctx, needsOfRole(source), "clone a role");
        return ctx.tx.roles.clone(source.id, {
          id,
          name: input.name,
          organizationId: ctx.organizationId,
          ...(input.key !== undefined ? { key: input.key } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          authorization: grant(ctx, { operation: "role.create", target: id, detail: `clone:${source.id}`, organizationId: ctx.organizationId }),
        });
      });
    },

    deleteRole: (input) =>
      write(input, keys.rolesManage, "delete roles", "deleteRole", roleTarget(input.roleId), async (ctx) => {
        const role = await roleOf(ctx, input.roleId);
        assertRegular(role);
        await assertCanTouchRole(ctx, role);
        const members = input.members;
        if (members !== undefined && typeof members === "object") {
          // Everyone who held the role now holds the other one: it must be one the actor could give.
          const heir = await roleOf(ctx, members.reassignTo);
          assertRegular(heir);
          await assertHolds(ctx, needsOfRole(heir), "hand members a role");
        }
        const mode = members === undefined || members === "detach" ? "detach" : members === "reject" ? "reject" : `reassign:${members.reassignTo}`;
        await ctx.tx.roles.delete(role.id, {
          ...(members !== undefined ? { members } : {}),
          authorization: grant(ctx, { operation: "role.delete", target: role.id, detail: mode }),
        });
      }),
  };
}
