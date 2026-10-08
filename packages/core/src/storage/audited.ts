import type { Identity } from "../identity/types.js";
import { randomId } from "../invitation/token.js";
import type { FeatureChangeMeta } from "../feature/types.js";
import { MAX_OUTBOX_PAYLOAD_BYTES } from "../outbox/repository.js";
import { sameTeamData } from "../team/repository.js";
import type { UnioraStorage, UnioraTransaction } from "./types.js";

export interface AuditedStorageOptions {
  /** Who is performing the operations recorded through this storage (e.g. the admin tool's operator). */
  actor: Identity;
  /**
   * Also enqueue an outbox event for each change, in the SAME transaction (type = the audit action, e.g.
   * `member.blocked`; payload = actor, target and the audit metadata). A worker delivers them after commit with
   * `dispatchOutbox`. Off by default. Invitations and identity links audit themselves and are not emitted here.
   */
  outbox?: boolean;
}

type Scope = UnioraStorage | UnioraTransaction;

/**
 * Wraps a storage so every mutation of organizations, memberships, roles, permissions and features
 * also writes an audit entry, in the SAME transaction as the change (audit F-05): the change and its
 * record commit or roll back together. Reads pass through untouched.
 *
 * Use it in admin surfaces (Studio, scripts, jobs) that call the repositories directly — the
 * repositories themselves stay audit-free so library code that already audits (invitations, identity
 * links) isn't recorded twice.
 */
