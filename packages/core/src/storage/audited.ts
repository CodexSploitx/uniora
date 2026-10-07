import type { Identity } from "../identity/types.js";
import { randomId } from "../invitation/token.js";
import type { FeatureChangeMeta } from "../feature/types.js";
import type { UnioraStorage, UnioraTransaction } from "./types.js";

export interface AuditedStorageOptions {
  /** Who is performing the operations recorded through this storage (e.g. the admin tool's operator). */
  actor: Identity;
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
  const { actor } = options;

  async function record(
    scope: Scope,
    action: string,
    organizationId: string | undefined,
    target: { type: string; id: string },
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    await scope.auditLogs.record({ id: `audit:${randomId()}`, organizationId, actor, action, target, metadata });
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
    const { organizations, memberships, roles, permissions, features } = scope;
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
        assignRole: (membershipId, roleId) =>
          run(async (tx) => {
            const membership = await tx.memberships.findById(membershipId);
            await tx.memberships.assignRole(membershipId, roleId);
            await record(tx, "membership.role_assigned", membership?.organizationId, { type: "membership", id: membershipId }, { roleId });
          }),
        assignOwnerRole: (membershipId, roleId) =>
          run(async (tx) => {
            const membership = await tx.memberships.findById(membershipId);
            await tx.memberships.assignOwnerRole(membershipId, roleId);
            await record(tx, "membership.owner_role_assigned", membership?.organizationId, { type: "membership", id: membershipId }, { roleId });
          }),
        unassignRole: (membershipId, roleId) =>
          run(async (tx) => {
            const membership = await tx.memberships.findById(membershipId);
            await tx.memberships.unassignRole(membershipId, roleId);
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
        delete: (roleId) =>
          run(async (tx) => {
            const [role] = await tx.roles.findByIds([roleId]);
            await tx.roles.delete(roleId);
            await record(tx, "role.deleted", role?.organizationId, { type: "role", id: roleId });
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
