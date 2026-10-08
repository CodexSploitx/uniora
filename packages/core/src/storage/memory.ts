import { assertExpectedVersion } from "../shared/version.js";
import type { Identity } from "../identity/types.js";
import { sameIdentity } from "../identity/types.js";
import type { Organization, OrganizationStatus } from "../organization/types.js";
import { assertOrganizationStatus, sanitizeStatusReason } from "../organization/status.js";
import type { CreateOrganizationInput, OrganizationRepository } from "../organization/repository.js";
import { OrganizationError, assertValidSlug, resolveOrganizationSlug, sanitizeOrganizationName } from "../organization/slug.js";
import type { Membership, MembershipStatus } from "../membership/types.js";
import type { BlockMembershipInput, CreateMembershipInput, MembershipListing, MembershipRepository, SearchMembershipsOptions } from "../membership/repository.js";
import { MembershipError, assertBlockUntil, sanitizeBlockReason } from "../membership/repository.js";
import type { Role } from "../role/types.js";
import type { CreateOwnerRoleInput, CreateRoleInput, RoleRepository, RoleSummary } from "../role/repository.js";
import { RoleError } from "../role/repository.js";
import { normalizeRoleName, resolveRoleKey, sanitizeRoleDescription, sanitizeRolePermissionKeys, sanitizeRoleName, assertNonEmptyPermissionKey } from "../role/key.js";
import type { Permission } from "../permission/types.js";
import type { PermissionRepository, RegisterPermissionInput } from "../permission/repository.js";
import { PermissionError } from "../permission/repository.js";
import { assertValidPermissionKey, sanitizePermissionName } from "../permission/key.js";
import {
  assertValidImplications,
  expandClosure,
  implicationGraph,
  impliedByClosure,
  sanitizeImplies,
  sanitizePermissionGroup,
} from "../permission/implications.js";
import type { EffectiveFeature, Feature, FeatureChangeMeta, FeatureDefinition } from "../feature/types.js";
import type { FeatureRepository, FeatureToggleOptions, FeatureUsage, RegisterFeatureInput } from "../feature/repository.js";
import { FeatureError, assertEffectiveManyInput, sanitizeFeatureChangeReason } from "../feature/repository.js";
import { assertValidFeatureParent, resolveEffectiveFeatures } from "../feature/effective.js";
import { resolveFeatureKey, sanitizeFeatureName } from "../feature/key.js";
import type { AuditLogEntry } from "../audit-log/types.js";
import type {
  AuditLogRepository,
  ListAuditLogOptions,
  ListRecentAuditLogOptions,
  PruneAuditLogInput,
  PruneAuditLogResult,
  RecordAuditLogInput,
  SearchAuditLogOptions,
} from "../audit-log/repository.js";
import { assertAuditInput, assertPruneCutoff } from "../audit-log/repository.js";
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
import type { OutboxEvent, OutboxStatus } from "../outbox/types.js";
import type { OutboxRepository } from "../outbox/repository.js";
import { OutboxError, assertValidOutboxEvent, resolveClaimOptions } from "../outbox/repository.js";
import type { ConsumeResult, EntitlementDefinition, EntitlementStatus } from "../entitlement/types.js";
import type { EntitlementRepository } from "../entitlement/repository.js";
import {
  EntitlementError,
  assertValidEntitlementAmount,
  assertValidEntitlementKey,
  assertValidEntitlementLimit,
  assertValidEntitlementPeriod,
  buildEntitlementStatus,
  entitlementWindow,
  sanitizeEntitlementName,
  toConsumeResult,
} from "../entitlement/repository.js";
import type { SupportGrant } from "../support-grant/types.js";
import type { SearchSupportGrantsOptions, SupportGrantRepository } from "../support-grant/repository.js";
import { SupportGrantError, assertValidSupportGrant, grantStatus } from "../support-grant/repository.js";
import type { Team, TeamMembership } from "../team/types.js";
import type { SearchTeamMembersOptions, SearchTeamsOptions, TeamMembershipRepository, TeamRepository } from "../team/repository.js";
import {
  MAX_TEAM_DEPTH,
  TeamError,
  assertTeamPlacement,
  assertTeamMemberStatus,
  assertTeamResponsibility,
  assertValidAddTeamMember,
  assertValidCreateTeam,
  assertValidUpdateTeam,
  isTeamMemberTransitionAllowed,
  sameTeamData,
  sanitizeTeamReason,
} from "../team/repository.js";
import { assertTeamAuthorization } from "../team/authorization.js";
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
function matchesInvitationFilter(
  invitation: Invitation,
  organizationId: string,
  options?: Pick<SearchInvitationsOptions, "status" | "query">,
): boolean {
  if (invitation.organizationId !== organizationId) return false;
  if (options?.status && invitation.status !== options.status) return false;
  const query = options?.query?.trim().toLowerCase();
  return !query || invitation.email.toLowerCase().includes(query);
}

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
  // Retention checkpoint: how many entries `pruneBefore` removed from the front, and the hash of the last one.
  // Positions stay stable (position = auditPruned + index + 1) and the chain is verified from this hash.
  let auditPruned = 0;
  let auditCheckpointHash: string | null = null;
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
  const invitationIdempotency = new Map<string, { key: string; hash: string }>();
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

  /**
   * Every record leaves the store as a copy (and enters as one): a caller that holds a role,
   * membership or organization read earlier must not see it change when a later write
   * touches the stored one — that is how the SQL adapters behave, and what `version` and
   * `expectedVersion` rely on.
   */
  const copy = <T>(value: T): T => structuredClone(value);

  const statusSet = (status: OrganizationStatus | OrganizationStatus[] | undefined): Set<OrganizationStatus> | undefined =>
    status === undefined ? undefined : new Set((Array.isArray(status) ? status : [status]).map(assertOrganizationStatus));

  /** Predicate for `search({ feature })`: effective state of that feature in an organization (unknown key: off). */
  const featureFilter = (feature: { key: string; enabled?: boolean } | undefined): ((organizationId: string) => boolean) => {
    if (!feature) return () => true;
    const wantOn = feature.enabled ?? true;
    return (organizationId) => effectiveFor(organizationId).some((f) => f.key === feature.key && f.enabled) === wantOn;
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

      const organization: Organization = { id: input.id, slug, name, createdAt: new Date(), status: "active", version: 1 };
      organizations.set(organization.id, organization);
      return copy(organization);
    },
    async findById(id) {
      const found = organizations.get(id);
      return found ? copy(found) : null;
    },
    async rename(id, name) {
      const existing = organizations.get(id);
      if (!existing) return null;
      const sanitized = sanitizeOrganizationName(name);
      if (sanitized === existing.name) return copy(existing);
      const updated: Organization = { ...existing, name: sanitized, version: existing.version + 1 };
      organizations.set(id, updated);
      return copy(updated);
    },
    async update(id, input) {
      const existing = organizations.get(id);
      if (input.name === undefined && input.slug === undefined) {
        throw new OrganizationError("Pass a name and/or a slug to update.", "organization_update_empty");
      }
      const name = input.name === undefined ? undefined : sanitizeOrganizationName(input.name);
      const slug = input.slug === undefined ? undefined : assertValidSlug(input.slug);
      const expectedVersion = assertExpectedVersion(input.expectedVersion);
      if (!existing) return null;
      if (expectedVersion !== undefined && existing.version !== expectedVersion) {
        throw new OrganizationError("The organization changed since it was read.", "organization_version_conflict");
      }
      if (slug !== undefined && [...organizations.values()].some((o) => o.id !== id && o.slug === slug)) {
        throw new OrganizationError(`An organization with slug "${slug}" already exists.`, "organization_slug_taken");
      }
      const updated: Organization = {
        ...existing,
        ...(name !== undefined ? { name } : {}),
        ...(slug !== undefined ? { slug } : {}),
        version: existing.version + 1,
      };
      if (updated.name === existing.name && updated.slug === existing.slug) return copy(existing);
      organizations.set(id, updated);
      return copy(updated);
    },
    async setStatus(id, input) {
      const status = assertOrganizationStatus(input.status);
      const reason = sanitizeStatusReason(input.reason);
      assertAuditInput({ actor: input.actor, action: "organization.status_changed" });
      const existing = organizations.get(id);
      if (!existing) return null;
      if (existing.status === status) return copy(existing);
      const updated: Organization = {
        ...existing,
        status,
        statusChange: { at: new Date(), by: input.actor, ...(reason !== undefined ? { reason } : {}) },
        version: existing.version + 1,
      };
      organizations.set(id, updated);
      return copy(updated);
    },
    async findByIds(ids) {
      return ids.flatMap((id) => organizations.get(id) ?? []).map(copy);
    },
    async list() {
      return [...organizations.values()].map(copy);
    },
    async search(options) {
      const query = options?.query?.trim().toLowerCase();
      const statuses = statusSet(options?.status);
      const hasFeature = featureFilter(options?.feature);
      const matches = [...organizations.values()].filter(
        (organization) =>
          (!statuses || statuses.has(organization.status)) &&
          hasFeature(organization.id) &&
          (!query || organization.name.toLowerCase().includes(query) || organization.slug.toLowerCase().includes(query)),
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
      return (options?.limit !== undefined ? page.slice(0, options.limit) : page).map(copy);
    },
    async count(options) {
      const query = options?.query?.trim().toLowerCase();
      const statuses = statusSet(options?.status);
      const hasFeature = featureFilter(options?.feature);
      const total = [...organizations.values()].filter(
        (organization) =>
          (!statuses || statuses.has(organization.status)) &&
          hasFeature(organization.id) &&
          (!query || organization.name.toLowerCase().includes(query) || organization.slug.toLowerCase().includes(query)),
      ).length;
      return options?.limit === undefined ? total : Math.min(total, options.limit);
    },
  };

  // The organization's Owner-role invariant (skill §11): a `roleId` is
  // "the last Owner holder" of `excludeMembershipId` when that role is the
  // protected Owner role AND no other membership currently has it.
  // Assigning the Owner role to several memberships is allowed — only
  // dropping the very last holder is blocked, and the last ACTIVE one while others are blocked or suspended.
  function isLastOwnerRoleHolder(roleId: string, excludeMembershipId: string): boolean {
    const role = roles.get(roleId);
    if (!role?.isOwnerRole) return false;
    lapseBlocks();
    const others = [...memberships.values()].filter((m) => m.id !== excludeMembershipId && m.roleIds.includes(roleId));
    if (others.length === 0) return true;
    // An Owner who can still act can't be removed when every other holder is blocked or suspended.
    return memberships.get(excludeMembershipId)?.status === "active" && !others.some((m) => m.status === "active");
  }

  function touch(membership: Membership): void {
    Object.assign(membership, { updatedAt: new Date(), version: membership.version + 1 });
  }

  function assertMembershipVersion(membership: Membership, expectedVersion: number | undefined): void {
    const expected = assertExpectedVersion(expectedVersion);
    if (expected !== undefined && membership.version !== expected) {
      throw new MembershipError("The membership changed since it was read.", "membership_version_conflict");
    }
  }

  /** A timed suspension that has ended reads as active again: lifted lazily, before any read of memberships. */
  function lapseBlocks(): void {
    const now = Date.now();
    for (const [id, membership] of memberships) {
      const until = membership.blocked?.until;
      if (membership.status === "suspended" && until !== undefined && until.getTime() <= now) {
        const { blocked: _blocked, ...rest } = membership;
        memberships.set(id, { ...rest, status: "active", updatedAt: new Date() });
      }
    }
  }

  /** `block` and `suspend` are one write: a suspension is a block that has an end date. */
  function blockWithin(membershipId: string, input: BlockMembershipInput, until: Date | undefined): Membership {
    lapseBlocks();
    const membership = memberships.get(membershipId);
    if (!membership) throw new MembershipError(`Membership not found: ${membershipId}`);
    assertMembershipVersion(membership, input.expectedVersion);
    if (membership.status === "suspended" && until === undefined) {
      // `block` over a timed suspension makes it indefinite; the member was already inactive, so no Owner guard applies.
      const at = new Date();
      Object.assign(membership, {
        status: "blocked" as const,
        updatedAt: at,
        version: membership.version + 1,
        blocked: { at, by: { ...input.actor }, ...(sanitizeBlockReason(input.reason) !== undefined ? { reason: sanitizeBlockReason(input.reason) } : {}) },
      });
      return copy(membership);
    }
    if (membership.status !== "active") return copy(membership);
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
      status: until ? ("suspended" as const) : ("blocked" as const),
      updatedAt: at,
      version: membership.version + 1,
      blocked: { at, by: { ...input.actor }, ...(sanitizeBlockReason(input.reason) !== undefined ? { reason: sanitizeBlockReason(input.reason) } : {}), ...(until ? { until } : {}) },
    });
    return copy(membership);
  }

  function matchingMemberships(options?: { organizationId?: string; query?: string; identity?: Identity; status?: MembershipStatus; limit?: number }): Membership[] {
    lapseBlocks();
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
        identity: { ...input.identity },
        roleIds,
        status: "active",
        createdAt,
        updatedAt: createdAt,
        version: 1,
        ...(input.invitedBy ? { invitedBy: { ...input.invitedBy } } : {}),
      };
      memberships.set(membership.id, membership);
      return copy(membership);
    },
    async findByIdentity(organizationId: string, identity: Identity) {
      const resolved = await identityLinkRepository.resolve(identity);
      lapseBlocks();
      for (const membership of memberships.values()) {
        if (membership.organizationId === organizationId && sameIdentity(membership.identity, resolved)) {
          return copy(membership);
        }
      }
      return null;
    },
    async listByOrganization(organizationId) {
      lapseBlocks();
      return [...memberships.values()].filter((m) => m.organizationId === organizationId).map(copy);
    },
    async findById(id) {
      lapseBlocks();
      const found = memberships.get(id);
      return found ? copy(found) : null;
    },
    async search(options) {
      const matches = matchingMemberships(options).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const after = options?.after;
      const page = after === undefined ? matches : matches.filter((m) => m.id > after);
      return (options?.limit !== undefined ? page.slice(0, options.limit) : page).map(copy);
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
          identity: { ...m.identity },
          roleCount: held.length,
          status: m.status,
          createdAt: m.createdAt,
          ...(m.invitedBy ? { invitedBy: { ...m.invitedBy } } : {}),
          ...(m.lastActiveAt ? { lastActiveAt: m.lastActiveAt } : {}),
          roles: held.slice(0, options.rolesPerMember).map(toRoleSummary),
        };
      });
    },
    async count(options) {
      const total = matchingMemberships(options).length;
      return options?.limit === undefined ? total : Math.min(total, options.limit);
    },
    async countByRole(roleIds) {
      return tally(roleIds, [...memberships.values()].flatMap((m) => m.roleIds));
    },
    async countByOrganization(organizationIds, options) {
      return capped(tally(organizationIds, [...memberships.values()].map((m) => m.organizationId)), options?.limit);
    },
    async assignRole(membershipId, roleId, options) {
      const membership = memberships.get(membershipId);
      if (!membership) throw new MembershipError(`Membership not found: ${membershipId}`);
      assertMembershipVersion(membership, options?.expectedVersion);
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
    async unassignRole(membershipId, roleId, options) {
      const membership = memberships.get(membershipId);
      if (!membership) throw new MembershipError(`Membership not found: ${membershipId}`);
      assertMembershipVersion(membership, options?.expectedVersion);

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
      return blockWithin(membershipId, input, undefined);
    },
    async suspend(membershipId, input) {
      const until = assertBlockUntil(input.until);
      if (until === undefined) throw new MembershipError("A suspension needs an end date (`until`).", "membership_block_until_invalid");
      return blockWithin(membershipId, input, until);
    },
    async unblock(membershipId, input) {
      const membership = memberships.get(membershipId);
      if (!membership) throw new MembershipError(`Membership not found: ${membershipId}`);
      assertMembershipVersion(membership, input.expectedVersion);
      if (membership.status === "active") return copy(membership);
      const { blocked: _blocked, ...rest } = membership;
      memberships.set(membershipId, { ...rest, status: "active", updatedAt: new Date(), version: membership.version + 1 });
      return copy(memberships.get(membershipId)!);
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
      for (const row of [...teamMemberships.values()]) if (row.membershipId === membershipId) teamMemberships.delete(row.id);
    },
  };

  function roleNameTaken(organizationId: string, name: string, excludeRoleId?: string): boolean {
    return [...roles.values()].some(
      (r) => r.organizationId === organizationId && normalizeRoleName(r.name) === normalizeRoleName(name) && r.id !== excludeRoleId,
    );
  }

  function roleKeyTaken(organizationId: string, key: string): boolean {
    return [...roles.values()].some((r) => r.organizationId === organizationId && r.key === key);
  }

  function toRoleSummary(role: Role): RoleSummary {
    return { id: role.id, organizationId: role.organizationId, name: role.name, key: role.key, isOwnerRole: role.isOwnerRole, isSystem: role.isSystem };
  }

  function matchingRoles(options?: { organizationId?: string; query?: string; heldBy?: string; notHeldBy?: string; isOwnerRole?: boolean; isSystem?: boolean }): Role[] {
    const query = options?.query?.trim().toLowerCase();
    const heldBy = options?.heldBy !== undefined ? new Set(memberships.get(options.heldBy)?.roleIds ?? []) : undefined;
    const notHeldBy = options?.notHeldBy !== undefined ? new Set(memberships.get(options.notHeldBy)?.roleIds ?? []) : undefined;
    return [...roles.values()].filter(
      (role) =>
        (options?.organizationId === undefined || role.organizationId === options.organizationId) &&
        (heldBy === undefined || heldBy.has(role.id)) &&
        (notHeldBy === undefined || !notHeldBy.has(role.id)) &&
        (options?.isOwnerRole === undefined || role.isOwnerRole === options.isOwnerRole) &&
        (options?.isSystem === undefined || role.isSystem === options.isSystem) &&
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
      const description = sanitizeRoleDescription(input.description);
      const role: Role = {
        id: input.id,
        organizationId: input.organizationId,
        isOwnerRole: false,
        isSystem: input.isSystem === true,
        key,
        name,
        ...(description !== undefined ? { description } : {}),
        permissionKeys: sanitizeRolePermissionKeys(input.permissionKeys),
        version: 1,
      };
      roles.set(role.id, role);
      return copy(role);
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
        isSystem: false,
        key: "owner",
        name: "Owner",
        permissionKeys: [],
        version: 1,
      };
      roles.set(role.id, role);
      return copy(role);
    },
    async findByIds(ids) {
      return ids.map((id) => roles.get(id)).filter((role): role is Role => role !== undefined).map(copy);
    },
    async listByOrganization(organizationId) {
      return [...roles.values()].filter((r) => r.organizationId === organizationId).map(copy);
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
    async countByOrganization(organizationIds, options) {
      return capped(tally(organizationIds, [...roles.values()].map((r) => r.organizationId)), options?.limit);
    },
    async grantPermission(roleId, permissionKey) {
      const role = roles.get(roleId);
      if (!role) throw new RoleError(`Role not found: ${roleId}`);
      if (role.isOwnerRole) throw new RoleError("Cannot modify permissions on the protected Owner role.");
      assertNonEmptyPermissionKey(permissionKey);
      if (!role.permissionKeys.includes(permissionKey)) {
        role.permissionKeys.push(permissionKey);
        role.version += 1;
      }
    },
    async revokePermission(roleId, permissionKey) {
      const role = roles.get(roleId);
      if (!role) throw new RoleError(`Role not found: ${roleId}`);
      if (role.isOwnerRole) throw new RoleError("Cannot modify permissions on the protected Owner role.");
      const index = role.permissionKeys.indexOf(permissionKey);
      if (index !== -1) {
        role.permissionKeys.splice(index, 1);
        role.version += 1;
      }
    },
    async rename(roleId, name) {
      const role = roles.get(roleId);
      if (!role) throw new RoleError(`Role not found: ${roleId}`);
      if (role.isOwnerRole) throw new RoleError("Cannot rename the protected Owner role.");
      if (role.isSystem) throw new RoleError("Cannot rename a system role.", "role_system_protected");
      const sanitized = sanitizeRoleName(name);
      if (roleNameTaken(role.organizationId, sanitized, roleId)) {
        throw new RoleError(`A role named "${sanitized}" already exists in this organization.`);
      }
      if (role.name !== sanitized) {
        role.name = sanitized;
        role.version += 1;
      }
      return copy(role);
    },
    async update(roleId, input) {
      if (input.name === undefined && input.description === undefined) {
        throw new RoleError("Pass a name and/or a description to update.", "role_update_empty");
      }
      const role = roles.get(roleId);
      const name = input.name === undefined ? undefined : sanitizeRoleName(input.name);
      const description = input.description === undefined ? undefined : sanitizeRoleDescription(input.description);
      const expectedVersion = assertExpectedVersion(input.expectedVersion);
      if (!role) throw new RoleError(`Role not found: ${roleId}`);
      if (expectedVersion !== undefined && role.version !== expectedVersion) {
        throw new RoleError("The role changed since it was read.", "role_version_conflict");
      }
      let changed = false;
      if (name !== undefined) {
        if (role.isOwnerRole) throw new RoleError("Cannot rename the protected Owner role.");
        if (role.isSystem) throw new RoleError("Cannot rename a system role.", "role_system_protected");
        if (roleNameTaken(role.organizationId, name, roleId)) {
          throw new RoleError(`A role named "${name}" already exists in this organization.`);
        }
        if (role.name !== name) changed = true;
        role.name = name;
      }
      if (input.description !== undefined) {
        if (role.isOwnerRole && name === undefined) throw new RoleError("Cannot modify the protected Owner role.");
        if (role.description !== description) changed = true;
        if (description === undefined) delete role.description;
        else role.description = description;
      }
      // A call that changes nothing does not count (see `Role.version`).
      if (changed) role.version += 1;
      return copy(role);
    },
    async setPermissions(roleId, permissionKeys, options) {
      const role = roles.get(roleId);
      const expectedVersion = assertExpectedVersion(options?.expectedVersion);
      if (!role) throw new RoleError(`Role not found: ${roleId}`);
      if (role.isOwnerRole) throw new RoleError("Cannot modify permissions on the protected Owner role.");
      if (expectedVersion !== undefined && role.version !== expectedVersion) {
        throw new RoleError("The role changed since it was read.", "role_version_conflict");
      }
      const wanted = sanitizeRolePermissionKeys(permissionKeys);
      const unknown = wanted.filter((key) => !permissions.has(key));
      if (unknown.length > 0) {
        throw new RoleError(`Permission(s) not registered: ${unknown.join(", ")}.`, "role_permission_invalid");
      }
      const had = new Set(role.permissionKeys);
      const granted = wanted.filter((key) => !had.has(key));
      const revoked = role.permissionKeys.filter((key) => !wanted.includes(key));
      role.permissionKeys = wanted;
      if (granted.length > 0 || revoked.length > 0) role.version += 1;
      return { granted, revoked };
    },
    async clone(roleId, input) {
      const source = roles.get(roleId);
      if (!source) throw new RoleError(`Role not found: ${roleId}`);
      if (source.isOwnerRole) {
        throw new RoleError("The protected Owner role cannot be cloned: its power is a flag, not a list.", "owner_role_protected");
      }
      return roleRepository.create({
        id: input.id,
        organizationId: input.organizationId ?? source.organizationId,
        name: input.name,
        ...(input.key !== undefined ? { key: input.key } : {}),
        permissionKeys: [...source.permissionKeys],
        ...(input.description !== undefined || source.description !== undefined
          ? { description: input.description ?? source.description! }
          : {}),
      });
    },
    async delete(roleId, options) {
      const role = roles.get(roleId);
      if (!role) throw new RoleError(`Role not found: ${roleId}`);
      if (role.isOwnerRole) throw new RoleError("Cannot delete the protected Owner role.");
      if (role.isSystem) throw new RoleError("Cannot delete a system role.", "role_system_protected");
      const policy = options?.members ?? "detach";
      const holders = [...memberships.values()].filter((membership) => membership.roleIds.includes(roleId));
      const teamHolders = [...teamMemberships.values()].filter((row) => row.roleIds.includes(roleId));
      if (policy === "reject" && holders.length + teamHolders.length > 0) {
        throw new RoleError(`The role is still held by ${holders.length + teamHolders.length} membership(s).`, "role_in_use");
      }
      if (typeof policy === "object") {
        const target = roles.get(policy.reassignTo);
        if (!target || target.organizationId !== role.organizationId || target.isOwnerRole || target.id === roleId) {
          throw new RoleError(
            "reassignTo must be another role of the same organization and not the Owner role.",
            "role_reassign_invalid",
          );
        }
        for (const membership of holders) if (!membership.roleIds.includes(target.id)) membership.roleIds.push(target.id);
      }
      roles.delete(roleId);
      for (const membership of memberships.values()) {
        const index = membership.roleIds.indexOf(roleId);
        if (index !== -1) membership.roleIds.splice(index, 1);
      }
      for (const row of teamMemberships.values()) {
        if (row.roleIds.includes(roleId)) row.roleIds = row.roleIds.filter((candidate) => candidate !== roleId);
      }
    },
  };

  /** Counts occurrences of each requested id (`0` for ids that never occur). */
  /** Caps every count at `limit` (when given): the in-memory twin of a `limit` inside a database count. */
