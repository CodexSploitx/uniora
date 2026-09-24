import type { Identity } from "../identity/types.js";
import { sameIdentity } from "../identity/types.js";
import type { Organization } from "../organization/types.js";
import type { CreateOrganizationInput, OrganizationRepository } from "../organization/repository.js";
import { OrganizationError, resolveOrganizationSlug, sanitizeOrganizationName } from "../organization/slug.js";
import type { Membership } from "../membership/types.js";
import type { CreateMembershipInput, MembershipListing, MembershipRepository, SearchMembershipsOptions } from "../membership/repository.js";
import { MembershipError } from "../membership/repository.js";
import type { Role } from "../role/types.js";
import type { CreateOwnerRoleInput, CreateRoleInput, RoleRepository, RoleSummary } from "../role/repository.js";
import { RoleError } from "../role/repository.js";
import { resolveRoleKey, sanitizeRolePermissionKeys, sanitizeRoleName, assertNonEmptyPermissionKey } from "../role/key.js";
import type { Permission } from "../permission/types.js";
import type { PermissionRepository, RegisterPermissionInput } from "../permission/repository.js";
import { PermissionError } from "../permission/repository.js";
import { assertValidPermissionKey, sanitizePermissionName } from "../permission/key.js";
import type { Feature, FeatureDefinition } from "../feature/types.js";
import type { FeatureRepository, FeatureUsage, RegisterFeatureInput } from "../feature/repository.js";
import { FeatureError } from "../feature/repository.js";
import { resolveFeatureKey, sanitizeFeatureName } from "../feature/key.js";
import type { AuditLogEntry } from "../audit-log/types.js";
import type {
  AuditLogRepository,
  ListAuditLogOptions,
  ListRecentAuditLogOptions,
  RecordAuditLogInput,
} from "../audit-log/repository.js";
import type { IdentityLink } from "../identity-link/types.js";
import type { IdentityLinkRepository, LinkIdentityInput } from "../identity-link/repository.js";
import { IdentityLinkError } from "../identity-link/repository.js";
import type { UnioraStorage, UnioraTransaction } from "./types.js";

function identityKey(identity: Identity): string {
  return `${identity.provider}:${identity.subject}`;
}

/**
 * Reference storage adapter backed by plain JS maps.
 * Intended for tests and local prototyping — never for production use,
 * since nothing here is persisted (docs/PROYECT.md §16 lists PostgreSQL
 * as the first real adapter).
 */