export function createAuditedStorage(storage: UnioraStorage, options: AuditedStorageOptions): UnioraStorage {
  const { actor, outbox = false } = options;

  async function record(
    scope: Scope,
    action: string,
    organizationId: string | undefined,
    target: { type: string; id: string },
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    await scope.auditLogs.record({ id: `audit:${randomId()}`, organizationId, actor, action, target, metadata });
    if (outbox) {
      const base = { actor: { provider: actor.provider, subject: actor.subject }, target };
      const full = metadata ? { ...base, metadata } : base;
      // An oversized change (thousands of keys) must not make the change itself fail: the event keeps the facts, the audit log the detail.
      const payload = Buffer.byteLength(JSON.stringify(full), "utf8") <= MAX_OUTBOX_PAYLOAD_BYTES ? full : { ...base, metadataOmitted: true };
      await scope.outbox.enqueue({ id: `evt:${randomId()}`, type: action, organizationId, payload });
    }
  }

  /** The change's own context (who asked, why) as audit metadata — secrets never belong here. */
  function changeMetadata(meta?: FeatureChangeMeta): Record<string, unknown> | undefined {
    if (!meta) return undefined;
    return {
      ...(meta.reason ? { reason: meta.reason } : {}),
      ...(meta.actor ? { requestedBy: `${meta.actor.provider}:${meta.actor.subject}` } : {}),
    };
  }

  /** Runs `change` and its audit record atomically. */
  function atomically<T>(work: (tx: UnioraTransaction) => Promise<T>): Promise<T> {
    return storage.transaction(work);
  }

  function wrap(scope: Scope, run: <T>(work: (tx: UnioraTransaction) => Promise<T>) => Promise<T>): UnioraTransaction {
    const { organizations, memberships, roles, permissions, features, entitlements, supportGrants, teams, teamMemberships } = scope;
    return {
      ...scope,
      organizations: {
        ...organizations,
        create: (input) =>
          run(async (tx) => {
            const created = await tx.organizations.create(input);
            await record(tx, "organization.created", created.id, { type: "organization", id: created.id }, { name: created.name });
            return created;
          }),
        rename: (id, name) =>
          run(async (tx) => {
            const renamed = await tx.organizations.rename(id, name);
            if (renamed) await record(tx, "organization.renamed", id, { type: "organization", id }, { name });
            return renamed;
          }),
        update: (id, input) =>
          run(async (tx) => {
            const before = await tx.organizations.findById(id);
            const updated = await tx.organizations.update(id, input);
            if (before && updated) {
              const changed: Record<string, { from: string; to: string }> = {};
              if (before.name !== updated.name) changed.name = { from: before.name, to: updated.name };
              if (before.slug !== updated.slug) changed.slug = { from: before.slug, to: updated.slug };
              if (Object.keys(changed).length > 0) {
                await record(tx, "organization.updated", id, { type: "organization", id }, { changed });
              }
            }
            return updated;
          }),
        setStatus: (id, input) =>
          run(async (tx) => {
            const before = await tx.organizations.findById(id);
            const updated = await tx.organizations.setStatus(id, input);
            if (before && updated && before.status !== updated.status) {
              await record(tx, "organization.status_changed", id, { type: "organization", id }, {
                from: before.status,
                to: updated.status,
                ...(updated.statusChange?.reason !== undefined ? { reason: updated.statusChange.reason } : {}),
                requestedBy: `${input.actor.provider}:${input.actor.subject}`,
              });
            }
            return updated;
          }),
      },
      memberships: {
        ...memberships,
        create: (input) =>
          run(async (tx) => {
            const created = await tx.memberships.create(input);
            await record(tx, "membership.created", created.organizationId, { type: "membership", id: created.id });
            return created;
          }),
        assignRole: (membershipId, roleId, options) =>
          run(async (tx) => {
            const membership = await tx.memberships.findById(membershipId);
            await tx.memberships.assignRole(membershipId, roleId, options);
            await record(tx, "membership.role_assigned", membership?.organizationId, { type: "membership", id: membershipId }, { roleId });
          }),
        assignOwnerRole: (membershipId, roleId) =>
          run(async (tx) => {
            const membership = await tx.memberships.findById(membershipId);
            await tx.memberships.assignOwnerRole(membershipId, roleId);
            await record(tx, "membership.owner_role_assigned", membership?.organizationId, { type: "membership", id: membershipId }, { roleId });
          }),
        unassignRole: (membershipId, roleId, options) =>
          run(async (tx) => {
            const membership = await tx.memberships.findById(membershipId);
            await tx.memberships.unassignRole(membershipId, roleId, options);
            await record(tx, "membership.role_unassigned", membership?.organizationId, { type: "membership", id: membershipId }, { roleId });
          }),
        unassignOwnerRole: (membershipId, roleId) =>
          run(async (tx) => {
            const membership = await tx.memberships.findById(membershipId);
            await tx.memberships.unassignOwnerRole(membershipId, roleId);
            await record(tx, "membership.owner_role_unassigned", membership?.organizationId, { type: "membership", id: membershipId }, { roleId });
          }),
        block: (membershipId, input) =>
          run(async (tx) => {
            const blocked = await tx.memberships.block(membershipId, input);
            await record(tx, "membership.blocked", blocked.organizationId, { type: "membership", id: membershipId }, {
              ...(blocked.blocked?.reason ? { reason: blocked.blocked.reason } : {}),
              requestedBy: `${input.actor.provider}:${input.actor.subject}`,
            });
            return blocked;
          }),
        suspend: (membershipId, input) =>
          run(async (tx) => {
            const suspended = await tx.memberships.suspend(membershipId, input);
            await record(tx, "membership.suspended", suspended.organizationId, { type: "membership", id: membershipId }, {
              ...(suspended.blocked?.reason ? { reason: suspended.blocked.reason } : {}),
              ...(suspended.blocked?.until ? { until: suspended.blocked.until.toISOString() } : {}),
              requestedBy: `${input.actor.provider}:${input.actor.subject}`,
            });
            return suspended;
          }),
        unblock: (membershipId, input) =>
          run(async (tx) => {
            const unblocked = await tx.memberships.unblock(membershipId, input);
            await record(tx, "membership.unblocked", unblocked.organizationId, { type: "membership", id: membershipId }, {
              requestedBy: `${input.actor.provider}:${input.actor.subject}`,
            });
            return unblocked;
          }),
        delete: (membershipId) =>
          run(async (tx) => {
            const membership = await tx.memberships.findById(membershipId);
            await tx.memberships.delete(membershipId);
            await record(tx, "membership.deleted", membership?.organizationId, { type: "membership", id: membershipId });
          }),
      },
      roles: {
        ...roles,
        create: (input) =>
          run(async (tx) => {
            const created = await tx.roles.create(input);
            await record(tx, "role.created", created.organizationId, { type: "role", id: created.id }, { name: created.name });
            return created;
          }),
        createOwnerRole: (input) =>
          run(async (tx) => {
            const created = await tx.roles.createOwnerRole(input);
            await record(tx, "role.owner_created", created.organizationId, { type: "role", id: created.id });
            return created;
          }),
        grantPermission: (roleId, permissionKey) =>
          run(async (tx) => {
            const [role] = await tx.roles.findByIds([roleId]);
            await tx.roles.grantPermission(roleId, permissionKey);
            await record(tx, "role.permission_granted", role?.organizationId, { type: "role", id: roleId }, { permission: permissionKey });
          }),
        revokePermission: (roleId, permissionKey) =>
          run(async (tx) => {
            const [role] = await tx.roles.findByIds([roleId]);
            await tx.roles.revokePermission(roleId, permissionKey);
            await record(tx, "role.permission_revoked", role?.organizationId, { type: "role", id: roleId }, { permission: permissionKey });
          }),
        rename: (roleId, name) =>
          run(async (tx) => {
            const renamed = await tx.roles.rename(roleId, name);
            await record(tx, "role.renamed", renamed.organizationId, { type: "role", id: roleId }, { name });
            return renamed;
          }),
        update: (roleId, input) =>
          run(async (tx) => {
            const [found] = await tx.roles.findByIds([roleId]);
            // Copied first: the in-memory backend mutates the role it returns.
            const before = found ? { name: found.name, description: found.description ?? null } : undefined;
            const updated = await tx.roles.update(roleId, input);
            const changed: Record<string, unknown> = {};
            if (before && before.name !== updated.name) changed.name = { from: before.name, to: updated.name };
            if (before && before.description !== (updated.description ?? null)) changed.description = true;
            if (Object.keys(changed).length > 0) await record(tx, "role.updated", updated.organizationId, { type: "role", id: roleId }, { changed });
            return updated;
          }),
        setPermissions: (roleId, permissionKeys, options) =>
          run(async (tx) => {
            const [role] = await tx.roles.findByIds([roleId]);
            const result = await tx.roles.setPermissions(roleId, permissionKeys, options);
            if (result.granted.length > 0 || result.revoked.length > 0) {
              await record(tx, "role.permissions_replaced", role?.organizationId, { type: "role", id: roleId }, { granted: result.granted, revoked: result.revoked });
            }
            return result;
          }),
        clone: (roleId, input) =>
          run(async (tx) => {
            const cloned = await tx.roles.clone(roleId, input);
            await record(tx, "role.cloned", cloned.organizationId, { type: "role", id: cloned.id }, { from: roleId, name: cloned.name });
            return cloned;
          }),
        delete: (roleId, options) =>
          run(async (tx) => {
            const [role] = await tx.roles.findByIds([roleId]);
            await tx.roles.delete(roleId, options);
            const members =
              options?.members === undefined || options.members === "detach" ? "detach" : options.members === "reject" ? "reject" : { reassignTo: options.members.reassignTo };
            await record(tx, "role.deleted", role?.organizationId, { type: "role", id: roleId }, { members });
          }),
      },
      permissions: {
        ...permissions,
        register: (input) =>
          run(async (tx) => {
            const registered = await tx.permissions.register(input);
            await record(tx, "permission.registered", undefined, { type: "permission", id: registered.key });
            return registered;
          }),
        unregister: (key) =>
          run(async (tx) => {
            await tx.permissions.unregister(key);
            await record(tx, "permission.unregistered", undefined, { type: "permission", id: key });
          }),
      },
      entitlements: {
        ...entitlements,
        define: (input) =>
          run(async (tx) => {
            const defined = await tx.entitlements.define(input);
            await record(tx, "entitlement.defined", undefined, { type: "entitlement", id: defined.key }, { period: defined.period, defaultLimit: defined.defaultLimit });
            return defined;
          }),
        undefine: (key) =>
          run(async (tx) => {
            await tx.entitlements.undefine(key);
            await record(tx, "entitlement.removed", undefined, { type: "entitlement", id: key });
          }),
        setLimit: (organizationId, key, limit) =>
          run(async (tx) => {
            const before = await tx.entitlements.get(organizationId, key);
            const status = await tx.entitlements.setLimit(organizationId, key, limit);
            await record(tx, "entitlement.limit_changed", organizationId, { type: "entitlement", id: key }, { from: before.limit, to: status.limit });
            return status;
          }),
        clearLimit: (organizationId, key) =>
          run(async (tx) => {
            const before = await tx.entitlements.get(organizationId, key);
            const status = await tx.entitlements.clearLimit(organizationId, key);
            await record(tx, "entitlement.limit_cleared", organizationId, { type: "entitlement", id: key }, { from: before.limit, to: status.limit });
            return status;
          }),
      },
      supportGrants: {
        ...supportGrants,
        create: (input) =>
          run(async (tx) => {
            const grant = await tx.supportGrants.create(input);
            await record(
              tx,
              "support_grant.created",
              grant.organizationId,
              { type: "support_grant", id: grant.id },
              { operator: grant.operator, grantedBy: grant.grantedBy, permissions: grant.permissions, expiresAt: grant.expiresAt.toISOString(), reason: grant.reason },
            );
            return grant;
          }),
        revoke: (id, input) =>
          run(async (tx) => {
            const before = await tx.supportGrants.findById(id);
            const grant = await tx.supportGrants.revoke(id, input);
            if (grant && before && !before.revokedAt) {
              await record(tx, "support_grant.revoked", grant.organizationId, { type: "support_grant", id }, { operator: grant.operator, revokedBy: input.by });
            }
            return grant;
          }),
      },
      teams: {
        ...teams,
        create: (input) =>
          run(async (tx) => {
            const team = await tx.teams.create(input);
            await record(tx, "team.created", team.organizationId, { type: "team", id: team.id }, { name: team.name, slug: team.slug });
            return team;
          }),
        update: (organizationId, id, input) =>
          run(async (tx) => {
            const before = await tx.teams.findById(organizationId, id);
            const updated = await tx.teams.update(organizationId, id, input);
            if (before && before.version !== updated.version) {
              const changed: Record<string, unknown> = {};
              if (before.name !== updated.name) changed.name = { from: before.name, to: updated.name };
              if (before.slug !== updated.slug) changed.slug = { from: before.slug, to: updated.slug };
              if (before.externalId !== updated.externalId) changed.externalId = { from: before.externalId ?? null, to: updated.externalId ?? null };
              // Metadata and settings are the host's own data, possibly large: the entry says that they changed, not what they held.
              if (!sameTeamData(before.metadata, updated.metadata)) changed.metadata = true;
              if (!sameTeamData(before.settings, updated.settings)) changed.settings = true;
              await record(tx, "team.updated", organizationId, { type: "team", id }, { changed });
            }
            return updated;
          }),
        archive: (organizationId, id, input) =>
          run(async (tx) => {
            const before = await tx.teams.findById(organizationId, id);
            const team = await tx.teams.archive(organizationId, id, input);
            if (before && before.status !== team.status) {
              await record(tx, "team.archived", organizationId, { type: "team", id }, {
                requestedBy: `${input.actor.provider}:${input.actor.subject}`,
                ...(team.archived?.reason !== undefined ? { reason: team.archived.reason } : {}),
              });
            }
            return team;
          }),
        restore: (organizationId, id, input) =>
          run(async (tx) => {
            const before = await tx.teams.findById(organizationId, id);
            const team = await tx.teams.restore(organizationId, id, input);
            if (before && before.status !== team.status) {
              await record(tx, "team.restored", organizationId, { type: "team", id }, { requestedBy: `${input.actor.provider}:${input.actor.subject}` });
            }
            return team;
          }),
        delete: (organizationId, id) =>
          run(async (tx) => {
            const before = await tx.teams.findById(organizationId, id);
            await tx.teams.delete(organizationId, id);
            await record(tx, "team.deleted", organizationId, { type: "team", id }, before ? { name: before.name, slug: before.slug } : undefined);
          }),
      },
      teamMemberships: {
        ...teamMemberships,
        add: (input) =>
          run(async (tx) => {
            const before = await tx.teamMemberships.find(input.organizationId, input.teamId, input.membershipId);
            const row = await tx.teamMemberships.add(input);
            await record(
              tx,
              row.status === "pending" ? "team_member.invited" : before ? "team_member.reactivated" : "team_member.added",
              row.organizationId,
              { type: "team_member", id: row.id },
              { teamId: row.teamId, membershipId: row.membershipId, responsibility: row.responsibility, roleIds: row.roleIds },
            );
            return row;
          }),
        setStatus: (organizationId, id, status, input) =>
          run(async (tx) => {
            const before = await tx.teamMemberships.findById(organizationId, id);
            const row = await tx.teamMemberships.setStatus(organizationId, id, status, input);
            if (before && before.status !== row.status) {
              const action =
                row.status === "active" ? (before.status === "pending" ? "team_member.accepted" : "team_member.reactivated")
                : row.status === "suspended" ? "team_member.suspended"
                : "team_member.removed";
              await record(tx, action, organizationId, { type: "team_member", id }, {
                teamId: row.teamId,
                membershipId: row.membershipId,
                from: before.status,
                requestedBy: `${input.actor.provider}:${input.actor.subject}`,
                ...(row.statusChange?.reason !== undefined ? { reason: row.statusChange.reason } : {}),
              });
            }
            return row;
          }),
        setResponsibility: (organizationId, id, responsibility, options) =>
          run(async (tx) => {
            const before = await tx.teamMemberships.findById(organizationId, id);
            const row = await tx.teamMemberships.setResponsibility(organizationId, id, responsibility, options);
            if (before && before.responsibility !== row.responsibility) {
              const ownerInvolved = before.responsibility === "owner" || row.responsibility === "owner";
              await record(tx, ownerInvolved ? "team.owner_changed" : "team.manager_changed", organizationId, { type: "team_member", id }, {
                teamId: row.teamId,
                membershipId: row.membershipId,
                from: before.responsibility,
                to: row.responsibility,
              });
            }
            return row;
          }),
        assignRole: (organizationId, id, roleId, options) =>
          run(async (tx) => {
            const before = await tx.teamMemberships.findById(organizationId, id);
            const row = await tx.teamMemberships.assignRole(organizationId, id, roleId, options);
            if (before && !before.roleIds.includes(roleId)) {
              await record(tx, "team_member.role_assigned", organizationId, { type: "team_member", id }, { teamId: row.teamId, membershipId: row.membershipId, roleId });
            }
            return row;
          }),
        unassignRole: (organizationId, id, roleId, options) =>
          run(async (tx) => {
            const before = await tx.teamMemberships.findById(organizationId, id);
            const row = await tx.teamMemberships.unassignRole(organizationId, id, roleId, options);
            if (before?.roleIds.includes(roleId)) {
              await record(tx, "team_member.role_unassigned", organizationId, { type: "team_member", id }, { teamId: row.teamId, membershipId: row.membershipId, roleId });
            }
            return row;
          }),
      },
      features: {
        ...features,
        register: (input) =>
          run(async (tx) => {
            const registered = await tx.features.register(input);
            await record(tx, "feature.registered", undefined, { type: "feature", id: registered.key });
            return registered;
          }),
        unregister: (key) =>
          run(async (tx) => {
            await tx.features.unregister(key);
            await record(tx, "feature.unregistered", undefined, { type: "feature", id: key });
          }),
        enable: (organizationId, key, meta) =>
          run(async (tx) => {
            await tx.features.enable(organizationId, key, meta);
            await record(tx, "feature.enabled", organizationId, { type: "feature", id: key }, changeMetadata(meta));
          }),
        disable: (organizationId, key, meta) =>
          run(async (tx) => {
            await tx.features.disable(organizationId, key, meta);
            await record(tx, "feature.disabled", organizationId, { type: "feature", id: key }, changeMetadata(meta));
          }),
        setMany: (organizationId, changes, meta) =>
          run(async (tx) => {
            await tx.features.setMany(organizationId, changes, meta);
            await record(tx, "feature.bulk_changed", organizationId, { type: "organization", id: organizationId }, {
              changes,
              ...changeMetadata(meta),
            });
          }),
        disableEverywhere: (key, meta) =>
          run(async (tx) => {
            const result = await tx.features.disableEverywhere(key, meta);
            await record(tx, "feature.disabled_everywhere", undefined, { type: "feature", id: key }, { ...result, ...changeMetadata(meta) });
            return result;
          }),
      },
    };
  }

  // Inside a caller's own transaction the change joins it instead of opening another.
  const top = wrap(storage, atomically);
  return {
    ...top,
    transaction: (callback) => storage.transaction((tx) => callback(wrap(tx, (work) => work(tx)))),
  };
}