function capped(counts: Record<string, number>, limit: number | undefined): Record<string, number> {
  if (limit === undefined) return counts;
  return Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, Math.min(value, limit)]));
}

function tally(requestedIds: string[], occurrences: string[]): Record<string, number> {
    const counts: Record<string, number> = Object.fromEntries(requestedIds.map((id) => [id, 0]));
    for (const id of occurrences) if (id in counts) counts[id] = (counts[id] ?? 0) + 1;
    return counts;
  }

  function matchingPermissions(options?: { query?: string; group?: string; grantedToRole?: string; grantedToMember?: string }): Permission[] {
    const query = options?.query?.trim().toLowerCase();
    const viaMember =
      options?.grantedToMember !== undefined
        ? new Set((memberships.get(options.grantedToMember)?.roleIds ?? []).flatMap((id) => roles.get(id)?.permissionKeys ?? []))
        : undefined;
    const granted =
      options?.grantedToRole !== undefined ? new Set(roles.get(options.grantedToRole)?.permissionKeys ?? []) : undefined;
    return [...permissions.values()].filter(
      (permission) =>
        (options?.group === undefined || permission.group === options.group) &&
        (granted === undefined || granted.has(permission.key)) &&
        (viaMember === undefined || viaMember.has(permission.key)) &&
        (!query || permission.key.toLowerCase().includes(query) || (permission.name?.toLowerCase().includes(query) ?? false)),
    );
  }

  const permissionRepository: PermissionRepository = {
    async register(input: RegisterPermissionInput) {
      const key = assertValidPermissionKey(input.key);
      const name = input.name !== undefined ? sanitizePermissionName(input.name) : undefined;
      const group = sanitizePermissionGroup(input.group);
      const implies = sanitizeImplies(input.implies);
      assertValidImplications(implicationGraph(permissions.values()), key, implies);
      const permission: Permission = {
        key,
        name,
        description: input.description,
        ...(group !== undefined ? { group } : {}),
        ...(implies.length > 0 ? { implies } : {}),
      };
      permissions.set(permission.key, permission);
      return copy(permission);
    },
    async findByKey(key) {
      const found = permissions.get(key);
      return found ? copy(found) : null;
    },
    async list() {
      return [...permissions.values()].map(copy);
    },
    async search(options) {
      const matches = matchingPermissions(options).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      const after = options?.after;
      const page = after === undefined ? matches : matches.filter((permission) => permission.key > after);
      return (options?.limit !== undefined ? page.slice(0, options.limit) : page).map(copy);
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
    async impliedBy(key) {
      return impliedByClosure(implicationGraph(permissions.values()), key);
    },
    async expand(keys) {
      return expandClosure(implicationGraph(permissions.values()), keys);
    },
    async unregister(key) {
      if (!permissions.has(key)) {
        throw new PermissionError(`Permission not found: ${key}`);
      }
      if ([...permissions.values()].some((permission) => permission.implies?.includes(key))) {
        throw new PermissionError(
          `Cannot unregister permission "${key}": another permission still implies it. Change that one first.`,
          "permission_has_dependents",
        );
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

  function writeOverride(organizationId: string, key: string, enabled: boolean, meta?: FeatureToggleOptions): void {
    const previous = features.get(`${organizationId}:${key}`);
    const expectedVersion = assertExpectedVersion(meta?.expectedVersion, 0);
    if (expectedVersion !== undefined && (previous?.version ?? 0) !== expectedVersion) {
      throw new FeatureError("The feature override changed since it was read.", "feature_version_conflict");
    }
    features.set(`${organizationId}:${key}`, {
      organizationId,
      key,
      enabled,
      version: (previous?.version ?? 0) + 1,
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
      return copy(definition);
    },
    async listCatalog() {
      return [...featureDefinitions.values()].map(copy);
    },
    async search(options) {
      const matches = matchingFeatures(options).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      const after = options?.after;
      const page = after === undefined ? matches : matches.filter((definition) => definition.key > after);
      return (options?.limit !== undefined ? page.slice(0, options.limit) : page).map(copy);
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
      return (options?.keys ? all.filter((f) => options.keys!.includes(f.key)) : all).map(copy);
    },
    async listEffectiveMany(organizationIds, options) {
      assertEffectiveManyInput(organizationIds);
      return Object.fromEntries(
        [...new Set(organizationIds)].map((organizationId) => {
          const all = effectiveFor(organizationId).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
          return [organizationId, (options?.keys ? all.filter((f) => options.keys!.includes(f.key)) : all).map(copy)];
        }),
      );
    },
    async listByOrganization(organizationId) {
      return overridesOf(organizationId).map(copy);
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
    let prev: string | null = auditCheckpointHash;
    const pruned =
      auditPruned > 0 && auditCheckpointHash !== null
        ? { pruned: { through: { position: auditPruned, hash: auditCheckpointHash }, removed: auditPruned } }
        : {};
    for (let index = 0; index < auditLogs.length; index++) {
      const entry = auditLogs[index]!;
      const link = auditChain[index]!;
      if (link.prev !== prev) return { ok: false, checked: index, broken: { id: entry.id, reason: "chain_broken" }, ...pruned };
      if (link.hash !== (await computeAuditEntryHash(prev, chainFields(entry)))) {
        return { ok: false, checked: index, broken: { id: entry.id, reason: "content_mismatch" }, ...pruned };
      }
      prev = link.hash;
    }
    return {
      ok: true,
      checked: auditLogs.length,
      head: prev === null ? undefined : { position: auditPruned + auditLogs.length, hash: prev },
      ...pruned,
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
      return applyAnchor(report, options?.anchor, async (position) => auditChain[position - auditPruned - 1]?.hash ?? null);
    },
    async pruneBefore(input: PruneAuditLogInput): Promise<PruneAuditLogResult> {
      const before = assertPruneCutoff(input.before);
      assertAuditInput({ actor: input.actor, action: "audit_log.pruned" });
      // Serialized with `record`: the removal and the entry that reports it form one step of the chain.
      const run = auditTail.then(async () => {
        // A contiguous prefix of entries older than the cut-off; the newest entry always stays (chain continuity).
        let count = 0;
        while (count < auditLogs.length - 1 && auditLogs[count]!.createdAt.getTime() < before.getTime()) count++;
        if (count === 0) return { removed: 0 };
        const through = { position: auditPruned + count, hash: auditChain[count - 1]!.hash };
        auditLogs.splice(0, count);
        auditChain.splice(0, count);
        auditPruned += count;
        auditCheckpointHash = through.hash;
        const entry: AuditLogEntry = {
          id: `audit-pruned:${randomId()}`,
          actor: input.actor,
          action: "audit_log.pruned",
          metadata: { before: before.toISOString(), removed: count, throughPosition: through.position },
          createdAt: new Date(),
        };
        const prev = auditChain[auditChain.length - 1]!.hash;
        auditLogs.push(entry);
        auditChain.push({ prev, hash: await computeAuditEntryHash(prev, chainFields(entry)) });
        return { removed: count, through };
      });
      auditTail = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
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
    // An offer for a team that was deleted since disappears with it, like the foreign key's cascade in the databases.
    teamIds: invitation.teamIds.filter((id) => teams.get(id)?.organizationId === invitation.organizationId),
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
      for (const teamId of input.teamIds ?? []) {
        if (teams.get(teamId)?.organizationId !== input.organizationId) {
          throw new InvitationError("The organization, a chosen role or a chosen team does not exist.", "bad_request");
        }
      }
      const invitation: Invitation = {
        id: input.id,
        organizationId: input.organizationId,
        email: input.email,
        roleIds: [...input.roleIds],
        teamIds: [...new Set(input.teamIds ?? [])],
        invitedBy: input.invitedBy,
        status: "pending",
        createdAt: input.createdAt,
        expiresAt: input.expiresAt,
        delivery: { status: "pending", attempts: 0, sends: 0 },
      };
      if (input.idempotency) {
        const taken = [...invitations.values()].some(
          (i) => i.organizationId === input.organizationId && invitationIdempotency.get(i.id)?.key === input.idempotency!.key,
        );
        if (taken) throw new InvitationError("This idempotency key was already used.", "idempotency_conflict");
        invitationIdempotency.set(invitation.id, input.idempotency);
      }
      invitations.set(invitation.id, invitation);
      invitationTokenHashes.set(invitation.id, input.tokenHash);
      return clone(invitation);
    },
    async findByIdempotencyKey(organizationId: string, key: string) {
      for (const invitation of invitations.values()) {
        const stored = invitationIdempotency.get(invitation.id);
        if (invitation.organizationId === organizationId && stored?.key === key) {
          return { invitation: clone(invitation), hash: stored.hash };
        }
      }
      return null;
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
    async count(organizationId: string, options?: Pick<SearchInvitationsOptions, "status" | "query"> & { limit?: number }) {
      const total = [...invitations.values()].filter((i) => matchesInvitationFilter(i, organizationId, options)).length;
      return options?.limit === undefined ? total : Math.min(total, options.limit);
    },
    async search(organizationId: string, options?: SearchInvitationsOptions) {
      const matches = [...invitations.values()]
        .filter((i) => matchesInvitationFilter(i, organizationId, options))
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

  const entitlementDefinitions = new Map<string, EntitlementDefinition>();
  const entitlementLimits = new Map<string, number | null>(); // `${organizationId}\u0000${key}`
  const entitlementUsage = new Map<string, number>(); // `${organizationId}\u0000${key}\u0000${windowStartMs}`
  const entitlementId = (organizationId: string, key: string) => `${organizationId}\u0000${key}`;
  const entitlementDefinition = (key: string): EntitlementDefinition => {
    const definition = entitlementDefinitions.get(key);
    if (!definition) throw new EntitlementError(`Entitlement "${key}" is not defined.`, "entitlement_unknown");
    return definition;
  };
  const entitlementOrganization = (organizationId: string) => {
    if (!organizations.has(organizationId)) throw new EntitlementError(`Organization "${organizationId}" does not exist.`, "entitlement_organization_unknown");
  };
  const entitlementStatus = (organizationId: string, key: string, now: Date): EntitlementStatus => {
    const definition = entitlementDefinition(key);
    const id = entitlementId(organizationId, key);
    const overridden = entitlementLimits.has(id);
    const window = entitlementWindow(definition.period, now);
    return buildEntitlementStatus({
      organizationId,
      definition,
      override: overridden ? { limit: entitlementLimits.get(id)! ?? null } : undefined,
      used: entitlementUsage.get(`${id}\u0000${window.start.getTime()}`) ?? 0,
      now,
    });
  };
  const entitlementRepository: EntitlementRepository = {
    async define(input) {
      const key = assertValidEntitlementKey(input.key);
      const definition: EntitlementDefinition = {
        key,
        name: sanitizeEntitlementName(input.name, key),
        description: input.description?.trim() || undefined,
        period: input.period === undefined ? "lifetime" : assertValidEntitlementPeriod(input.period),
        defaultLimit: input.defaultLimit === undefined ? null : assertValidEntitlementLimit(input.defaultLimit),
      };
      entitlementDefinitions.set(key, definition);
      return { ...definition };
    },
    async findDefinition(key) {
      const definition = entitlementDefinitions.get(key);
      return definition ? { ...definition } : null;
    },
    async listDefinitions() {
      return [...entitlementDefinitions.values()].sort((a, b) => a.key.localeCompare(b.key)).map((definition) => ({ ...definition }));
    },
    async undefine(key) {
      entitlementDefinition(key);
      entitlementDefinitions.delete(key);
      for (const map of [entitlementLimits, entitlementUsage]) {
        for (const id of [...map.keys()]) if (id.split("\u0000")[1] === key) map.delete(id);
      }
    },
    async setLimit(organizationId, key, limit) {
      entitlementDefinition(key);
      entitlementOrganization(organizationId);
      entitlementLimits.set(entitlementId(organizationId, key), assertValidEntitlementLimit(limit));
      return entitlementStatus(organizationId, key, new Date());
    },
    async clearLimit(organizationId, key) {
      entitlementDefinition(key);
      entitlementOrganization(organizationId);
      entitlementLimits.delete(entitlementId(organizationId, key));
      return entitlementStatus(organizationId, key, new Date());
    },
    async get(organizationId, key, options) {
      entitlementOrganization(organizationId);
      return entitlementStatus(organizationId, key, options?.now ?? new Date());
    },
    async list(organizationId, options) {
      entitlementOrganization(organizationId);
      const now = options?.now ?? new Date();
      return [...entitlementDefinitions.keys()].sort().map((key) => entitlementStatus(organizationId, key, now));
    },
    async consume(organizationId, key, amount = 1, options) {
      assertValidEntitlementAmount(amount);
      entitlementOrganization(organizationId);
      const now = options?.now ?? new Date();
      const before = entitlementStatus(organizationId, key, now);
      if (before.limit !== null && before.used + amount > before.limit) return toConsumeResult(before, false);
      const slot = `${entitlementId(organizationId, key)}\u0000${before.windowStart!.getTime()}`;
      entitlementUsage.set(slot, before.used + amount);
      return toConsumeResult(entitlementStatus(organizationId, key, now), true);
    },
    async release(organizationId, key, amount = 1, options) {
      assertValidEntitlementAmount(amount);
      entitlementOrganization(organizationId);
      const now = options?.now ?? new Date();
      const before = entitlementStatus(organizationId, key, now);
      entitlementUsage.set(`${entitlementId(organizationId, key)}\u0000${before.windowStart!.getTime()}`, Math.max(before.used - amount, 0));
      return toConsumeResult(entitlementStatus(organizationId, key, now), true);
    },
  };

  const supportGrants = new Map<string, SupportGrant>();
  const cloneGrant = (grant: SupportGrant): SupportGrant => ({ ...grant, permissions: [...grant.permissions] });
  const grantMatches = (grant: SupportGrant, filter: Omit<SearchSupportGrantsOptions, "limit" | "after">, now: Date) =>
    (filter.organizationId === undefined || grant.organizationId === filter.organizationId) &&
    (filter.operator === undefined || sameIdentity(grant.operator, filter.operator)) &&
    (filter.status === undefined || grantStatus(grant, now) === filter.status);
  const supportGrantRepository: SupportGrantRepository = {
    async create(input) {
      const { reason, permissions: keys, now } = assertValidSupportGrant(input);
      if (!organizations.has(input.organizationId)) {
        throw new SupportGrantError(`Organization "${input.organizationId}" does not exist.`, "support_grant_organization_unknown");
      }
      if (keys.some((key) => !permissions.has(key))) {
        throw new SupportGrantError("Every permission of a grant must be registered.", "support_grant_permission_invalid");
      }
      if (supportGrants.has(input.id)) throw new SupportGrantError(`A grant with id "${input.id}" already exists.`, "support_grant_exists");
      const grant: SupportGrant = {
        id: input.id,
        organizationId: input.organizationId,
        operator: { ...input.operator },
        grantedBy: { ...input.grantedBy },
        reason,
        permissions: keys,
        createdAt: now,
        expiresAt: new Date(input.expiresAt),
      };
      supportGrants.set(grant.id, grant);
      return cloneGrant(grant);
    },
    async revoke(id, input) {
      const grant = supportGrants.get(id);
      if (!grant) return null;
      if (!grant.revokedAt) supportGrants.set(id, { ...grant, revokedAt: input.now ?? new Date(), revokedBy: { ...input.by } });
      return cloneGrant(supportGrants.get(id)!);
    },
    async findById(id) {
      const grant = supportGrants.get(id);
      return grant ? cloneGrant(grant) : null;
    },
    async search(options = {}) {
      const now = options.now ?? new Date();
      const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
      return [...supportGrants.values()]
        .filter((grant) => grantMatches(grant, options, now) && (options.after === undefined || grant.id > options.after))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .slice(0, limit)
        .map(cloneGrant);
    },
    async count(options = {}) {
      const now = options.now ?? new Date();
      return [...supportGrants.values()].filter((grant) => grantMatches(grant, options, now)).length;
    },
    async activePermissions(organizationId, identities, now = new Date()) {
      const keys = new Set<string>();
      for (const grant of supportGrants.values()) {
        if (grant.organizationId !== organizationId || grantStatus(grant, now) !== "active") continue;
        if (!identities.some((identity) => sameIdentity(identity, grant.operator))) continue;
        for (const key of grant.permissions) keys.add(key);
      }
      return [...keys].sort();
    },
  };

  const teams = new Map<string, Team>();
  const teamMemberships = new Map<string, TeamMembership>();
  const cloneTeam = (team: Team): Team => structuredClone(team);
  const cloneTeamMembership = (row: TeamMembership): TeamMembership => structuredClone(row);
  const teamOf = (organizationId: string, id: string): Team | undefined => {
    const team = teams.get(id);
    return team && team.organizationId === organizationId ? team : undefined;
  };
  const requireTeam = (organizationId: string, id: string): Team => {
    const team = teamOf(organizationId, id);
    if (!team) throw new TeamError(`Team not found: ${id}`, "team_not_found");
    return team;
  };
  const assertTeamVersion = (row: { version: number }, expectedVersion: number | undefined, code: "team_version_conflict" | "team_membership_version_conflict") => {
    const expected = assertExpectedVersion(expectedVersion);
    if (expected !== undefined && expected !== row.version) {
      throw new TeamError(`The ${code === "team_version_conflict" ? "team" : "team membership"} changed (version ${row.version}, expected ${expected}).`, code);
    }
  };
  const teamPage = <T extends { id: string }>(rows: T[], options: { limit?: number; after?: string }): T[] => {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    return rows
      .filter((row) => options.after === undefined || row.id > options.after)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, limit);
  };
  const teamMatches = (team: Team, filter: Omit<SearchTeamsOptions, "limit" | "after">): boolean => {
    if (team.organizationId !== filter.organizationId) return false;
    if (filter.status !== undefined && team.status !== filter.status) return false;
    if (filter.externalId !== undefined && team.externalId !== filter.externalId) return false;
    if (filter.parentId !== undefined && (team.parentId ?? null) !== filter.parentId) return false;
    const query = filter.query?.trim().toLowerCase();
    return !query || team.name.toLowerCase().includes(query) || team.slug.includes(query);
  };
  const childrenOf = (organizationId: string, id: string): Team[] =>
    [...teams.values()].filter((team) => team.organizationId === organizationId && team.parentId === id);
  const ancestorsOf = (organizationId: string, id: string): Team[] => {
    const chain: Team[] = [];
    let current = teamOf(organizationId, id);
    while (current?.parentId !== undefined && chain.length <= MAX_TEAM_DEPTH * 4) {
      current = teamOf(organizationId, current.parentId);
      if (current) chain.unshift(current);
    }
    return chain;
  };
  const descendantsOf = (organizationId: string, id: string): Team[] => {
    const found: Team[] = [];
    const queue = childrenOf(organizationId, id);
    while (queue.length > 0 && found.length <= teams.size) {
      const next = queue.shift()!;
      found.push(next);
      queue.push(...childrenOf(organizationId, next.id));
    }
    return found;
  };
  const heightOf = (organizationId: string, id: string): number => {
    const walk = (team: string, depth: number): number =>
      childrenOf(organizationId, team).reduce((max, child) => (depth > MAX_TEAM_DEPTH * 4 ? max : Math.max(max, walk(child.id, depth + 1))), depth);
    return walk(id, 0);
  };
  /** The same facts a SQL backend reads with recursive queries, so every backend rejects exactly the same placements. */
  const checkPlacement = (organizationId: string, selfId: string | null, parentId: string): void => {
    const parent = teamOf(organizationId, parentId);
    const above = parent ? ancestorsOf(organizationId, parentId) : [];
    assertTeamPlacement({
      selfId,
      parentId,
      parent: parent ? { status: parent.status, depth: above.length + 1 } : null,
      loop: selfId !== null && (parentId === selfId || above.some((team) => team.id === selfId)),
      subtreeHeight: selfId === null ? 0 : heightOf(organizationId, selfId),
    });
  };
  const teamRepository: TeamRepository = {
    async ancestors(organizationId, id) {
      requireTeam(organizationId, id);
      return ancestorsOf(organizationId, id).map(cloneTeam);
    },
    async descendants(organizationId, id) {
      requireTeam(organizationId, id);
      return descendantsOf(organizationId, id).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map(cloneTeam);
    },
    async create(input) {
      assertTeamAuthorization(input.authorization, { organizationId: input.organizationId, operation: "team.create" });
      const valid = assertValidCreateTeam(input);
      if (!organizations.has(input.organizationId)) {
        throw new TeamError(`Organization "${input.organizationId}" does not exist.`, "team_organization_unknown");
      }
      if (teams.has(input.id)) throw new TeamError(`A team with id "${input.id}" already exists.`, "team_exists");
      const inOrganization = [...teams.values()].filter((team) => team.organizationId === input.organizationId);
      if (inOrganization.some((team) => team.slug === valid.slug)) {
        throw new TeamError(`A team with slug "${valid.slug}" already exists in this organization.`, "team_slug_taken");
      }
      if (valid.externalId !== undefined && inOrganization.some((team) => team.externalId === valid.externalId)) {
        throw new TeamError(`A team with external id "${valid.externalId}" already exists in this organization.`, "team_external_id_taken");
      }
      if (valid.parentId !== undefined) checkPlacement(input.organizationId, null, valid.parentId);
      const team: Team = {
        id: input.id,
        organizationId: input.organizationId,
        slug: valid.slug,
        name: valid.name,
        status: "active",
        ...(valid.parentId !== undefined ? { parentId: valid.parentId } : {}),
        ...(valid.externalId !== undefined ? { externalId: valid.externalId } : {}),
        metadata: valid.metadata,
        settings: valid.settings,
        createdAt: valid.now,
        updatedAt: valid.now,
        version: 1,
      };
      teams.set(team.id, team);
      return cloneTeam(team);
    },
    async findById(organizationId, id) {
      const team = teamOf(organizationId, id);
      return team ? cloneTeam(team) : null;
    },
    async findBySlug(organizationId, slug) {
      const team = [...teams.values()].find((candidate) => candidate.organizationId === organizationId && candidate.slug === slug);
      return team ? cloneTeam(team) : null;
    },
    async findByExternalId(organizationId, externalId) {
      const team = [...teams.values()].find((candidate) => candidate.organizationId === organizationId && candidate.externalId === externalId);
      return team ? cloneTeam(team) : null;
    },
    async search(options) {
      return teamPage([...teams.values()].filter((team) => teamMatches(team, options)), options).map(cloneTeam);
    },
    async count(options) {
      return [...teams.values()].filter((team) => teamMatches(team, options)).length;
    },
    async update(organizationId, id, input) {
      assertTeamAuthorization(input.authorization, { organizationId, operation: "team.update" });
      const team = requireTeam(organizationId, id);
      const change = assertValidUpdateTeam(input);
      assertTeamVersion(team, input.expectedVersion, "team_version_conflict");
      if (team.status === "archived") throw new TeamError("An archived team cannot be changed; restore it first.", "team_archived");
      const others = [...teams.values()].filter((candidate) => candidate.organizationId === organizationId && candidate.id !== id);
      if (change.slug !== undefined && others.some((candidate) => candidate.slug === change.slug)) {
        throw new TeamError(`A team with slug "${change.slug}" already exists in this organization.`, "team_slug_taken");
      }
      if (typeof change.externalId === "string" && others.some((candidate) => candidate.externalId === change.externalId)) {
        throw new TeamError(`A team with external id "${change.externalId}" already exists in this organization.`, "team_external_id_taken");
      }
      const next: Team = { ...team };
      if (change.name !== undefined) next.name = change.name;
      if (change.slug !== undefined) next.slug = change.slug;
      if (change.externalId === null) delete next.externalId;
      else if (change.externalId !== undefined) next.externalId = change.externalId;
      if (change.parentId !== undefined && change.parentId !== (team.parentId ?? null)) {
        if (change.parentId !== null) checkPlacement(organizationId, id, change.parentId);
        if (change.parentId === null) delete next.parentId;
        else next.parentId = change.parentId;
      }
      if (change.metadata !== undefined) next.metadata = change.metadata;
      if (change.settings !== undefined) next.settings = change.settings;
      if (
        next.name === team.name &&
        next.parentId === team.parentId &&
        next.slug === team.slug &&
        next.externalId === team.externalId &&
        sameTeamData(next.metadata, team.metadata) &&
        sameTeamData(next.settings, team.settings)
      ) {
        return cloneTeam(team);
      }
      const saved: Team = { ...next, updatedAt: new Date(), version: team.version + 1 };
      teams.set(id, saved);
      return cloneTeam(saved);
    },
    async archive(organizationId, id, input) {
      assertTeamAuthorization(input.authorization, { organizationId, operation: "team.archive", actor: input.actor });
      const team = requireTeam(organizationId, id);
      assertTeamVersion(team, input.expectedVersion, "team_version_conflict");
      if (team.status === "archived") return cloneTeam(team);
      if (childrenOf(organizationId, id).some((child) => child.status === "active")) {
        throw new TeamError("This team still has active sub-teams; archive or move them first.", "team_has_children");
      }
      const reason = sanitizeTeamReason(input.reason);
      const saved: Team = {
        ...team,
        status: "archived",
        archived: { at: new Date(), by: { ...input.actor }, ...(reason !== undefined ? { reason } : {}) },
        updatedAt: new Date(),
        version: team.version + 1,
      };
      teams.set(id, saved);
      return cloneTeam(saved);
    },
    async restore(organizationId, id, input) {
      assertTeamAuthorization(input.authorization, { organizationId, operation: "team.restore", actor: input.actor });
      const team = requireTeam(organizationId, id);
      assertTeamVersion(team, input.expectedVersion, "team_version_conflict");
      if (team.status === "active") return cloneTeam(team);
      if (team.parentId !== undefined && teamOf(organizationId, team.parentId)?.status !== "active") {
        throw new TeamError("The parent team is archived; restore it first.", "team_parent_invalid");
      }
      const { archived: _archived, ...rest } = team;
      const saved: Team = { ...rest, status: "active", updatedAt: new Date(), version: team.version + 1 };
      teams.set(id, saved);
      return cloneTeam(saved);
    },
    async delete(organizationId, id, input) {
      assertTeamAuthorization(input?.authorization, { organizationId, operation: "team.delete" });
      const team = requireTeam(organizationId, id);
      if (team.status !== "archived") throw new TeamError("Only an archived team can be deleted; archive it first.", "team_not_archived");
      if (childrenOf(organizationId, id).length > 0) {
        throw new TeamError("This team still has sub-teams; move or delete them first.", "team_has_children");
      }
      teams.delete(id);
      for (const row of [...teamMemberships.values()]) if (row.teamId === id) teamMemberships.delete(row.id);
    },
  };

  const teamMembershipMatches = (row: TeamMembership, filter: Omit<SearchTeamMembersOptions, "limit" | "after">): boolean => {
    if (row.organizationId !== filter.organizationId) return false;
    if (filter.teamId !== undefined && row.teamId !== filter.teamId) return false;
    if (filter.membershipId !== undefined && row.membershipId !== filter.membershipId) return false;
    if (filter.status !== undefined && row.status !== filter.status) return false;
    if (filter.responsibility !== undefined && row.responsibility !== filter.responsibility) return false;
    if (filter.identity !== undefined) {
      const membership = memberships.get(row.membershipId);
      if (!membership || !sameIdentity(membership.identity, filter.identity)) return false;
    }
    return true;
  };
  const requireTeamMembership = (organizationId: string, id: string): TeamMembership => {
    const row = teamMemberships.get(id);
    if (!row || row.organizationId !== organizationId) throw new TeamError(`Team membership not found: ${id}`, "team_membership_not_found");
    return row;
  };
  const assertTeamRoles = (organizationId: string, roleIds: string[]): void => {
    for (const roleId of roleIds) {
      const role = roles.get(roleId);
      if (!role || role.organizationId !== organizationId) {
        throw new TeamError(`Role "${roleId}" does not exist in this organization.`, "team_role_invalid");
      }
      if (role.isOwnerRole) throw new TeamError("The Owner role cannot be held inside a team.", "team_role_owner_protected");
    }
  };
  const teamMembershipRepository: TeamMembershipRepository = {
    async add(input) {
      assertTeamAuthorization(input.authorization, { organizationId: input.organizationId, operation: "member.add" });
      const valid = assertValidAddTeamMember(input);
      const team = requireTeam(input.organizationId, input.teamId);
      const membership = memberships.get(input.membershipId);
      if (!membership || membership.organizationId !== input.organizationId) {
        throw new TeamError(`Membership "${input.membershipId}" does not exist in this organization.`, "team_member_unknown");
      }
      if (team.status !== "active") throw new TeamError("An archived team accepts no new members; restore it first.", "team_archived");
      assertTeamRoles(input.organizationId, valid.roleIds);
      const existing = [...teamMemberships.values()].find((row) => row.teamId === input.teamId && row.membershipId === input.membershipId);
      if (existing && existing.status !== "removed") {
        throw new TeamError("This member already belongs to the team (or has a pending invitation).", "team_membership_exists");
      }
      if (!existing && teamMemberships.has(input.id)) throw new TeamError(`A team membership with id "${input.id}" already exists.`, "team_membership_exists");
      const invitedBy = input.invitedBy ? { ...input.invitedBy } : undefined;
      const row: TeamMembership = {
        id: existing?.id ?? input.id,
        organizationId: input.organizationId,
        teamId: input.teamId,
        membershipId: input.membershipId,
        status: valid.status,
        responsibility: valid.responsibility,
        roleIds: valid.roleIds,
        createdAt: existing?.createdAt ?? valid.now,
        updatedAt: valid.now,
        ...(valid.status === "active" ? { joinedAt: existing?.joinedAt ?? valid.now } : existing?.joinedAt ? { joinedAt: existing.joinedAt } : {}),
        ...(invitedBy ? { invitedBy } : {}),
        version: (existing?.version ?? 0) + 1,
      };
      teamMemberships.set(row.id, row);
      return cloneTeamMembership(row);
    },
    async findById(organizationId, id) {
      const row = teamMemberships.get(id);
      return row && row.organizationId === organizationId ? cloneTeamMembership(row) : null;
    },
    async find(organizationId, teamId, membershipId) {
      const row = [...teamMemberships.values()].find(
        (candidate) => candidate.organizationId === organizationId && candidate.teamId === teamId && candidate.membershipId === membershipId,
      );
      return row ? cloneTeamMembership(row) : null;
    },
    async search(options) {
      return teamPage([...teamMemberships.values()].filter((row) => teamMembershipMatches(row, options)), options).map(cloneTeamMembership);
    },
    async count(options) {
      return [...teamMemberships.values()].filter((row) => teamMembershipMatches(row, options)).length;
    },
    async setStatus(organizationId, id, status, input) {
      assertTeamAuthorization(input.authorization, { organizationId, operation: "member.status", actor: input.actor });
      const row = requireTeamMembership(organizationId, id);
      assertTeamMemberStatus(status);
      assertTeamVersion(row, input.expectedVersion, "team_membership_version_conflict");
      if (row.status === status) return cloneTeamMembership(row);
      if (!isTeamMemberTransitionAllowed(row.status, status)) {
        throw new TeamError(`A ${row.status} team membership cannot become ${status}.`, "team_membership_transition_invalid");
      }
      const reason = sanitizeTeamReason(input.reason);
      const now = new Date();
      const saved: TeamMembership = {
        ...row,
        status,
        // Removing someone drops the roles they held in the team.
        roleIds: status === "removed" ? [] : row.roleIds,
        updatedAt: now,
        ...(status === "active" && !row.joinedAt ? { joinedAt: now } : {}),
        statusChange: { at: now, by: { ...input.actor }, ...(reason !== undefined ? { reason } : {}) },
        version: row.version + 1,
      };
      teamMemberships.set(id, saved);
      return cloneTeamMembership(saved);
    },
    async accept(organizationId, id, input) {
      assertTeamAuthorization(input.authorization, { organizationId, operation: "member.accept", actor: input.actor });
      const row = requireTeamMembership(organizationId, id);
      assertTeamVersion(row, input.expectedVersion, "team_membership_version_conflict");
      const membership = memberships.get(row.membershipId);
      if (!membership || !sameIdentity(membership.identity, input.actor)) {
        throw new TeamError("Only the invited person can accept a team invitation.", "team_accept_forbidden");
      }
      if (row.status === "active") return cloneTeamMembership(row);
      if (row.status !== "pending") {
        throw new TeamError(`A ${row.status} team membership cannot be accepted.`, "team_membership_transition_invalid");
      }
      const now = new Date();
      const saved: TeamMembership = {
        ...row,
        status: "active",
        updatedAt: now,
        joinedAt: row.joinedAt ?? now,
        statusChange: { at: now, by: { ...input.actor } },
        version: row.version + 1,
      };
      teamMemberships.set(id, saved);
      return cloneTeamMembership(saved);
    },
    async setResponsibility(organizationId, id, responsibility, options) {
      assertTeamAuthorization(options?.authorization, { organizationId, operation: "member.responsibility" });
      const row = requireTeamMembership(organizationId, id);
      assertTeamResponsibility(responsibility);
      assertTeamVersion(row, options?.expectedVersion, "team_membership_version_conflict");
      if (row.responsibility === responsibility) return cloneTeamMembership(row);
      const saved: TeamMembership = { ...row, responsibility, updatedAt: new Date(), version: row.version + 1 };
      teamMemberships.set(id, saved);
      return cloneTeamMembership(saved);
    },
    async assignRole(organizationId, id, roleId, options) {
      assertTeamAuthorization(options?.authorization, { organizationId, operation: "member.role" });
      const row = requireTeamMembership(organizationId, id);
      assertTeamVersion(row, options?.expectedVersion, "team_membership_version_conflict");
      assertTeamRoles(organizationId, [roleId]);
      if (row.roleIds.includes(roleId)) return cloneTeamMembership(row);
      const saved: TeamMembership = { ...row, roleIds: [...row.roleIds, roleId], updatedAt: new Date(), version: row.version + 1 };
      teamMemberships.set(id, saved);
      return cloneTeamMembership(saved);
    },
    async unassignRole(organizationId, id, roleId, options) {
      assertTeamAuthorization(options?.authorization, { organizationId, operation: "member.role" });
      const row = requireTeamMembership(organizationId, id);
      assertTeamVersion(row, options?.expectedVersion, "team_membership_version_conflict");
      if (!row.roleIds.includes(roleId)) return cloneTeamMembership(row);
      const saved: TeamMembership = { ...row, roleIds: row.roleIds.filter((candidate) => candidate !== roleId), updatedAt: new Date(), version: row.version + 1 };
      teamMemberships.set(id, saved);
      return cloneTeamMembership(saved);
    },
  };

  const cloneOutboxEvent = (event: OutboxEvent): OutboxEvent => ({ ...event, payload: event.payload === undefined ? undefined : structuredClone(event.payload) });
  const outboxEvents = new Map<string, OutboxEvent>();
  const outboxLeases = new Map<string, number>(); // id -> lease expiry (ms)
  let outboxSeq = 0;
  const outboxMatches = (event: OutboxEvent, filter: { status?: OutboxStatus; organizationId?: string; type?: string }) =>
    (filter.status === undefined || event.status === filter.status) &&
    (filter.organizationId === undefined || event.organizationId === filter.organizationId) &&
    (filter.type === undefined || event.type === filter.type);
  const outboxRepository: OutboxRepository = {
    async enqueue(input) {
      assertValidOutboxEvent(input);
      if (outboxEvents.has(input.id)) throw new OutboxError(`An event with id "${input.id}" already exists.`, "outbox_event_exists");
      const now = new Date();
      const event: OutboxEvent = {
        id: input.id,
        seq: (outboxSeq += 1),
        organizationId: input.organizationId,
        type: input.type,
        payload: input.payload === undefined ? undefined : structuredClone(input.payload),
        status: "pending",
        attempts: 0,
        createdAt: now,
        availableAt: now,
      };
      outboxEvents.set(event.id, event);
      return cloneOutboxEvent(event);
    },
    async claim(options) {
      const { limit, leaseSeconds, now } = resolveClaimOptions(options);
      const due = [...outboxEvents.values()]
        .filter(
          (event) =>
            event.status === "pending" &&
            event.availableAt.getTime() <= now.getTime() &&
            (outboxLeases.get(event.id) ?? 0) <= now.getTime() &&
            outboxMatches(event, { organizationId: options?.organizationId, type: options?.type }),
        )
        .sort((a, b) => a.seq - b.seq)
        .slice(0, limit);
      return due.map((event) => {
        const claimed: OutboxEvent = { ...event, attempts: event.attempts + 1 };
        outboxEvents.set(event.id, claimed);
        outboxLeases.set(event.id, now.getTime() + leaseSeconds * 1000);
        return cloneOutboxEvent(claimed);
      });
    },
    async complete(ids, now = new Date()) {
      let changed = 0;
      for (const id of new Set(ids)) {
        const event = outboxEvents.get(id);
        if (event?.status !== "pending") continue;
        outboxEvents.set(id, { ...event, status: "delivered", deliveredAt: now });
        outboxLeases.delete(id);
        changed += 1;
      }
      return changed;
    },
    async fail(id, input) {
      const event = outboxEvents.get(id);
      if (event?.status !== "pending") return null;
      const status: OutboxStatus = event.attempts >= input.maxAttempts ? "dead" : "pending";
      outboxEvents.set(id, { ...event, status, availableAt: input.retryAt, lastError: input.error });
      outboxLeases.delete(id);
      return status;
    },
    async requeue(id, now = new Date()) {
      const event = outboxEvents.get(id);
      if (event?.status !== "dead") return false;
      outboxEvents.set(id, { ...event, status: "pending", attempts: 0, availableAt: now, lastError: undefined });
      return true;
    },
    async findById(id) {
      const event = outboxEvents.get(id);
      return event ? cloneOutboxEvent(event) : null;
    },
    async search(options = {}) {
      const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
      return [...outboxEvents.values()]
        .filter((event) => outboxMatches(event, options) && event.seq > (options.afterSeq ?? 0))
        .sort((a, b) => a.seq - b.seq)
        .slice(0, limit)
        .map(cloneOutboxEvent);
    },
    async count(options = {}) {
      return [...outboxEvents.values()].filter((event) => outboxMatches(event, options)).length;
    },
    async pruneDelivered(before) {
      let removed = 0;
      for (const event of [...outboxEvents.values()]) {
        if (event.status === "delivered" && event.deliveredAt && event.deliveredAt.getTime() < before.getTime()) {
          outboxEvents.delete(event.id);
          removed += 1;
        }
      }
      return removed;
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
    outbox: outboxRepository,
    entitlements: entitlementRepository,
    supportGrants: supportGrantRepository,
    teams: teamRepository,
    teamMemberships: teamMembershipRepository,
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
        outbox: outboxRepository,
        entitlements: entitlementRepository,
        supportGrants: supportGrantRepository,
        teams: teamRepository,
        teamMemberships: teamMembershipRepository,
      });
    },
  };
}
