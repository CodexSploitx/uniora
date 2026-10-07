import type { Identity } from "../identity/types.js";
import { sameIdentity } from "../identity/types.js";
import type { Organization } from "../organization/types.js";
import type { CreateOrganizationInput, OrganizationRepository } from "../organization/repository.js";
import { OrganizationError, resolveOrganizationSlug, sanitizeOrganizationName } from "../organization/slug.js";
import type { Membership, MembershipStatus } from "../membership/types.js";
import type { CreateMembershipInput, MembershipListing, MembershipRepository, SearchMembershipsOptions } from "../membership/repository.js";
import { MembershipError, sanitizeBlockReason } from "../membership/repository.js";
import type { Role } from "../role/types.js";
import type { CreateOwnerRoleInput, CreateRoleInput, RoleRepository, RoleSummary } from "../role/repository.js";
import { RoleError } from "../role/repository.js";
import { resolveRoleKey, sanitizeRolePermissionKeys, sanitizeRoleName, assertNonEmptyPermissionKey } from "../role/key.js";
import type { Permission } from "../permission/types.js";
import type { PermissionRepository, RegisterPermissionInput } from "../permission/repository.js";
import { PermissionError } from "../permission/repository.js";
import { assertValidPermissionKey, sanitizePermissionName } from "../permission/key.js";
import type { EffectiveFeature, Feature, FeatureChangeMeta, FeatureDefinition } from "../feature/types.js";
import type { FeatureRepository, FeatureUsage, RegisterFeatureInput } from "../feature/repository.js";
import { FeatureError, sanitizeFeatureChangeReason } from "../feature/repository.js";
import { assertValidFeatureParent, resolveEffectiveFeatures } from "../feature/effective.js";
import { resolveFeatureKey, sanitizeFeatureName } from "../feature/key.js";
import type { AuditLogEntry } from "../audit-log/types.js";
import type {
  AuditLogRepository,
  ListAuditLogOptions,
  ListRecentAuditLogOptions,
  RecordAuditLogInput,
  SearchAuditLogOptions,
} from "../audit-log/repository.js";
import { assertAuditInput } from "../audit-log/repository.js";
import type { IdentityLink } from "../identity-link/types.js";
import type { IdentityLinkRepository, LinkIdentityInput } from "../identity-link/repository.js";
import { IdentityLinkError } from "../identity-link/repository.js";
import type { Invitation } from "../invitation/types.js";
import type {
  CreateInvitationInput,
  InvitationRepository,
  RecordDeliveryInput,
  SearchInvitationsOptions,
} from "../invitation/repository.js";
import { InvitationError } from "../invitation/repository.js";
import { randomId } from "../invitation/token.js";
import { applyAnchor, computeAuditEntryHash, type ChainedAuditFields } from "../audit-log/chain.js";
import type { AuditIntegrityOptions, AuditIntegrityReport } from "../audit-log/types.js";
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
  // Hash chain, index-aligned with `auditLogs` (audit F-04).
  const auditChain: Array<{ prev: string | null; hash: string }> = [];
  let auditTail: Promise<void> = Promise.resolve();
  const chainFields = (entry: AuditLogEntry): ChainedAuditFields => ({
    id: entry.id,
    organizationId: entry.organizationId ?? null,
    actorProvider: entry.actor.provider,
    actorSubject: entry.actor.subject,
    action: entry.action,
    targetType: entry.target?.type ?? null,
    targetId: entry.target?.id ?? null,
    metadataJson: entry.metadata !== undefined ? JSON.stringify(entry.metadata) : null,
    createdAt: entry.createdAt.toISOString(),
  });
  const identityLinksByFromKey = new Map<string, IdentityLink>();
  const invitations = new Map<string, Invitation>();
  const invitationTokenHashes = new Map<string, string>(); // id -> token hash

  // Defined before `membershipRepository` because `findByIdentity` calls
  // `resolve()` directly. `auditLogRepository` is referenced from `link()`
  // below even though it's declared later in this function — safe, because
  // by the time any caller can actually invoke `link()`, `createMemoryStorage`
  // has already finished running and every `const` here is initialized.
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

      // Symmetric to the check above (docs/security-pentest-2026-09-24.md
      // Hallazgo 6 — "no chains" was only enforced in one direction): if
      // `from` is ALREADY the `to` of some other link, accepting it here
      // would silently build a 2-hop chain (`other -> from -> to`) through
      // sheer ordering, even though a direct attempt at that same chain (`to`
      // already a `from`) is correctly rejected above. `from` can only ever
      // become a link target for the "no own membership" reason already
      // checked, never because it's currently someone else's alias.
      const fromIsAliasTarget = [...identityLinksByFromKey.values()].some((existingLink) =>
        sameIdentity(existingLink.to, input.from),
      );
      if (fromIsAliasTarget) {
        throw new IdentityLinkError(
          "Cannot link: the 'from' identity is itself the target of another identity's link (no chains).",
        );
      }

      const link: IdentityLink = { from: input.from, to: input.to, linkedAt: new Date() };
      identityLinksByFromKey.set(identityKey(input.from), link);

      // Security fix (docs/security-pentest-2026-09-24.md Hallazgo 5):
      // `input.actor` exists specifically "for the mandatory audit
      // trail" (see the interface JSDoc) — this is the one Core primitive
      // that self-audits, because merging two identities' access is
      // dangerous enough to require a forensic trail regardless of whether
      // the host caller remembers to add one of its own. Global entry (no
      // `organizationId`): a link isn't scoped to any single organization.
      // Random id (audit F-11): a caller-chosen or guessable id could be pre-inserted into the audit
      // table to make this self-audit collide and block the link with a misleading error.
      await auditLogRepository.record({
        id: `identity-link:${randomId()}`,
        actor: input.actor,
        action: "identity_link.created",
        target: { type: "identity_link", id: `${input.from.provider}:${input.from.subject}` },
        metadata: { from: input.from, to: input.to },
      });

      return link;
    },
    async unlink(input: { from: Identity; actor: Identity }) {
      const existing = identityLinksByFromKey.get(identityKey(input.from));
      if (!existing) return false;
      identityLinksByFromKey.delete(identityKey(input.from));
      await auditLogRepository.record({
        id: `identity-link:${randomId()}`,
        actor: input.actor,
        action: "identity_link.removed",
        target: { type: "identity_link", id: `${input.from.provider}:${input.from.subject}` },
        metadata: { from: existing.from, to: existing.to },
      });
      return true;
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
    async rename(id, name) {
      const existing = organizations.get(id);
      if (!existing) return null;
      const updated: Organization = { ...existing, name: sanitizeOrganizationName(name) };
      organizations.set(id, updated);
      return updated;
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

  function touch(membership: Membership): void {
    Object.assign(membership, { updatedAt: new Date() });
  }

  function matchingMemberships(options?: { organizationId?: string; query?: string; identity?: Identity; status?: MembershipStatus }): Membership[] {
    const query = options?.query?.trim().toLowerCase();
    return [...memberships.values()].filter(
      (m) =>
        (options?.organizationId === undefined || m.organizationId === options.organizationId) &&
        (options?.identity === undefined || sameIdentity(m.identity, options.identity)) &&
        (options?.status === undefined || m.status === options.status) &&
        (!query || m.identity.subject.toLowerCase().includes(query) || m.identity.provider.toLowerCase().includes(query)),
    );
  }

  const membershipRepository: MembershipRepository = {
    async create(input: CreateMembershipInput) {
      // SECURITY FIX (docs/security-pentest-2026-09-24.md Ronda 6, hallazgo
      // de adapter differential encontrado por fuzzing dirigido):
      // `@uniora/postgres` rechaza esto vía `unique(organization_id,
      // provider, subject)` (migration 0001), pero `createMemoryStorage`
      // no tenía la comprobación equivalente — permitía crear DOS
      // memberships distintos para la MISMA identidad en la MISMA
      // organización. `findByIdentity` siempre resuelve al PRIMERO
      // insertado (orden de iteración de `Map`), así que el segundo queda
      // inalcanzable por la ruta normal de autorización — pero SÍ es
      // visible para `countByRole`/`assignOwnerRole`. Combinado, esto
      // rompía el invariante de "toda organización tiene ≥1 Owner
      // ALCANZABLE": asignar el Owner role también al duplicado infla el
      // conteo que `unassignOwnerRole` usa para decidir "¿queda otro
      // Owner?", permitiendo quitarle el Owner role al membership real
      // (alcanzable) mientras el duplicado (inalcanzable) lo conserva —
      // la organización queda, en la práctica, sin ningún Owner operativo
      // aunque el conteo diga 1. Ver `docs/core.md` para el detalle.
      const identityTaken = [...memberships.values()].some(
        (m) => m.organizationId === input.organizationId && sameIdentity(m.identity, input.identity),
      );
      if (identityTaken) {
        throw new MembershipError(
          `Identity ${input.identity.provider}:${input.identity.subject} already has a membership in organization "${input.organizationId}".`,
        );
      }
      // SECURITY FIX (docs/security-pentest-2026-09-24.md Ronda 7 —
      // boundary collapse): `IdentityLinkRepository.link()` refuses to link
      // a `from` identity that already owns a membership directly, in ANY
      // organization, precisely "to avoid an ambiguous/hijackable lookup"
      // (its own error message). That invariant was enforced ONLY inside
      // `link()` — nothing stopped the SAME ambiguous state from being
      // built in the opposite order: link() first (from has no membership
      // yet, so it's accepted), then a direct `create()` here for that same
      // `from` identity. Once both exist, `findByIdentity` has two
      // conflicting sources of truth for one identity in one organization
      // (this membership, and the linked-to identity's membership) — Memory
      // and Postgres resolved that ambiguity DIFFERENTLY (Memory always
      // favored the link, silently ignoring this row entirely — including
      // any explicit grant made to it; Postgres favored this row instead,
      // silently making the link dead), and the ambiguous state was also
      // reachable via a genuine race between `link()` and `create()`, not
      // only by sequential misordering. Rejecting it here — the same check
      // `link()` already performs, just from the other side — closes both
      // the ordering and the adapter-divergence issue at the source.
      if (identityLinksByFromKey.has(identityKey(input.identity))) {
        throw new MembershipError(
          `Cannot create a direct membership for identity ${input.identity.provider}:${input.identity.subject}: it is already linked as an alias of another identity (see IdentityLinkRepository.link) — creating a direct membership here would produce an ambiguous/hijackable lookup.`,
        );
      }
      const roleIds = [...(input.roleIds ?? [])];
      // Same organization-match guard as `assignRole` below — an initial
      // `roleIds` at creation time is just as capable of smuggling a
      // cross-organization role reference as a later `assignRole` call
      // (docs/security-pentest-2026-09-24.md Hallazgo 2, found by
      // repository-wide review after fixing `assignRole`).
      for (const roleId of roleIds) {
        const role = roles.get(roleId);
        if (!role) throw new MembershipError(`Role not found: ${roleId}`);
        if (role.organizationId !== input.organizationId) {
          throw new MembershipError(
            `Cannot assign role "${roleId}" to membership "${input.id}": the role belongs to a different organization than "${input.organizationId}".`,
          );
        }
      }
      const createdAt = input.createdAt ?? new Date();
      const membership: Membership = {
        id: input.id,
        organizationId: input.organizationId,
        identity: input.identity,
        roleIds,
        status: "active",
        createdAt,
        updatedAt: createdAt,
        ...(input.invitedBy ? { invitedBy: { ...input.invitedBy } } : {}),
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
          status: m.status,
          createdAt: m.createdAt,
          ...(m.invitedBy ? { invitedBy: m.invitedBy } : {}),
          ...(m.lastActiveAt ? { lastActiveAt: m.lastActiveAt } : {}),
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
      // Reject assigning a role that belongs to a DIFFERENT organization than
      // the membership (uniora-security-engineering §17/§20 — an
      // organization-scoped relationship must not be creatable across
      // tenants). Harmless today only because `AuthorizationEngine.can()`
      // separately re-checks `role.organizationId` at evaluation time; this
      // closes the gap at the source instead of relying solely on that
      // defense-in-depth layer (docs/security-pentest-2026-09-24.md Hallazgo 2).
      const role = roles.get(roleId);
      if (!role) throw new MembershipError(`Role not found: ${roleId}`);
      if (role.organizationId !== membership.organizationId) {
        throw new MembershipError(
          `Cannot assign role "${roleId}" to membership "${membershipId}": the role belongs to a different organization than the membership.`,
        );
      }
      // Security fix (docs/security-pentest-2026-09-24.md Hallazgo 7): the
      // Owner role must never be grantable through the same generic path as
      // any other role — see `assignOwnerRole` and the interface JSDoc.
      if (role.isOwnerRole) {
        throw new MembershipError(
          `Cannot assign the protected Owner role "${roleId}" via assignRole() — use assignOwnerRole() instead.`,
        );
      }
      if (!membership.roleIds.includes(roleId)) {
        membership.roleIds.push(roleId);
        touch(membership);
      }
    },
    async assignOwnerRole(membershipId, roleId) {
      const membership = memberships.get(membershipId);
      if (!membership) throw new MembershipError(`Membership not found: ${membershipId}`);
      const role = roles.get(roleId);
      if (!role) throw new MembershipError(`Role not found: ${roleId}`);
      if (role.organizationId !== membership.organizationId) {
        throw new MembershipError(
          `Cannot assign role "${roleId}" to membership "${membershipId}": the role belongs to a different organization than the membership.`,
        );
      }
      if (!role.isOwnerRole) {
        throw new MembershipError(`Role "${roleId}" is not the protected Owner role — use assignRole() instead.`);
      }
      if (!membership.roleIds.includes(roleId)) {
        membership.roleIds.push(roleId);
        touch(membership);
      }
    },
    async unassignRole(membershipId, roleId) {
      const membership = memberships.get(membershipId);
      if (!membership) throw new MembershipError(`Membership not found: ${membershipId}`);

      // Security fix (docs/security-pentest-2026-09-24.md Hallazgo 7): role
      // type checked BEFORE the idempotency short-circuit — an Owner role
      // that isn't currently assigned to this membership must still be
      // reported as "wrong method", never silently treated as a no-op (that
      // would defeat the point of the split for a caller who relies on this
      // rejecting). An unknown/deleted `roleId` obviously isn't the Owner
      // role, so it correctly falls through to the plain idempotent path.
      if (roles.get(roleId)?.isOwnerRole) {
        throw new MembershipError(
          `Cannot unassign the protected Owner role "${roleId}" via unassignRole() — use unassignOwnerRole() instead.`,
        );
      }

      if (!membership.roleIds.includes(roleId)) return; // idempotent no-op

      const index = membership.roleIds.indexOf(roleId);
      membership.roleIds.splice(index, 1);
      touch(membership);
    },
    async unassignOwnerRole(membershipId, roleId) {
      const membership = memberships.get(membershipId);
      if (!membership) throw new MembershipError(`Membership not found: ${membershipId}`);

      const role = roles.get(roleId);
      if (role && !role.isOwnerRole) {
        throw new MembershipError(`Role "${roleId}" is not the protected Owner role — use unassignRole() instead.`);
      }

      if (!membership.roleIds.includes(roleId)) return; // idempotent no-op (also covers an unknown roleId)

      if (isLastOwnerRoleHolder(roleId, membershipId)) {
        throw new MembershipError(
          "Cannot remove the organization's last Owner — every organization must keep at least one.",
        );
      }

      const index = membership.roleIds.indexOf(roleId);
      membership.roleIds.splice(index, 1);
      touch(membership);
    },
    async block(membershipId, input) {
      const membership = memberships.get(membershipId);
      if (!membership) throw new MembershipError(`Membership not found: ${membershipId}`);
      if (membership.status === "blocked") return membership;
      // The Owner who is blocked must not be the only ACTIVE one left: the organization would have nobody who can act.
      const ownerRoleIds = membership.roleIds.filter((roleId) => roles.get(roleId)?.isOwnerRole);
      for (const roleId of ownerRoleIds) {
        const otherActiveOwner = [...memberships.values()].some(
          (other) => other.id !== membershipId && other.status === "active" && other.roleIds.includes(roleId),
        );
        if (!otherActiveOwner) {
          throw new MembershipError("Cannot block the organization's last active Owner — every organization must keep at least one.", "last_owner");
        }
      }
      const at = new Date();
      Object.assign(membership, {
        status: "blocked" as const,
        updatedAt: at,
        blocked: { at, by: { ...input.actor }, ...(sanitizeBlockReason(input.reason) !== undefined ? { reason: sanitizeBlockReason(input.reason) } : {}) },
      });
      return membership;
    },
    async unblock(membershipId, _input) {
      const membership = memberships.get(membershipId);
      if (!membership) throw new MembershipError(`Membership not found: ${membershipId}`);
      if (membership.status === "active") return membership;
      const { blocked: _blocked, ...rest } = membership;
      memberships.set(membershipId, { ...rest, status: "active", updatedAt: new Date() });
      return memberships.get(membershipId)!;
    },
    async recordActivity(membershipId, at = new Date()) {
      const membership = memberships.get(membershipId);
      if (!membership) return;
      if (!membership.lastActiveAt || membership.lastActiveAt < at) Object.assign(membership, { lastActiveAt: at });
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
      throw new FeatureError(`Feature "${key}" is not registered. Call features.register() first.`, "feature_unknown");
    }
  }

  function overridesOf(organizationId: string): Feature[] {
    return [...features.values()].filter((f) => f.organizationId === organizationId);
  }

  function effectiveFor(organizationId: string): EffectiveFeature[] {
    return resolveEffectiveFeatures([...featureDefinitions.values()], overridesOf(organizationId));
  }

  function writeOverride(organizationId: string, key: string, enabled: boolean, meta?: FeatureChangeMeta): void {
    features.set(`${organizationId}:${key}`, {
      organizationId,
      key,
      enabled,
      updatedAt: new Date(),
      ...(meta?.actor ? { updatedBy: { ...meta.actor } } : {}),
      ...(sanitizeFeatureChangeReason(meta?.reason) !== undefined ? { reason: sanitizeFeatureChangeReason(meta?.reason) } : {}),
    });
  }

  function matchingFeatures(options?: { query?: string; enabledIn?: string }): FeatureDefinition[] {
    const query = options?.query?.trim().toLowerCase();
    const enabledIn = options?.enabledIn;
    const effectiveKeys = enabledIn === undefined ? undefined : new Set(effectiveFor(enabledIn).filter((f) => f.enabled).map((f) => f.key));
    return [...featureDefinitions.values()].filter(
      (definition) =>
        (effectiveKeys === undefined || effectiveKeys.has(definition.key)) &&
        (!query || definition.key.toLowerCase().includes(query) || definition.name.toLowerCase().includes(query)),
    );
  }

  /** Organizations where `key` is effectively on, ordered by id — the in-memory twin of the SQL used by the adapters. */
  function organizationsWithEffective(key: string): string[] {
    // Organizations that exist, plus any that only have an override (the in-memory backend doesn't enforce the FK).
    const known = new Set([...organizations.keys(), ...[...features.values()].map((f) => f.organizationId)]);
    return [...known]
      .filter((organizationId) => effectiveFor(organizationId).some((f) => f.key === key && f.enabled))
      .sort();
  }

  const featureRepository: FeatureRepository = {
    async register(input: RegisterFeatureInput) {
      const name = sanitizeFeatureName(input.name);
      const key = resolveFeatureKey(name, input.key);
      assertValidFeatureParent(featureDefinitions, key, input.parentKey);
      const definition: FeatureDefinition = {
        key,
        name,
        description: input.description,
        defaultEnabled: input.defaultEnabled === true,
        ...(input.parentKey !== undefined ? { parentKey: input.parentKey } : {}),
      };
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
      const on = new Set(effectiveFor(organizationId).filter((f) => f.enabled).map((f) => f.key));
      return keys.filter((key) => on.has(key));
    },
    async countEnabledByOrganization(organizationIds) {
      return Object.fromEntries(
        organizationIds.map((organizationId) => [organizationId, effectiveFor(organizationId).filter((f) => f.enabled).length]),
      );
    },
    async summarizeUsage(keys, sampleSize) {
      const usage: Record<string, FeatureUsage> = {};
      for (const key of keys) {
        const enabledIn = featureDefinitions.has(key) ? organizationsWithEffective(key) : [];
        usage[key] = { enabledCount: enabledIn.length, sampleOrganizationIds: enabledIn.slice(0, Math.max(0, sampleSize)) };
      }
      return usage;
    },
    async enable(organizationId, key, meta) {
      assertFeatureRegistered(key);
      writeOverride(organizationId, key, true, meta);
    },
    async disable(organizationId, key, meta) {
      assertFeatureRegistered(key);
      writeOverride(organizationId, key, false, meta);
    },
    async setMany(organizationId, changes, meta) {
      const entries = Object.entries(changes);
      for (const [key] of entries) assertFeatureRegistered(key);
      for (const [key, enabled] of entries) writeOverride(organizationId, key, enabled, meta);
    },
    async disableEverywhere(key, meta) {
      assertFeatureRegistered(key);
      const definition = featureDefinitions.get(key)!;
      let disabledOverrides = 0;
      for (const feature of [...features.values()]) {
        if (feature.key !== key || !feature.enabled) continue;
        writeOverride(feature.organizationId, key, false, meta);
        disabledOverrides += 1;
      }
      featureDefinitions.set(key, { ...definition, defaultEnabled: false });
      return { disabledOverrides, defaultWasEnabled: definition.defaultEnabled };
    },
    async isEnabled(organizationId, key) {
      return effectiveFor(organizationId).some((f) => f.key === key && f.enabled);
    },
    async listEffective(organizationId, options) {
      const all = effectiveFor(organizationId).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      return options?.keys ? all.filter((f) => options.keys!.includes(f.key)) : all;
    },
    async listByOrganization(organizationId) {
      return overridesOf(organizationId);
    },
    async unregister(key) {
      if (!featureDefinitions.has(key)) {
        throw new FeatureError(`Feature "${key}" is not registered.`, "feature_unknown");
      }
      if ([...featureDefinitions.values()].some((definition) => definition.parentKey === key)) {
        throw new FeatureError(
          `Cannot unregister feature "${key}": other features depend on it. Unregister or detach them first.`,
          "feature_has_children",
        );
      }
      if (organizationsWithEffective(key).length > 0) {
        throw new FeatureError(
          `Cannot unregister feature "${key}": it is still enabled for at least one organization. Disable it everywhere first.`,
          "feature_in_use",
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
  async function verifyChain(): Promise<AuditIntegrityReport> {
    let prev: string | null = null;
    for (let index = 0; index < auditLogs.length; index++) {
      const entry = auditLogs[index]!;
      const link = auditChain[index]!;
      if (link.prev !== prev) return { ok: false, checked: index, broken: { id: entry.id, reason: "chain_broken" } };
      if (link.hash !== (await computeAuditEntryHash(prev, chainFields(entry)))) {
        return { ok: false, checked: index, broken: { id: entry.id, reason: "content_mismatch" } };
      }
      prev = link.hash;
    }
    return {
      ok: true,
      checked: auditLogs.length,
      head: prev === null ? undefined : { position: auditLogs.length, hash: prev },
    };
  }

  const auditLogRepository: AuditLogRepository = {
    async record(input: RecordAuditLogInput) {
      assertAuditInput(input);
      // Serialized: each entry's hash needs the previous one, so two concurrent records can't overlap.
      const run = auditTail.then(async () => {
        const entry: AuditLogEntry = {
          id: input.id,
          organizationId: input.organizationId,
          actor: input.actor,
          action: input.action,
          target: input.target,
          metadata: input.metadata,
          createdAt: new Date(),
        };
        const prev = auditChain.length > 0 ? auditChain[auditChain.length - 1]!.hash : null;
        const hash = await computeAuditEntryHash(prev, chainFields(entry));
        auditLogs.push(entry);
        auditChain.push({ prev, hash });
        return entry;
      });
      auditTail = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
    async verifyIntegrity(options?: AuditIntegrityOptions): Promise<AuditIntegrityReport> {
      const report = await verifyChain();
      return applyAnchor(report, options?.anchor, async (position) => auditChain[position - 1]?.hash ?? null);
    },
    async search(options?: SearchAuditLogOptions) {
      const actions = options?.action === undefined ? undefined : new Set(Array.isArray(options.action) ? options.action : [options.action]);
      const before = options?.before;
      const entries = auditLogs
        .filter(
          (entry) =>
            (options?.organizationId === undefined || entry.organizationId === options.organizationId) &&
            (actions === undefined || actions.has(entry.action)) &&
            (options?.actionPrefix === undefined || entry.action.startsWith(options.actionPrefix)) &&
            (options?.actor === undefined || sameIdentity(entry.actor, options.actor)) &&
            (options?.target === undefined ||
              (entry.target?.type === options.target.type && (options.target.id === undefined || entry.target.id === options.target.id))) &&
            (options?.since === undefined || entry.createdAt.getTime() >= options.since.getTime()) &&
            (options?.until === undefined || entry.createdAt.getTime() < options.until.getTime()) &&
            (!before ||
              entry.createdAt.getTime() < before.createdAt.getTime() ||
              (entry.createdAt.getTime() === before.createdAt.getTime() && entry.id < before.id)),
        )
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
      return options?.limit !== undefined ? entries.slice(0, options.limit) : entries;
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

  const clone = (invitation: Invitation): Invitation => ({
    ...invitation,
    roleIds: [...invitation.roleIds],
    delivery: { ...invitation.delivery },
  });

  const invitationRepository: InvitationRepository = {
    async create(input: CreateInvitationInput) {
      const duplicate = [...invitations.values()].some(
        (i) => i.organizationId === input.organizationId && i.email === input.email && i.status === "pending",
      );
      if (duplicate) {
        throw new InvitationError("This e-mail already has a pending invitation to this organization.", "duplicate_pending");
      }
      if (!organizations.has(input.organizationId)) {
        throw new InvitationError("The organization does not exist.", "bad_request");
      }
      const invitation: Invitation = {
        id: input.id,
        organizationId: input.organizationId,
        email: input.email,
        roleIds: [...input.roleIds],
        invitedBy: input.invitedBy,
        status: "pending",
        createdAt: input.createdAt,
        expiresAt: input.expiresAt,
        delivery: { status: "pending", attempts: 0, sends: 0 },
      };
      invitations.set(invitation.id, invitation);
      invitationTokenHashes.set(invitation.id, input.tokenHash);
      return clone(invitation);
    },
    async findById(id: string) {
      const found = invitations.get(id);
      return found ? clone(found) : null;
    },
    async findByTokenHash(tokenHash: string) {
      for (const [id, hash] of invitationTokenHashes) {
        if (hash === tokenHash) return clone(invitations.get(id)!);
      }
      return null;
    },
    async search(organizationId: string, options?: SearchInvitationsOptions) {
      const matches = [...invitations.values()]
        .filter((i) => i.organizationId === organizationId && (!options?.status || i.status === options.status))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
      let page = matches;
      if (options?.after !== undefined) {
        const index = matches.findIndex((i) => i.id === options.after);
        page = index === -1 ? [] : matches.slice(index + 1);
      }
      return (options?.limit !== undefined ? page.slice(0, options.limit) : page).map(clone);
    },
    async expireStale(organizationId: string, email: string, now: Date) {
      let count = 0;
      for (const i of invitations.values()) {
        if (i.organizationId === organizationId && i.email === email && i.status === "pending" && i.expiresAt.getTime() <= now.getTime()) {
          i.status = "expired";
          count += 1;
        }
      }
      return count;
    },
    async rotateToken(id: string, input: { tokenHash: string; expiresAt: Date }) {
      const i = invitations.get(id);
      if (!i || i.status !== "pending") return null;
      invitationTokenHashes.set(id, input.tokenHash);
      i.expiresAt = input.expiresAt;
      i.delivery = { ...i.delivery, status: "pending", lastError: undefined };
      return clone(i);
    },
    async revoke(id: string, now: Date) {
      const i = invitations.get(id);
      if (!i || i.status !== "pending") return null;
      i.status = "revoked";
      i.revokedAt = now;
      return clone(i);
    },
    async markAccepted(input: { tokenHash: string; identity: Identity; now: Date }) {
      for (const [id, hash] of invitationTokenHashes) {
        if (hash !== input.tokenHash) continue;
        const i = invitations.get(id)!;
        if (i.status !== "pending" || i.expiresAt.getTime() <= input.now.getTime()) return null;
        i.status = "accepted";
        i.acceptedAt = input.now;
        i.acceptedBy = input.identity;
        return clone(i);
      }
      return null;
    },
    async recordDelivery(id: string, input: RecordDeliveryInput) {
      const i = invitations.get(id);
      if (!i) return;
      i.delivery = {
        status: input.status,
        attempts: i.delivery.attempts + input.attempts,
        sends: i.delivery.sends + 1,
        lastAttemptAt: input.at,
        sentAt: input.status === "sent" ? input.at : i.delivery.sentAt,
        lastError: input.status === "failed" ? input.error : undefined,
      };
    },
    async countCreatedSince(filter: { organizationId?: string; email?: string; since: Date }) {
      return [...invitations.values()].filter(
        (i) =>
          i.createdAt.getTime() >= filter.since.getTime() &&
          (filter.organizationId === undefined || i.organizationId === filter.organizationId) &&
          (filter.email === undefined || i.email === filter.email),
      ).length;
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
    invitations: invitationRepository,
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
        invitations: invitationRepository,
      });
    },
  };
}
