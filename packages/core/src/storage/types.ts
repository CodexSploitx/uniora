import type { OrganizationRepository } from "../organization/repository.js";
import type { MembershipRepository } from "../membership/repository.js";
import type { RoleRepository } from "../role/repository.js";
import type { PermissionRepository } from "../permission/repository.js";
import type { FeatureRepository } from "../feature/repository.js";
import type { AuditLogRepository } from "../audit-log/repository.js";
import type { IdentityLinkRepository } from "../identity-link/repository.js";
import type { InvitationRepository } from "../invitation/repository.js";
import type { OutboxRepository } from "../outbox/repository.js";
import type { EntitlementRepository } from "../entitlement/repository.js";
import type { SupportGrantRepository } from "../support-grant/repository.js";
import type { TeamMembershipRepository, TeamRepository } from "../team/repository.js";
import type { PolicyRepository } from "../policy/repository.js";

export interface UnioraTransaction {
  organizations: OrganizationRepository;
  memberships: MembershipRepository;
  roles: RoleRepository;
  permissions: PermissionRepository;
  features: FeatureRepository;
  auditLogs: AuditLogRepository;
  identityLinks: IdentityLinkRepository;
  invitations: InvitationRepository;
  outbox: OutboxRepository;
  entitlements: EntitlementRepository;
  supportGrants: SupportGrantRepository;
  teams: TeamRepository;
  teamMemberships: TeamMembershipRepository;
  policies: PolicyRepository;
  /**
   * Takes a transaction-scoped advisory lock on `key`, held until commit/rollback, so check-then-insert
   * sequences (e.g. invitation rate limits) can't interleave across processes. Optional: backends that
   * already serialize writers (SQLite `begin immediate`, in-memory) may omit it.
   */
  lock?(key: string): Promise<void>;
}

/**
 * The storage abstraction adapters implement (docs/PROYECT.md §17).
 * The Core never speaks SQL directly against any of these.
 */
export interface UnioraStorage {
  readonly organizations: OrganizationRepository;
  readonly memberships: MembershipRepository;
  readonly roles: RoleRepository;
  readonly permissions: PermissionRepository;
  readonly features: FeatureRepository;
  readonly auditLogs: AuditLogRepository;
  readonly identityLinks: IdentityLinkRepository;
  readonly invitations: InvitationRepository;
  readonly outbox: OutboxRepository;
  readonly entitlements: EntitlementRepository;
  readonly supportGrants: SupportGrantRepository;
  readonly teams: TeamRepository;
  readonly teamMemberships: TeamMembershipRepository;
  readonly policies: PolicyRepository;
  transaction<T>(callback: (tx: UnioraTransaction) => Promise<T>): Promise<T>;
}
