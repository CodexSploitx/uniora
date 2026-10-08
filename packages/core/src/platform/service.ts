import type { Identity } from "../identity/types.js";
import { sameIdentity } from "../identity/types.js";
import type { Organization, OrganizationStatus } from "../organization/types.js";
import type { SearchOrganizationsOptions } from "../organization/repository.js";
import type { SupportGrant } from "../support-grant/types.js";
import { createAuditedStorage } from "../storage/audited.js";
import type { UnioraStorage } from "../storage/types.js";
import { issuePlatformAuthorization } from "./authorization.js";
import type { PlatformOperation } from "./authorization.js";
import { createPlatformEngine, permissionsOfRoles } from "./engine.js";
import type { PlatformEngine, PlatformEngineOptions } from "./engine.js";
import { PlatformError } from "./errors.js";
import { PLATFORM_PERMISSIONS, platformPermissionsCoverAll } from "./permissions.js";
import { PLATFORM_LOCK_KEY, assertPlatformIdentity, sanitizePlatformReason } from "./repository.js";
import type {
  CreatePlatformRoleInput,
  PlatformStorage,
  PlatformTransaction,
  SearchPlatformMembersOptions,
  SearchPlatformRolesOptions,
  UpdatePlatformRoleInput,
} from "./repository.js";
import type { PlatformMember, PlatformRole } from "./types.js";

export type PlatformServiceOperation =
  | "role.create"
  | "role.update"
  | "role.delete"
  | "member.add"
  | "member.suspend"
  | "member.reactivate"
  | "member.remove"
  | "member.role"
  | "organization.status"
  | "support.grant"
  | "support.revoke";

export interface PlatformServiceOptions {
  /** The platform scope: roles, members, and the audit log the changes are recorded in. */
  platform: PlatformStorage;
  /**
   * The organization storage. Only needed for the operations that reach into organizations (`listOrganizations`,
   * `setOrganizationStatus`, `grantSupportAccess`, `revokeSupportAccess`); everything else works without it.
   */
  storage?: UnioraStorage;
  engine?: PlatformEngineOptions;
  /**
   * Step-up authentication. Called before every change (never before a read) with the operation about to run; return
   * `false` when the actor has not re-authenticated recently enough (MFA, a fresh sign-in) and the change is refused with
   * `platform_step_up_required`. UNIORA does not do authentication, so what "recently" means is yours to check.
   */
  stepUp?: (input: { actor: Identity; operation: PlatformServiceOperation }) => boolean | Promise<boolean>;
}

export interface PlatformActor {
  /** The authenticated identity on whose behalf this is done. */
  actor: Identity;
}

export interface GrantSupportAccessInput extends PlatformActor {
  organizationId: string;
  /** Registered organization permission keys, 1 to 50. */
  permissions: string[];
  reason: string;
  /** Strictly in the future and at most 30 days away. */
  expiresAt: Date;
  id?: string;
}

/**
 * The ONLY sanctioned way to change who holds platform power, and the way to use it on organizations. Every operation asks
 * the platform engine first, inside the same transaction as the change, and writes the audit entry with the actor:
 *
 * - Nobody changes their own roles or status, adds themselves or removes themselves (no self-promotion).
 * - You can only hand out, edit or take away what you hold yourself: a role's permissions, and the roles of a member whose
 *   permissions exceed yours, are out of reach (`platform_escalation`). `platform.*` is held only by the system role.
 * - The last active Platform Administrator can never be suspended, demoted or removed (`platform_last_admin`).
 * - Organization owners, admins and roles play no part in any of it.
 *
 * It uses the plain repositories underneath, which authorize nothing by themselves except through the single-use tokens
 * only this service issues: never hand `platform.platformMembers` to code that serves end users.
 */
export interface PlatformService {
  /** The decision engine over the same storage, for your own `platform.*` checks in your admin panel. */
  readonly engine: PlatformEngine;

  listRoles(input: PlatformActor & SearchPlatformRolesOptions): Promise<PlatformRole[]>;
  listMembers(input: PlatformActor & SearchPlatformMembersOptions): Promise<PlatformMember[]>;

