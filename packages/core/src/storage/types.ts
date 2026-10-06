import type { OrganizationRepository } from "../organization/repository.js";
import type { MembershipRepository } from "../membership/repository.js";
import type { RoleRepository } from "../role/repository.js";
import type { PermissionRepository } from "../permission/repository.js";
import type { FeatureRepository } from "../feature/repository.js";
import type { AuditLogRepository } from "../audit-log/repository.js";
import type { IdentityLinkRepository } from "../identity-link/repository.js";
import type { InvitationRepository } from "../invitation/repository.js";

export interface UnioraTransaction {
  organizations: OrganizationRepository;
  memberships: MembershipRepository;
  roles: RoleRepository;
  permissions: PermissionRepository;
  features: FeatureRepository;
  auditLogs: AuditLogRepository;
  identityLinks: IdentityLinkRepository;
  invitations: InvitationRepository;
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
  transaction<T>(callback: (tx: UnioraTransaction) => Promise<T>): Promise<T>;
}
