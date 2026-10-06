export { UnioraError } from "./shared/errors.js";
export type {
  FeatureErrorCode,
  IdentityLinkErrorCode,
  MembershipErrorCode,
  OrganizationErrorCode,
  PermissionErrorCode,
  RoleErrorCode,
} from "./shared/errors.js";

export type { Identity } from "./identity/types.js";
export { sameIdentity } from "./identity/types.js";

export type { Organization, OrganizationStatus, OrganizationStatusChange } from "./organization/types.js";
export { ORGANIZATION_STATUSES } from "./organization/types.js";
export { MAX_STATUS_REASON_LENGTH, assertOrganizationStatus, sanitizeStatusReason } from "./organization/status.js";
export type {
  CreateOrganizationInput,
  OrganizationCursor,
  OrganizationRepository,
  SearchOrganizationsOptions,
  SetOrganizationStatusInput,
  UpdateOrganizationInput,
} from "./organization/repository.js";
export type {
  CreateOrganizationWithOwnerInput,
  CreateOrganizationWithOwnerResult,
} from "./organization/create-with-owner.js";
export { createOrganizationWithOwner } from "./organization/create-with-owner.js";
export { OrganizationError, assertValidSlug, resolveOrganizationSlug, sanitizeOrganizationName, slugify } from "./organization/slug.js";

export type { Membership, MembershipBlock, MembershipStatus } from "./membership/types.js";
export type {
  BlockMembershipInput,
  CreateMembershipInput,
  MembershipListing,
  MembershipRepository,
  SearchMembershipsOptions,
  UnblockMembershipInput,
} from "./membership/repository.js";
export { sanitizeBlockReason } from "./membership/repository.js";
export { MembershipError } from "./membership/repository.js";
export type { LeaveOrganizationInput, TransferOwnershipInput } from "./membership/ownership.js";
export { leaveOrganization, transferOwnership } from "./membership/ownership.js";

export type { IdentityProfile, ListMembersWithProfilesOptions, MemberListing, ProfileResolver } from "./profile/profiles.js";
export { MAX_PROFILE_BATCH, listMembersWithProfiles, sanitizeProfile } from "./profile/profiles.js";

export type { Role } from "./role/types.js";
export type { CreateOwnerRoleInput, CreateRoleInput, RoleRepository, RoleSummary, SearchRolesOptions } from "./role/repository.js";
export { RoleError } from "./role/repository.js";
export {
  assertNonEmptyPermissionKey,
  assertValidRoleKey,
  resolveRoleKey,
  sanitizeRoleName,
  sanitizeRolePermissionKeys,
} from "./role/key.js";

export type { Permission } from "./permission/types.js";
export type { PermissionRepository, RegisterPermissionInput, SearchPermissionsOptions } from "./permission/repository.js";
export { PermissionError } from "./permission/repository.js";
export { assertValidPermissionKey, sanitizePermissionName } from "./permission/key.js";

export type {
  EffectiveFeature,
  EffectiveFeatureReason,
  Feature,
  FeatureChangeMeta,
  FeatureDefinition,
} from "./feature/types.js";
export type {
  DisableEverywhereResult,
  FeatureRepository,
  FeatureUsage,
  RegisterFeatureInput,
  SearchFeaturesOptions,
} from "./feature/repository.js";
export { FeatureError, sanitizeFeatureChangeReason } from "./feature/repository.js";
export { MAX_FEATURE_DEPTH, assertValidFeatureParent, featureChain, featureRequirements, resolveEffectiveFeatures } from "./feature/effective.js";
export { assertValidFeatureKey, resolveFeatureKey, sanitizeFeatureName } from "./feature/key.js";

export type { AuditIntegrityOptions, AuditIntegrityReport, AuditLogEntry, AuditLogTarget } from "./audit-log/types.js";
export { applyAnchor, computeAuditEntryHash } from "./audit-log/chain.js";
export type { ChainedAuditFields } from "./audit-log/chain.js";
export type {
  AuditLogCursor,
  AuditLogRepository,
  ListAuditLogOptions,
  ListRecentAuditLogOptions,
  PruneAuditLogInput,
  PruneAuditLogResult,
  RecordAuditLogInput,
  SearchAuditLogOptions,
} from "./audit-log/repository.js";
export { AuditLogError, assertAuditInput, assertPruneCutoff } from "./audit-log/repository.js";
export { applyAuditRetention, MIN_AUDIT_RETENTION_DAYS, type AuditRetentionOptions, type AuditRetentionResult } from "./audit-log/retention.js";
export { AUDIT_ACTIONS, isStandardAuditAction, type AuditAction } from "./audit-log/actions.js";

export type { IdentityLink } from "./identity-link/types.js";
export type { IdentityLinkRepository, LinkIdentityInput } from "./identity-link/repository.js";
export { IdentityLinkError } from "./identity-link/repository.js";

export type { Invitation, InvitationDelivery, InvitationDeliveryStatus, InvitationStatus } from "./invitation/types.js";
export { isInvitationUsable } from "./invitation/types.js";
export type {
  CreateInvitationInput,
  InvitationFailureReason,
  InvitationRepository,
  RecordDeliveryInput,
  SearchInvitationsOptions,
} from "./invitation/repository.js";
export { InvitationError } from "./invitation/repository.js";
export type {
  DeliveryRetryOptions,
  InvitationMessage,
  InvitationSender,
  SendContext,
  SendOutcome,
} from "./invitation/delivery.js";
export { InvitationDeliveryError, sanitizeDeliveryError, sendWithRetry } from "./invitation/delivery.js";
export type {
  AcceptInvitationInput,
  AcceptInvitationResult,
  DeliveryOutcome,
  InvitationPreview,
  InvitationRateLimits,
  InvitationRef,
  InvitationService,
  InvitationServiceOptions,
  InviteInput,
  InviteResult,
} from "./invitation/service.js";
export { createInvitationService, normalizeInvitationEmail } from "./invitation/service.js";
export type { InvitationHttpError } from "./invitation/http.js";
export { invitationErrorToHttp } from "./invitation/http.js";
export { generateInvitationToken, hashInvitationToken, INVITATION_TOKEN_PREFIX } from "./invitation/token.js";

export type { UnioraStorage, UnioraTransaction } from "./storage/types.js";
export { createMemoryStorage } from "./storage/memory.js";
export { createAuditedStorage, type AuditedStorageOptions } from "./storage/audited.js";

export type {
  AccessCheckInput,
  AuthorizationDecision,
  AuthorizationEngine,
  AuthorizationEngineOptions,
  CanInput,
} from "./authorization/engine.js";
export { createAuthorizationEngine } from "./authorization/engine.js";
export type { AuthorizationSnapshot, ComputeAuthorizationSnapshotInput } from "./authorization/snapshot.js";
export { computeAuthorizationSnapshot } from "./authorization/snapshot.js";