  createRole(input: PlatformActor & Omit<CreatePlatformRoleInput, "authorization" | "id" | "isSystem"> & { id?: string }): Promise<PlatformRole>;
  updateRole(input: PlatformActor & { roleId: string } & Omit<UpdatePlatformRoleInput, "authorization">): Promise<PlatformRole>;
  deleteRole(input: PlatformActor & { roleId: string }): Promise<void>;

  addMember(input: PlatformActor & { identity: Identity; roleIds: string[]; id?: string }): Promise<PlatformMember>;
  suspendMember(input: PlatformActor & { memberId: string; reason?: string; expectedVersion?: number }): Promise<PlatformMember>;
  reactivateMember(input: PlatformActor & { memberId: string; expectedVersion?: number }): Promise<PlatformMember>;
  removeMember(input: PlatformActor & { memberId: string }): Promise<void>;
  assignRole(input: PlatformActor & { memberId: string; roleId: string; expectedVersion?: number }): Promise<PlatformMember>;
  unassignRole(input: PlatformActor & { memberId: string; roleId: string; expectedVersion?: number }): Promise<PlatformMember>;

  /** Needs `platform.organizations.read` and the organization storage. */
  listOrganizations(input: PlatformActor & SearchOrganizationsOptions): Promise<Organization[]>;
  /** Needs `platform.organizations.manage`. Recorded in the organization's own audit trail too. */
  setOrganizationStatus(input: PlatformActor & { organizationId: string; status: OrganizationStatus; reason?: string }): Promise<Organization>;
  /**
   * Opens a temporary, narrow, audited support grant FOR THE ACTOR in one organization (see support grants). You cannot grant
   * it to anyone else, and it never carries the Owner role. Needs `platform.support.grant`.
   */
  grantSupportAccess(input: GrantSupportAccessInput): Promise<SupportGrant>;
  /** Ends a support grant now. Needs `platform.support.grant`. */
  revokeSupportAccess(input: PlatformActor & { grantId: string }): Promise<SupportGrant>;
}

const forbidden = (what: string) => new PlatformError(`You are not allowed to ${what}.`, "platform_forbidden");
const escalation = (what: string) =>
  new PlatformError(`You cannot ${what}: it involves permissions you do not hold yourself.`, "platform_escalation");