export function createMemoryStorage(): UnioraStorage {
  const organizations = new Map<string, Organization>();
  const memberships = new Map<string, Membership>();
  const roles = new Map<string, Role>();
  const permissions = new Map<string, Permission>();
  const features = new Map<string, Feature>();
  const featureDefinitions = new Map<string, FeatureDefinition>();
  const auditLogs: AuditLogEntry[] = [];
  const identityLinksByFromKey = new Map<string, IdentityLink>();

  // Defined before `membershipRepository` because `findByIdentity` calls
  // `resolve()` directly.
  const identityLinkRepository: IdentityLinkRepository = {
    async link(input: LinkIdentityInput) {
      if (sameIdentity(input.from, input.to)) {
        throw new IdentityLinkError("Cannot link an identity to itself.");
      }

      const fromHasOwnMembership = [...memberships.values()].some((m) => sameIdentity(m.identity, input.from));
      if (fromHasOwnMembership) {
        throw new IdentityLinkError(
          "Cannot link: the 'from' identity already owns a membership directly. Linking it would create an ambiguous/hijackable lookup.",
        );
      }

      const existing = identityLinksByFromKey.get(identityKey(input.from));
      if (existing) {
        if (sameIdentity(existing.to, input.to)) return existing; // idempotent
        throw new IdentityLinkError("Cannot link: the 'from' identity is already linked to a different target.");
      }

      if (identityLinksByFromKey.has(identityKey(input.to))) {
        throw new IdentityLinkError("Cannot link: the 'to' identity is itself an alias of another identity (no chains).");
      }

      const link: IdentityLink = { from: input.from, to: input.to, linkedAt: new Date() };
      identityLinksByFromKey.set(identityKey(input.from), link);
      return link;
    },
    async resolve(identity: Identity) {
      return identityLinksByFromKey.get(identityKey(identity))?.to ?? identity;
    },
  };

  const organizationRepository: OrganizationRepository = {
    async create(input: CreateOrganizationInput) {
      const name = sanitizeOrganizationName(input.name);
      const slug = resolveOrganizationSlug(name, input.slug);

      const slugTaken = [...organizations.values()].some((o) => o.slug === slug);
      if (slugTaken) {
        throw new OrganizationError(
          input.slug !== undefined
            ? `An organization with slug "${slug}" already exists.`
            : `Could not derive a unique slug from this organization name — "${slug}" is already taken. Pass an explicit \`slug\`.`,
        );
      }

      const organization: Organization = { id: input.id, slug, name, createdAt: new Date() };
      organizations.set(organization.id, organization);
      return organization;
    },
    async findById(id) {
      return organizations.get(id) ?? null;
    },
    async findByIds(ids) {
      return ids.flatMap((id) => organizations.get(id) ?? []);
    },
    async list() {
      return [...organizations.values()];
    },
    async search(options) {
      const query = options?.query?.trim().toLowerCase();
      const matches = [...organizations.values()].filter(
        (organization) =>
          !query || organization.name.toLowerCase().includes(query) || organization.slug.toLowerCase().includes(query),
      );
      const sorted = matches.sort(
        (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      );
      const after = options?.after;
      const page = after
        ? sorted.filter(
            (organization) =>
              organization.createdAt.getTime() > after.createdAt.getTime() ||
              (organization.createdAt.getTime() === after.createdAt.getTime() && organization.id > after.id),
          )
        : sorted;
      return options?.limit !== undefined ? page.slice(0, options.limit) : page;
    },
    async count(options) {
      const query = options?.query?.trim().toLowerCase();
      if (!query) return organizations.size;
      return [...organizations.values()].filter(
        (organization) => organization.name.toLowerCase().includes(query) || organization.slug.toLowerCase().includes(query),
      ).length;
    },
  };

  // The organization's Owner-role invariant (skill §11): a `roleId` is
  // "the last Owner holder" of `excludeMembershipId` when that role is the
  // protected Owner role AND no other membership currently has it.
  // Assigning the Owner role to several memberships is allowed — only
  // dropping the very last holder is blocked.
  function isLastOwnerRoleHolder(roleId: string, excludeMembershipId: string): boolean {
    const role = roles.get(roleId);
    if (!role?.isOwnerRole) return false;
    return ![...memberships.values()].some((m) => m.id !== excludeMembershipId && m.roleIds.includes(roleId));
  }

  function matchingMemberships(options?: { organizationId?: string; query?: string; identity?: Identity }): Membership[] {
    const query = options?.query?.trim().toLowerCase();
    return [...memberships.values()].filter(
      (m) =>
        (options?.organizationId === undefined || m.organizationId === options.organizationId) &&
        (options?.identity === undefined || sameIdentity(m.identity, options.identity)) &&
        (!query || m.identity.subject.toLowerCase().includes(query) || m.identity.provider.toLowerCase().includes(query)),
    );
  }

  const membershipRepository: MembershipRepository = {
    async create(input: CreateMembershipInput) {
      const membership: Membership = {
        id: input.id,
        organizationId: input.organizationId,
        identity: input.identity,
        roleIds: [...(input.roleIds ?? [])],
      };
      memberships.set(membership.id, membership);
      return membership;
    },
    async findByIdentity(organizationId: string, identity: Identity) {
      const resolved = await identityLinkRepository.resolve(identity);
      for (const membership of memberships.values()) {
        if (membership.organizationId === organizationId && sameIdentity(membership.identity, resolved)) {
          return membership;
        }
      }
      return null;
    },
    async listByOrganization(organizationId) {
      return [...memberships.values()].filter((m) => m.organizationId === organizationId);
    },
    async findById(id) {
      return memberships.get(id) ?? null;
    },
    async search(options) {
      const matches = matchingMemberships(options).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const after = options?.after;
      const page = after === undefined ? matches : matches.filter((m) => m.id > after);
      return options?.limit !== undefined ? page.slice(0, options.limit) : page;
    },
    async searchListing(options) {
      const rows = await membershipRepository.search(options);
      return rows.map((m): MembershipListing => {
        const held = m.roleIds
          .flatMap((id) => roles.get(id) ?? [])
          .sort((a, b) => Number(b.isOwnerRole) - Number(a.isOwnerRole) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) || (a.id < b.id ? -1 : 1));
        return {
          id: m.id,
          organizationId: m.organizationId,
          identity: m.identity,
          roleCount: held.length,
          roles: held.slice(0, options.rolesPerMember).map(toRoleSummary),
        };
      });
    },
    async count(options) {
      return matchingMemberships(options).length;
    },
    async countByRole(roleIds) {
      return tally(roleIds, [...memberships.values()].flatMap((m) => m.roleIds));
    },
    async countByOrganization(organizationIds) {
      return tally(organizationIds, [...memberships.values()].map((m) => m.organizationId));
    },
    async assignRole(membershipId, roleId) {
      const membership = memberships.get(membershipId);
      if (!membership) throw new MembershipError(`Membership not found: ${membershipId}`);
      if (!membership.roleIds.includes(roleId)) membership.roleIds.push(roleId);
    },
    async unassignRole(membershipId, roleId) {
      const membership = memberships.get(membershipId);
      if (!membership) throw new MembershipError(`Membership not found: ${membershipId}`);
      if (!membership.roleIds.includes(roleId)) return; // idempotent no-op

      if (isLastOwnerRoleHolder(roleId, membershipId)) {
        throw new MembershipError(
          "Cannot remove the organization's last Owner — every organization must keep at least one.",
        );
      }

      const index = membership.roleIds.indexOf(roleId);
      membership.roleIds.splice(index, 1);
    },
    async delete(membershipId) {
      const membership = memberships.get(membershipId);
      if (!membership) throw new MembershipError(`Membership not found: ${membershipId}`);

      const wouldOrphanOrg = membership.roleIds.some((roleId) => isLastOwnerRoleHolder(roleId, membershipId));
      if (wouldOrphanOrg) {
        throw new MembershipError(
          "Cannot remove the organization's last Owner — every organization must keep at least one.",
        );
      }

      memberships.delete(membershipId);
    },
  };

  function roleNameTaken(organizationId: string, name: string, excludeRoleId?: string): boolean {
    return [...roles.values()].some(
      (r) => r.organizationId === organizationId && r.name === name && r.id !== excludeRoleId,
    );
  }

  function roleKeyTaken(organizationId: string, key: string): boolean {
    return [...roles.values()].some((r) => r.organizationId === organizationId && r.key === key);
  }

  function toRoleSummary(role: Role): RoleSummary {
    return { id: role.id, organizationId: role.organizationId, name: role.name, key: role.key, isOwnerRole: role.isOwnerRole };
  }

  function matchingRoles(options?: { organizationId?: string; query?: string; heldBy?: string; notHeldBy?: string; isOwnerRole?: boolean }): Role[] {
    const query = options?.query?.trim().toLowerCase();
    const heldBy = options?.heldBy !== undefined ? new Set(memberships.get(options.heldBy)?.roleIds ?? []) : undefined;
    const notHeldBy = options?.notHeldBy !== undefined ? new Set(memberships.get(options.notHeldBy)?.roleIds ?? []) : undefined;
    return [...roles.values()].filter(
      (role) =>
        (options?.organizationId === undefined || role.organizationId === options.organizationId) &&
        (heldBy === undefined || heldBy.has(role.id)) &&
        (notHeldBy === undefined || !notHeldBy.has(role.id)) &&
        (options?.isOwnerRole === undefined || role.isOwnerRole === options.isOwnerRole) &&
        (!query || role.name.toLowerCase().includes(query) || role.key.toLowerCase().includes(query)),
    );
  }

  const roleRepository: RoleRepository = {
    async create(input: CreateRoleInput) {
      const name = sanitizeRoleName(input.name);
      if (roleNameTaken(input.organizationId, name)) {
        throw new RoleError(`A role named "${name}" already exists in this organization.`);
      }
      const key = resolveRoleKey(name, input.key);
      if (roleKeyTaken(input.organizationId, key)) {
        throw new RoleError(
          input.key !== undefined
            ? `A role with key "${key}" already exists in this organization.`
            : `Could not derive a unique key from this role name — "${key}" is already taken in this organization. Pass an explicit \`key\`.`,
        );
      }
      const role: Role = {
        id: input.id,
        organizationId: input.organizationId,
        isOwnerRole: false,
        key,
        name,
        permissionKeys: sanitizeRolePermissionKeys(input.permissionKeys),
      };
      roles.set(role.id, role);
      return role;
    },
    async createOwnerRole(input: CreateOwnerRoleInput) {
      const alreadyHasOwner = [...roles.values()].some(
        (r) => r.organizationId === input.organizationId && r.isOwnerRole,
      );
      if (alreadyHasOwner) {
        throw new RoleError(`Organization "${input.organizationId}" already has an Owner role.`);
      }
      const role: Role = {
        id: input.id,
        organizationId: input.organizationId,
        isOwnerRole: true,
        key: "owner",
        name: "Owner",
        permissionKeys: [],
      };
      roles.set(role.id, role);
      return role;
    },
    async findByIds(ids) {
      return ids.map((id) => roles.get(id)).filter((role): role is Role => role !== undefined);
    },
    async listByOrganization(organizationId) {
      return [...roles.values()].filter((r) => r.organizationId === organizationId);
    },
    async findSummariesByIds(ids) {
      return ids.flatMap((id) => {
        const role = roles.get(id);
        return role ? [toRoleSummary(role)] : [];
      });
    },
    async search(options) {
      const matches = matchingRoles(options).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      const after = options.after;
      const page = after === undefined ? matches : matches.filter((role) => role.key > after);
      return (options.limit !== undefined ? page.slice(0, options.limit) : page).map(toRoleSummary);
    },
    async count(options) {
      return matchingRoles(options).length;
    },
    async countPermissions(roleIds) {
      return Object.fromEntries(roleIds.map((id) => [id, roles.get(id)?.permissionKeys.length ?? 0]));
    },
    async grantingRoles(membershipId, keys, perKey) {
      const held = (memberships.get(membershipId)?.roleIds ?? []).flatMap((id) => roles.get(id) ?? []);
      return Object.fromEntries(
        keys.map((key) => {
          const granting = held.filter((role) => role.permissionKeys.includes(key)).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
          return [key, { total: granting.length, roles: granting.slice(0, perKey).map(toRoleSummary) }];
        }),
      );
    },
    async grantedPermissionKeys(roleId, keys) {
      const granted = new Set(roles.get(roleId)?.permissionKeys ?? []);
      return keys.filter((key) => granted.has(key));
    },
    async countByOrganization(organizationIds) {
      return tally(organizationIds, [...roles.values()].map((r) => r.organizationId));
    },
    async grantPermission(roleId, permissionKey) {
      const role = roles.get(roleId);
      if (!role) throw new RoleError(`Role not found: ${roleId}`);
      if (role.isOwnerRole) throw new RoleError("Cannot modify permissions on the protected Owner role.");
      assertNonEmptyPermissionKey(permissionKey);
      if (!role.permissionKeys.includes(permissionKey)) role.permissionKeys.push(permissionKey);
    },
    async revokePermission(roleId, permissionKey) {
      const role = roles.get(roleId);
      if (!role) throw new RoleError(`Role not found: ${roleId}`);
      if (role.isOwnerRole) throw new RoleError("Cannot modify permissions on the protected Owner role.");
      const index = role.permissionKeys.indexOf(permissionKey);
      if (index !== -1) role.permissionKeys.splice(index, 1);
    },
    async rename(roleId, name) {
      const role = roles.get(roleId);
      if (!role) throw new RoleError(`Role not found: ${roleId}`);
      if (role.isOwnerRole) throw new RoleError("Cannot rename the protected Owner role.");
      const sanitized = sanitizeRoleName(name);
      if (roleNameTaken(role.organizationId, sanitized, roleId)) {
        throw new RoleError(`A role named "${sanitized}" already exists in this organization.`);
      }
      role.name = sanitized;
      return role;
    },
    async delete(roleId) {
      const role = roles.get(roleId);
      if (!role) throw new RoleError(`Role not found: ${roleId}`);
      if (role.isOwnerRole) throw new RoleError("Cannot delete the protected Owner role.");
      roles.delete(roleId);
      for (const membership of memberships.values()) {
        const index = membership.roleIds.indexOf(roleId);
        if (index !== -1) membership.roleIds.splice(index, 1);
      }
    },
  };

  /** Counts occurrences of each requested id (`0` for ids that never occur). */
  function tally(requestedIds: string[], occurrences: string[]): Record<string, number> {
    const counts: Record<string, number> = Object.fromEntries(requestedIds.map((id) => [id, 0]));
    for (const id of occurrences) if (id in counts) counts[id] = (counts[id] ?? 0) + 1;
    return counts;
  }

  function matchingPermissions(options?: { query?: string; grantedToRole?: string; grantedToMember?: string }): Permission[] {
    const query = options?.query?.trim().toLowerCase();
    const viaMember =
      options?.grantedToMember !== undefined
        ? new Set((memberships.get(options.grantedToMember)?.roleIds ?? []).flatMap((id) => roles.get(id)?.permissionKeys ?? []))
        : undefined;
    const granted =
      options?.grantedToRole !== undefined ? new Set(roles.get(options.grantedToRole)?.permissionKeys ?? []) : undefined;
    return [...permissions.values()].filter(
      (permission) =>
        (granted === undefined || granted.has(permission.key)) &&
        (viaMember === undefined || viaMember.has(permission.key)) &&
        (!query || permission.key.toLowerCase().includes(query) || (permission.name?.toLowerCase().includes(query) ?? false)),
    );
  }

  const permissionRepository: PermissionRepository = {
    async register(input: RegisterPermissionInput) {
      const key = assertValidPermissionKey(input.key);
      const name = input.name !== undefined ? sanitizePermissionName(input.name) : undefined;
      const permission: Permission = { key, name, description: input.description };
      permissions.set(permission.key, permission);
      return permission;
    },
    async findByKey(key) {
      return permissions.get(key) ?? null;
    },
    async list() {
      return [...permissions.values()];
    },
    async search(options) {
      const matches = matchingPermissions(options).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      const after = options?.after;
      const page = after === undefined ? matches : matches.filter((permission) => permission.key > after);
      return options?.limit !== undefined ? page.slice(0, options.limit) : page;
    },
    async count(options) {
      return matchingPermissions(options).length;
    },
    async countRoleGrants(keys) {
      const counts: Record<string, number> = Object.fromEntries(keys.map((key) => [key, 0]));
      for (const role of roles.values()) {
        for (const key of role.permissionKeys) {
          if (key in counts) counts[key] = (counts[key] ?? 0) + 1;
        }
      }
      return counts;
    },
    async unregister(key) {
      if (!permissions.has(key)) {
        throw new PermissionError(`Permission not found: ${key}`);
      }
      const stillGranted = [...roles.values()].some((r) => r.permissionKeys.includes(key));
      if (stillGranted) {
        throw new PermissionError(
          `Cannot unregister permission "${key}": it is still granted to at least one role. Revoke it everywhere first.`,
        );
      }
      permissions.delete(key);
    },
  };

  function assertFeatureRegistered(key: string): void {
    if (!featureDefinitions.has(key)) {
      throw new FeatureError(`Feature "${key}" is not registered. Call features.register() first.`);
    }
  }

  function matchingFeatures(options?: { query?: string; enabledIn?: string }): FeatureDefinition[] {
    const query = options?.query?.trim().toLowerCase();
    const enabledIn = options?.enabledIn;
    return [...featureDefinitions.values()].filter(
      (definition) =>
        (enabledIn === undefined || (features.get(`${enabledIn}:${definition.key}`)?.enabled ?? false)) &&
        (!query || definition.key.toLowerCase().includes(query) || definition.name.toLowerCase().includes(query)),
    );
  }

  const featureRepository: FeatureRepository = {
    async register(input: RegisterFeatureInput) {
      const name = sanitizeFeatureName(input.name);
      const key = resolveFeatureKey(name, input.key);
      const definition: FeatureDefinition = { key, name, description: input.description };
      featureDefinitions.set(key, definition);
      return definition;
    },
    async listCatalog() {
      return [...featureDefinitions.values()];
    },
    async search(options) {
      const matches = matchingFeatures(options).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      const after = options?.after;
      const page = after === undefined ? matches : matches.filter((definition) => definition.key > after);
      return options?.limit !== undefined ? page.slice(0, options.limit) : page;
    },
    async count(options) {
      return matchingFeatures(options).length;
    },
    async enabledKeys(organizationId, keys) {
      return keys.filter((key) => features.get(`${organizationId}:${key}`)?.enabled ?? false);
    },
    async countEnabledByOrganization(organizationIds) {
      return tally(
        organizationIds,
        [...features.values()].filter((f) => f.enabled).map((f) => f.organizationId),
      );
    },
    async summarizeUsage(keys, sampleSize) {
      const usage: Record<string, FeatureUsage> = Object.fromEntries(
        keys.map((key) => [key, { enabledCount: 0, sampleOrganizationIds: [] as string[] }]),
      );
      const enabled = [...features.values()].filter((f) => f.enabled && f.key in usage).sort((a, b) => (a.organizationId < b.organizationId ? -1 : 1));
      for (const feature of enabled) {
        const entry = usage[feature.key]!;
        entry.enabledCount += 1;
        if (entry.sampleOrganizationIds.length < sampleSize) entry.sampleOrganizationIds.push(feature.organizationId);
      }
      return usage;
    },
    async enable(organizationId, key) {
      assertFeatureRegistered(key);
      features.set(`${organizationId}:${key}`, { organizationId, key, enabled: true });
    },
    async disable(organizationId, key) {
      assertFeatureRegistered(key);
      features.set(`${organizationId}:${key}`, { organizationId, key, enabled: false });
    },
    async isEnabled(organizationId, key) {
      return features.get(`${organizationId}:${key}`)?.enabled ?? false;
    },
    async listByOrganization(organizationId) {
      return [...features.values()].filter((f) => f.organizationId === organizationId);
    },
    async unregister(key) {
      if (!featureDefinitions.has(key)) {
        throw new FeatureError(`Feature "${key}" is not registered.`);
      }
      const stillEnabled = [...features.values()].some((f) => f.key === key && f.enabled);
      if (stillEnabled) {
        throw new FeatureError(
          `Cannot unregister feature "${key}": it is still enabled for at least one organization. Disable it everywhere first.`,
        );
      }
      featureDefinitions.delete(key);
      for (const [mapKey, feature] of features) {
        if (feature.key === key) features.delete(mapKey);
      }
    },
  };

  // Append-only: this object exposes no method that removes or mutates an
  // existing entry, only `push` (via `record`) — enforcing at the API level
  // that nothing here can tamper with audit history (skill §26/§70).
  const auditLogRepository: AuditLogRepository = {
    async record(input: RecordAuditLogInput) {
      const entry: AuditLogEntry = {
        id: input.id,
        organizationId: input.organizationId,
        actor: input.actor,
        action: input.action,
        target: input.target,
        metadata: input.metadata,
        createdAt: new Date(),
      };
      auditLogs.push(entry);
      return entry;
    },
    async listByOrganization(organizationId: string, options?: ListAuditLogOptions) {
      // Same total order as `listRecent` — newest first, `id` desc breaking
      // ties — so a keyset `before` cursor pages this organization's log
      // with no gaps or repeats.
      const before = options?.before;
      const entries = auditLogs
        .filter((entry) => entry.organizationId === organizationId)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
        .filter(
          (entry) =>
            !before ||
            entry.createdAt.getTime() < before.createdAt.getTime() ||
            (entry.createdAt.getTime() === before.createdAt.getTime() && entry.id < before.id),
        );
      return options?.limit !== undefined ? entries.slice(0, options.limit) : entries;
    },
    async listRecent(options?: ListRecentAuditLogOptions) {
      const sorted = [...auditLogs].sort(
        (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
      );
      const before = options?.before;
      const afterCursor = before
        ? sorted.filter(
            (entry) =>
              entry.createdAt.getTime() < before.createdAt.getTime() ||
              (entry.createdAt.getTime() === before.createdAt.getTime() && entry.id < before.id),
          )
        : sorted;
      return options?.limit !== undefined ? afterCursor.slice(0, options.limit) : afterCursor;
    },
  };

  return {
    organizations: organizationRepository,
    memberships: membershipRepository,
    roles: roleRepository,
    permissions: permissionRepository,
    features: featureRepository,
    auditLogs: auditLogRepository,
    identityLinks: identityLinkRepository,
    async transaction<T>(callback: (tx: UnioraTransaction) => Promise<T>): Promise<T> {
      // In-memory storage has no isolation to offer; adapters with a real
      // database (e.g. Postgres) must run `callback` inside a DB transaction.
      return callback({
        organizations: organizationRepository,
        memberships: membershipRepository,
        roles: roleRepository,
        permissions: permissionRepository,
        features: featureRepository,
        auditLogs: auditLogRepository,
        identityLinks: identityLinkRepository,
      });
    },
  };
}