export function createPlatformService(options: PlatformServiceOptions): PlatformService {
  const { platform } = options;

  interface Context {
    tx: PlatformTransaction;
    engine: PlatformEngine;
    actor: Identity;
  }

  function requireStorage(): UnioraStorage {
    if (!options.storage) {
      throw new PlatformError("This operation needs the organization storage: pass `storage` to createPlatformService.", "platform_support_unavailable");
    }
    return options.storage;
  }

  /** One transaction, serialised against every other platform change, with an engine that reads through it. */
  async function run<T>(actor: Identity, write: boolean, work: (ctx: Context) => Promise<T>): Promise<T> {
    assertPlatformIdentity(actor, "actor");
    return platform.transaction(async (tx) => {
      if (write) await tx.lock?.(PLATFORM_LOCK_KEY);
      return work({ tx, engine: createPlatformEngine(tx, options.engine), actor });
    });
  }

  async function stepUp(actor: Identity, operation: PlatformServiceOperation): Promise<void> {
    if (!options.stepUp) return;
    let ok = false;
    try {
      ok = (await options.stepUp({ actor, operation })) === true;
    } catch {
      ok = false;
    }
    if (!ok) throw new PlatformError("This change needs a recent re-authentication.", "platform_step_up_required");
  }

  async function need(ctx: Context, permission: string, what: string): Promise<string[]> {
    if (!(await ctx.engine.can({ identity: ctx.actor, permission }))) throw forbidden(what);
    return ctx.engine.permissionsOf(ctx.actor);
  }

  const grant = (ctx: Context, ...operations: PlatformOperation[]) => issuePlatformAuthorization(ctx.actor, operations);

  async function record(ctx: Context, action: string, target: { type: string; id: string }, metadata: Record<string, unknown> = {}): Promise<void> {
    await ctx.tx.auditLogs.record({ id: crypto.randomUUID(), actor: ctx.actor, action, target, metadata });
  }

  const identityText = (identity: Identity) => `${identity.provider}:${identity.subject}`;

  async function loadMember(ctx: Context, memberId: string): Promise<PlatformMember> {
    const member = await ctx.tx.platformMembers.findById(memberId);
    if (!member) throw new PlatformError(`Platform member not found: ${memberId}`, "platform_member_not_found");
    return member;
  }

  async function loadRole(ctx: Context, roleId: string): Promise<PlatformRole> {
    const role = await ctx.tx.platformRoles.findById(roleId);
    if (!role) throw new PlatformError(`Platform role not found: ${roleId}`, "platform_role_not_found");
    return role;
  }

  /** The actor may act on a member only if it holds everything the member holds. */
  async function assertOutranks(ctx: Context, mine: string[], target: PlatformMember, what: string): Promise<void> {
    const roles = await ctx.tx.platformRoles.findByIds(target.roleIds);
    if (!platformPermissionsCoverAll(mine, permissionsOfRoles(roles))) throw escalation(what);
  }

  const notSelf = (ctx: Context, member: PlatformMember, what: string): void => {
    if (sameIdentity(member.identity, ctx.actor)) {
      throw new PlatformError(`You cannot ${what} yourself; ask another administrator.`, "platform_self_change");
    }
  };

  return {
    engine: createPlatformEngine(platform, options.engine),

    listRoles: ({ actor, ...search }) =>
      run(actor, false, async (ctx) => {
        await need(ctx, PLATFORM_PERMISSIONS.rolesRead, "read platform roles");
        return ctx.tx.platformRoles.search(search);
      }),

    listMembers: ({ actor, ...search }) =>
      run(actor, false, async (ctx) => {
        await need(ctx, PLATFORM_PERMISSIONS.membersRead, "read platform members");
        return ctx.tx.platformMembers.search(search);
      }),

    async createRole({ actor, id, ...input }) {
      await stepUp(actor, "role.create");
      return run(actor, true, async (ctx) => {
        const mine = await need(ctx, PLATFORM_PERMISSIONS.rolesManage, "create platform roles");
        if (!platformPermissionsCoverAll(mine, Array.isArray(input.permissions) ? input.permissions : [])) throw escalation("create this role");
        const role = await ctx.tx.platformRoles.create({ ...input, id: id ?? crypto.randomUUID(), authorization: grant(ctx, "role.create") });
        await record(ctx, "platform.role_created", { type: "platform_role", id: role.id }, { key: role.key, permissions: role.permissions });
        return role;
      });
    },

    async updateRole({ actor, roleId, ...input }) {
      await stepUp(actor, "role.update");
      return run(actor, true, async (ctx) => {
        const mine = await need(ctx, PLATFORM_PERMISSIONS.rolesManage, "edit platform roles");
        const before = await loadRole(ctx, roleId);
        if (before.isSystem) throw new PlatformError("A system role cannot be changed.", "platform_role_system");
        if (!platformPermissionsCoverAll(mine, before.permissions)) throw escalation("edit this role");
        if (input.permissions && !platformPermissionsCoverAll(mine, input.permissions)) throw escalation("give this role those permissions");
        const role = await ctx.tx.platformRoles.update(roleId, { ...input, authorization: grant(ctx, "role.update") });
        await record(ctx, "platform.role_updated", { type: "platform_role", id: roleId }, {
          key: role.key,
          ...(input.permissions ? { from: before.permissions, to: role.permissions } : {}),
        });
        return role;
      });
    },

    async deleteRole({ actor, roleId }) {
      await stepUp(actor, "role.delete");
      return run(actor, true, async (ctx) => {
        const mine = await need(ctx, PLATFORM_PERMISSIONS.rolesManage, "delete platform roles");
        const role = await loadRole(ctx, roleId);
        if (!role.isSystem && !platformPermissionsCoverAll(mine, role.permissions)) throw escalation("delete this role");
        await ctx.tx.platformRoles.delete(roleId, { authorization: grant(ctx, "role.delete") });
        await record(ctx, "platform.role_deleted", { type: "platform_role", id: roleId }, { key: role.key });
      });
    },

    async addMember({ actor, identity, roleIds, id }) {
      await stepUp(actor, "member.add");
      assertPlatformIdentity(identity, "new member");
      return run(actor, true, async (ctx) => {
        const mine = await need(ctx, PLATFORM_PERMISSIONS.membersManage, "add platform members");
        if (sameIdentity(identity, ctx.actor)) throw new PlatformError("You cannot add yourself.", "platform_self_change");
        const roles = await ctx.tx.platformRoles.findByIds(Array.isArray(roleIds) ? roleIds : []);
        if (!platformPermissionsCoverAll(mine, permissionsOfRoles(roles))) throw escalation("add a member with those roles");
        const member = await ctx.tx.platformMembers.add({ id: id ?? crypto.randomUUID(), identity, roleIds, addedBy: ctx.actor, authorization: grant(ctx, "member.add") });
        await record(ctx, "platform.member_added", { type: "platform_member", id: member.id }, { member: identityText(identity), roleIds: member.roleIds });
        return member;
      });
    },

    async suspendMember({ actor, memberId, reason, expectedVersion }) {
      await stepUp(actor, "member.suspend");
      return run(actor, true, async (ctx) => {
        const mine = await need(ctx, PLATFORM_PERMISSIONS.membersManage, "suspend platform members");
        const member = await loadMember(ctx, memberId);
        notSelf(ctx, member, "suspend");
        await assertOutranks(ctx, mine, member, "suspend this member");
        const updated = await ctx.tx.platformMembers.setStatus(memberId, "suspended", {
          by: ctx.actor,
          ...(reason !== undefined ? { reason } : {}),
          ...(expectedVersion !== undefined ? { expectedVersion } : {}),
          authorization: grant(ctx, "member.status"),
        });
        if (member.status !== updated.status) {
          const clean = sanitizePlatformReason(reason);
          await record(ctx, "platform.member_suspended", { type: "platform_member", id: memberId }, { member: identityText(member.identity), ...(clean ? { reason: clean } : {}) });
        }
        return updated;
      });
    },

    async reactivateMember({ actor, memberId, expectedVersion }) {
      await stepUp(actor, "member.reactivate");
      return run(actor, true, async (ctx) => {
        const mine = await need(ctx, PLATFORM_PERMISSIONS.membersManage, "reactivate platform members");
        const member = await loadMember(ctx, memberId);
        notSelf(ctx, member, "reactivate");
        await assertOutranks(ctx, mine, member, "reactivate this member");
        const updated = await ctx.tx.platformMembers.setStatus(memberId, "active", {
          by: ctx.actor,
          ...(expectedVersion !== undefined ? { expectedVersion } : {}),
          authorization: grant(ctx, "member.status"),
        });
        if (member.status !== updated.status) {
          await record(ctx, "platform.member_reactivated", { type: "platform_member", id: memberId }, { member: identityText(member.identity) });
        }
        return updated;
      });
    },

    async removeMember({ actor, memberId }) {
      await stepUp(actor, "member.remove");
      return run(actor, true, async (ctx) => {
        const mine = await need(ctx, PLATFORM_PERMISSIONS.membersManage, "remove platform members");
        const member = await loadMember(ctx, memberId);
        notSelf(ctx, member, "remove");
        await assertOutranks(ctx, mine, member, "remove this member");
        await ctx.tx.platformMembers.remove(memberId, { by: ctx.actor, authorization: grant(ctx, "member.remove") });
        await record(ctx, "platform.member_removed", { type: "platform_member", id: memberId }, { member: identityText(member.identity), roleIds: member.roleIds });
      });
    },

    async assignRole({ actor, memberId, roleId, expectedVersion }) {
      await stepUp(actor, "member.role");
      return run(actor, true, async (ctx) => {
        const mine = await need(ctx, PLATFORM_PERMISSIONS.membersManage, "change platform members' roles");
        const member = await loadMember(ctx, memberId);
        notSelf(ctx, member, "change the roles of");
        await assertOutranks(ctx, mine, member, "change this member's roles");
        const role = await loadRole(ctx, roleId);
        if (!platformPermissionsCoverAll(mine, role.permissions)) throw escalation("assign this role");
        const updated = await ctx.tx.platformMembers.assignRole(memberId, roleId, {
          by: ctx.actor,
          ...(expectedVersion !== undefined ? { expectedVersion } : {}),
          authorization: grant(ctx, "member.role"),
        });
        if (updated.version !== member.version) {
          await record(ctx, "platform.member_role_assigned", { type: "platform_member", id: memberId }, { member: identityText(member.identity), roleId, roleKey: role.key });
        }
        return updated;
      });
    },

    async unassignRole({ actor, memberId, roleId, expectedVersion }) {
      await stepUp(actor, "member.role");
      return run(actor, true, async (ctx) => {
        const mine = await need(ctx, PLATFORM_PERMISSIONS.membersManage, "change platform members' roles");
        const member = await loadMember(ctx, memberId);
        notSelf(ctx, member, "change the roles of");
        await assertOutranks(ctx, mine, member, "change this member's roles");
        const role = await loadRole(ctx, roleId);
        const updated = await ctx.tx.platformMembers.unassignRole(memberId, roleId, {
          by: ctx.actor,
          ...(expectedVersion !== undefined ? { expectedVersion } : {}),
          authorization: grant(ctx, "member.role"),
        });
        if (updated.version !== member.version) {
          await record(ctx, "platform.member_role_unassigned", { type: "platform_member", id: memberId }, { member: identityText(member.identity), roleId, roleKey: role.key });
        }
        return updated;
      });
    },

    listOrganizations: ({ actor, ...search }) =>
      run(actor, false, async (ctx) => {
        await need(ctx, PLATFORM_PERMISSIONS.organizationsRead, "list organizations");
        return requireStorage().organizations.search(search);
      }),

    async setOrganizationStatus({ actor, organizationId, status, reason }) {
      await stepUp(actor, "organization.status");
      const storage = requireStorage();
      const clean = sanitizePlatformReason(reason);
      await run(actor, false, (ctx) => need(ctx, PLATFORM_PERMISSIONS.organizationsManage, "change an organization's status"));
      const audited = createAuditedStorage(storage, { actor });
      const updated = await audited.organizations.setStatus(organizationId, { status, actor, ...(clean !== undefined ? { reason: clean } : {}) });
      if (!updated) throw new PlatformError(`Organization not found: ${organizationId}`, "platform_invalid");
      await run(actor, true, (ctx) => record(ctx, "platform.organization_status_changed", { type: "organization", id: organizationId }, { status, ...(clean ? { reason: clean } : {}) }));
      return updated;
    },

    async grantSupportAccess({ actor, organizationId, permissions, reason, expiresAt, id }) {
      await stepUp(actor, "support.grant");
      const storage = requireStorage();
      await run(actor, false, (ctx) => need(ctx, PLATFORM_PERMISSIONS.supportGrant, "open support access"));
      const audited = createAuditedStorage(storage, { actor });
      // The operator is always the actor: platform power never lets you hand organization access to somebody else.
      const created = await audited.supportGrants.create({
        id: id ?? crypto.randomUUID(),
        organizationId,
        operator: actor,
        grantedBy: actor,
        reason,
        permissions,
        expiresAt,
      });
      await run(actor, true, (ctx) =>
        record(ctx, "platform.support_access_granted", { type: "support_grant", id: created.id }, { organizationId, permissions: created.permissions, expiresAt: created.expiresAt.toISOString() }),
      );
      return created;
    },

    async revokeSupportAccess({ actor, grantId }) {
      await stepUp(actor, "support.revoke");
      const storage = requireStorage();
      await run(actor, false, (ctx) => need(ctx, PLATFORM_PERMISSIONS.supportGrant, "end support access"));
      const audited = createAuditedStorage(storage, { actor });
      const revoked = await audited.supportGrants.revoke(grantId, { by: actor });
      if (!revoked) throw new PlatformError(`Support grant not found: ${grantId}`, "platform_invalid");
      await run(actor, true, (ctx) => record(ctx, "platform.support_access_revoked", { type: "support_grant", id: grantId }, { organizationId: revoked.organizationId }));
      return revoked;
    },
  };
}
