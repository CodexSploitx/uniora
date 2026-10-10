export { UnioraError } from "./shared/errors.js";
export { assertExpectedVersion } from "./shared/version.js";
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
  SuspendMembershipInput,
  CreateMembershipInput,
  MembershipListing,
  MembershipRepository,
  SearchMembershipsOptions,
  UnblockMembershipInput,
  MembershipVersionOptions,
} from "./membership/repository.js";
export { assertBlockUntil, sanitizeBlockReason } from "./membership/repository.js";
export { MembershipError } from "./membership/repository.js";
export type { LeaveOrganizationInput, TransferOwnershipInput } from "./membership/ownership.js";
export { leaveOrganization, transferOwnership } from "./membership/ownership.js";

export type { IdentityProfile, ListMembersWithProfilesOptions, MemberListing, ProfileResolver } from "./profile/profiles.js";
export { MAX_PROFILE_BATCH, listMembersWithProfiles, sanitizeProfile } from "./profile/profiles.js";

export type { Role } from "./role/types.js";
export type {
  CloneRoleInput,
  CreateOwnerRoleInput,
  CreateRoleInput,
  DeleteRoleMembers,
  DeleteRoleOptions,
  RoleRepository,
  RoleSummary,
  SearchRolesOptions,
  SetRolePermissionsOptions,
  SetRolePermissionsResult,
  UpdateRoleInput,
} from "./role/repository.js";
export {
  applyRoleTemplates,
  type ApplyRoleTemplatesOptions,
  type ApplyRoleTemplatesResult,
  type RoleTemplate,
  type RoleTemplateConflict,
  type RoleTemplateFailure,
} from "./role/templates.js";
export { RoleError } from "./role/repository.js";
export {
  assertNonEmptyPermissionKey,
  assertValidRoleKey,
  MAX_ROLE_DESCRIPTION_LENGTH,
  resolveRoleKey,
  sanitizeRoleDescription,
  sanitizeRoleName,
  normalizeRoleName,
  sanitizeRolePermissionKeys,
} from "./role/key.js";

export type { Permission } from "./permission/types.js";
export {
  MAX_IMPLICATION_DEPTH,
  MAX_IMPLIED_PERMISSIONS,
  MAX_PERMISSION_GROUP_LENGTH,
  assertValidImplications,
  expandClosure,
  impliedByClosure,
  implicationGraph,
  sanitizeImplies,
  sanitizePermissionGroup,
} from "./permission/implications.js";
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
  FeatureToggleOptions,
  FeatureUsage,
  RegisterFeatureInput,
  SearchFeaturesOptions,
} from "./feature/repository.js";
export { FeatureError, MAX_EFFECTIVE_MANY, assertEffectiveManyInput, sanitizeFeatureChangeReason } from "./feature/repository.js";
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
  InvitationAccessOptions,
  InvitationRateLimits,
  InvitationRef,
  InvitationService,
  InvitationServiceOptions,
  InviteInput,
  InviteReplayResult,
  InviteResult,
} from "./invitation/service.js";
export { createInvitationService, normalizeInvitationEmail } from "./invitation/service.js";
export type { InvitationHttpError } from "./invitation/http.js";
export { AccessError } from "./access/errors.js";
export type { AccessErrorCode } from "./access/errors.js";
export { ACCESS_OPERATIONS } from "./access/authorization.js";
export type { AccessAuthorization, AccessOperation, AccessWriteOptions } from "./access/authorization.js";
export { GUARDED_WRITES, createGuardedStorage, createTrustedAccessStorage, isGuardedStorage } from "./access/guard.js";
export type { TrustedAccessStorageOptions } from "./access/guard.js";
export { ACCESS_PERMISSIONS } from "./access/permissions.js";
export type { AccessPermissionKeys } from "./access/permissions.js";
export { createAccessAdminService } from "./access/service.js";
export type { AccessActor, AccessAdminService, AccessAdminServiceOptions, CreateRoleCommand, MemberRef, RoleRef } from "./access/service.js";
export type { AccessCommand, AccessCommandContext, AccessHttpError, AccessServices } from "./access/commands.js";
export { ACCESS_COMMANDS, accessErrorToHttp, isAccessCommand, runAccessCommand } from "./access/commands.js";
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
export type {
  AuthorizationReason,
  AuthorizationResult,
  AuthorizeInput,
  AuthorizeResource,
  PolicyDeciderOptions,
} from "./policy/decider.js";
export { createAuthorizationEngine } from "./authorization/engine.js";
export type { AuthorizationSnapshot, ComputeAuthorizationSnapshotInput } from "./authorization/snapshot.js";
export { computeAuthorizationSnapshot } from "./authorization/snapshot.js";

export type { OutboxEvent, OutboxStatus } from "./outbox/types.js";
export type {
  ClaimOutboxOptions,
  EnqueueOutboxInput,
  FailOutboxInput,
  OutboxErrorCode,
  OutboxRepository,
  SearchOutboxOptions,
} from "./outbox/repository.js";
export {
  MAX_OUTBOX_CLAIM,
  MAX_OUTBOX_LEASE_SECONDS,
  MAX_OUTBOX_PAYLOAD_BYTES,
  MAX_OUTBOX_TYPE_LENGTH,
  OutboxError,
  assertValidOutboxEvent,
  resolveClaimOptions,
} from "./outbox/repository.js";
export type { DispatchOutboxOptions, DispatchOutboxResult } from "./outbox/dispatch.js";
export { dispatchOutbox, outboxBackoffSeconds } from "./outbox/dispatch.js";

export type { ConsumeResult, EntitlementDefinition, EntitlementLimitSource, EntitlementPeriod, EntitlementStatus } from "./entitlement/types.js";
export type { DefineEntitlementInput, EntitlementClock, EntitlementErrorCode, EntitlementRepository } from "./entitlement/repository.js";
export {
  EntitlementError,
  MAX_ENTITLEMENT_AMOUNT,
  MAX_ENTITLEMENT_KEY_LENGTH,
  assertValidEntitlementAmount,
  assertValidEntitlementKey,
  assertValidEntitlementLimit,
  assertValidEntitlementPeriod,
  buildEntitlementStatus,
  entitlementWindow,
  sanitizeEntitlementName,
  toConsumeResult,
} from "./entitlement/repository.js";

export type { SupportGrant, SupportGrantStatus } from "./support-grant/types.js";
export type {
  CreateSupportGrantInput,
  SearchSupportGrantsOptions,
  SupportGrantErrorCode,
  SupportGrantRepository,
} from "./support-grant/repository.js";
export {
  MAX_SUPPORT_GRANT_MS,
  MAX_SUPPORT_GRANT_PERMISSIONS,
  MAX_SUPPORT_GRANT_REASON_LENGTH,
  SupportGrantError,
  assertValidSupportGrant,
  grantStatus,
} from "./support-grant/repository.js";

export type {
  Team,
  TeamArchive,
  TeamData,
  TeamMemberStatus,
  TeamMemberStatusChange,
  TeamMembership,
  TeamResponsibility,
  TeamStatus,
} from "./team/types.js";
export { TEAM_MEMBER_STATUSES, TEAM_RESPONSIBILITIES, TEAM_STATUSES } from "./team/types.js";
export type {
  AddTeamMemberInput,
  ArchiveTeamInput,
  CreateTeamInput,
  RestoreTeamInput,
  SearchTeamMembersOptions,
  SearchTeamsOptions,
  SetTeamMemberStatusInput,
  TeamErrorCode,
  TeamMemberChangeOptions,
  TeamMembershipRepository,
  TeamPlacementFacts,
  TeamRepository,
  UpdateTeamInput,
  ValidTeamUpdate,
} from "./team/repository.js";
export {
  MAX_TEAM_DATA_BYTES,
  MAX_TEAM_DEPTH,
  MAX_TEAM_EXTERNAL_ID_LENGTH,
  MAX_TEAM_MEMBER_ROLES,
  MAX_SUBJECT_TEAMS,
  MAX_TEAM_NAME_LENGTH,
  MAX_TEAM_REASON_LENGTH,
  TeamError,
  assertTeamMemberStatus,
  assertTeamPlacement,
  assertTeamResponsibility,
  assertValidAddTeamMember,
  assertValidCreateTeam,
  assertValidUpdateTeam,
  isTeamMemberTransitionAllowed,
  isTeamMembershipActive,
  resolveTeamSlug,
  sameTeamData,
  sanitizeTeamData,
  sanitizeTeamExternalId,
  sanitizeTeamName,
  sanitizeTeamReason,
} from "./team/repository.js";
export type { TeamCommand, TeamCommandContext, TeamHttpError } from "./team/commands.js";
export { TEAM_COMMANDS, isTeamCommand, runTeamCommand, teamErrorToHttp } from "./team/commands.js";
export type { MoveTeamMemberInput, TeamActor, TeamPermissionKeys, TeamService, TeamServiceOptions } from "./team/service.js";
export { TEAM_PERMISSIONS, createTeamService } from "./team/service.js";
export type { TeamAuthorization, TeamOperation } from "./team/authorization.js";
export { TEAM_OPERATIONS, assertTeamAuthorization } from "./team/authorization.js";
export type { TrustedTeamStorage, TrustedTeamStorageOptions, TrustedTeamTransaction } from "./team/trusted.js";
export { createTrustedTeamStorage } from "./team/trusted.js";

export type { PlatformMember, PlatformMemberStatus, PlatformRole, PlatformStatusChange } from "./platform/types.js";
export { PLATFORM_ADMIN_ROLE_KEY, PLATFORM_MEMBER_STATUSES } from "./platform/types.js";
export type { PlatformErrorCode } from "./platform/errors.js";
export {
  MAX_PLATFORM_PERMISSION_LENGTH,
  MAX_PLATFORM_ROLE_PERMISSIONS,
  PLATFORM_ALL,
  PLATFORM_PERMISSIONS,
  assertValidPlatformPermission,
  isPlatformWildcard,
  isValidPlatformPermission,
  platformKeyCovers,
  platformPermissionsCover,
  platformPermissionsCoverAll,
} from "./platform/permissions.js";
export type { PlatformAuthorization, PlatformOperation } from "./platform/authorization.js";
export { PLATFORM_OPERATIONS, assertPlatformAuthorization } from "./platform/authorization.js";
export type {
  AddPlatformMemberInput,
  CreatePlatformRoleInput,
  PlatformMemberChange,
  PlatformMemberRepository,
  PlatformRoleRepository,
  PlatformStorage,
  PlatformTransaction,
  SearchPlatformMembersOptions,
  SearchPlatformRolesOptions,
  UpdatePlatformRoleInput,
} from "./platform/repository.js";
export {
  MAX_PLATFORM_MEMBER_ROLES,
  MAX_PLATFORM_REASON_LENGTH,
  MAX_PLATFORM_ROLE_DESCRIPTION_LENGTH,
  MAX_PLATFORM_ROLE_NAME_LENGTH,
  PLATFORM_LOCK_KEY,
  PlatformError,
  assertPlatformId,
  assertPlatformIdentity,
  assertPlatformVersion,
  assertValidAddPlatformMember,
  assertValidCreatePlatformRole,
  assertValidUpdatePlatformRole,
  normalizePlatformPermissions,
  sanitizePlatformReason,
} from "./platform/repository.js";
export type { PlatformDecision, PlatformEngine, PlatformEngineOptions, PlatformReader } from "./platform/engine.js";
export { createPlatformEngine, permissionsOfRoles } from "./platform/engine.js";
export type { GrantSupportAccessInput, PlatformActor, PlatformService, PlatformServiceOperation, PlatformServiceOptions } from "./platform/service.js";
export { createPlatformService } from "./platform/service.js";
export type { BootstrapPlatformInput, BootstrapPlatformResult } from "./platform/bootstrap.js";
export { bootstrapPlatform } from "./platform/bootstrap.js";
export type { MemoryPlatformStorageOptions } from "./platform/memory.js";
export { createMemoryPlatformStorage } from "./platform/memory.js";
export type { PlatformCommand, PlatformCommandContext, PlatformHttpError } from "./platform/commands.js";
export { PLATFORM_COMMANDS, isPlatformCommand, platformErrorToHttp, runPlatformCommand } from "./platform/commands.js";

export type { PolicyErrorCode } from "./policy/errors.js";
export { PolicyError } from "./policy/errors.js";
export type {
  AttributeType,
  AttributeValue,
  Comparison,
  Condition,
  Operand,
  Policy,
  PolicyDefinition,
  PolicyEffect,
  PolicyKind,
  PolicyRevision,
  PolicyStatus,
  PolicyStatusChange,
  Scalar,
} from "./policy/types.js";
export { ATTRIBUTE_TYPES, COMPARISONS, POLICY_EFFECTS, POLICY_KINDS, POLICY_STATUSES, RESERVED_POLICY_KINDS } from "./policy/types.js";
export { PROTECTED_PERMISSION_PREFIX, RESOURCE_ATTRIBUTES, SUBJECT_ATTRIBUTES, isProtectedPermission } from "./policy/attributes.js";
export type { SubjectAttributeName } from "./policy/attributes.js";
export type { ParsedPolicyDefinition, PolicyAnalysis } from "./policy/definition.js";
export {
  MAX_CONDITION_CHILDREN,
  MAX_CONDITION_DEPTH,
  MAX_CONDITION_NODES,
  MAX_LITERAL_ITEMS,
  MAX_LITERAL_LENGTH,
  MAX_POLICY_ACTIONS,
  MAX_POLICY_ATTRIBUTES,
  MAX_POLICY_DEFINITION_BYTES,
  MAX_POLICY_DESCRIPTION_LENGTH,
  MAX_POLICY_FACT_LOOKUPS,
  MAX_POLICY_KEY_LENGTH,
  MAX_POLICY_NAME_LENGTH,
  MAX_POLICY_NOTE_LENGTH,
  actionCandidates,
  actionMatches,
  assertValidPolicyKey,
  hashPolicyDefinition,
  parsePolicyDefinition,
  sanitizePolicyDescription,
  sanitizePolicyName,
  sanitizePolicyNote,
} from "./policy/definition.js";
export type {
  Applicability,
  EvaluablePolicy,
  EvaluatePolicySetOptions,
  EvaluationFacts,
  PolicyOutcome,
  PolicyRequest,
  PolicySetEvaluation,
  RequiredFacts,
  ResourceFacts,
  UnknownReason,
  Verdict,
} from "./policy/evaluate.js";
export {
  MAX_ACTIVE_POLICIES,
  MAX_EVALUATION_STEPS,
  MAX_RESOURCE_ATTRIBUTES,
  MAX_RESOURCE_LIST_ITEMS,
  MAX_RESOURCE_VALUE_LENGTH,
  applicability,
  combineVerdicts,
  evaluatePolicy,
  evaluatePolicySet,
  requiredFacts,
} from "./policy/evaluate.js";
export type { PolicyAuthorization, PolicyOperation } from "./policy/authorization.js";
export { POLICY_OPERATIONS, assertPolicyAuthorization } from "./policy/authorization.js";
export type {
  ActivePolicySet,
  ChangePolicyStatusInput,
  CreatePolicyInput,
  PolicyRepository,
  SearchPoliciesOptions,
  UpdatePolicyInput,
} from "./policy/repository.js";
export {
  DEFAULT_POLICY_PAGE,
  MAX_POLICIES_PER_ORGANIZATION,
  MAX_POLICY_PAGE,
  MAX_POLICY_REVISIONS,
  assertPolicyFilters,
  assertPolicyId,
  assertPolicyStatus,
  assertPolicyTransition,
  assertValidCreatePolicy,
  assertValidUpdatePolicy,
  isPolicyTransitionAllowed,
  normalizePolicyPage,
} from "./policy/repository.js";
export type { TrustedPolicyStorage, TrustedPolicyStorageOptions, TrustedPolicyTransaction } from "./policy/trusted.js";
export { createTrustedPolicyStorage } from "./policy/trusted.js";
export { createMemoryPolicyRepository } from "./policy/memory.js";
export type { PolicyActor, PolicyPermissionKeys, PolicyService, PolicyServiceOptions, SimulatePolicyInput } from "./policy/service.js";
export { POLICY_PERMISSIONS, createPolicyService } from "./policy/service.js";
export type { PolicyDecisionAuditorOptions } from "./policy/auditor.js";
export { createPolicyDecisionAuditor } from "./policy/auditor.js";
export type { PolicyCommand, PolicyCommandContext, PolicyHttpError } from "./policy/commands.js";
export { POLICY_COMMANDS, isPolicyCommand, policyErrorToHttp, runPolicyCommand } from "./policy/commands.js";

export { ApiCredentialError } from "./api/errors.js";
export type { ApiCredentialErrorCode } from "./api/errors.js";
export { API_SCOPES, API_SCOPE_LIST, RESERVED_IDENTITY_PROVIDERS, isApiScope, isReservedIdentityProvider } from "./api/scopes.js";
export type { ApiScope } from "./api/scopes.js";
export { API_CLIENT_STATUSES, isApiKeyActive } from "./api/types.js";
export type { ApiClient, ApiClientStatus, ApiKey, ApiKeyRecord, ApiPrincipal } from "./api/types.js";
export {
  API_KEY_CHECKSUM_LENGTH,
  API_KEY_ID_LENGTH,
  API_KEY_MAX_LENGTH,
  API_KEY_PREFIX,
  API_KEY_SECRET_LENGTH,
  bearerToken,
  generateApiKey,
  hashApiKeySecret,
  parseApiKey,
  randomBase62,
  verifyApiKeySecret,
} from "./api/key.js";
export type { GeneratedApiKey, ParsedApiKey } from "./api/key.js";
export {
  MAX_ACTIVE_API_KEYS_PER_CLIENT,
  MAX_API_CLIENT_NAME_LENGTH,
  MAX_API_CLIENT_ORGANIZATIONS,
  MAX_API_KEY_LIFETIME_MS,
  normalizeApiClientName,
  sanitizeApiClientName,
  sanitizeApiOrganizations,
  sanitizeApiScopes,
} from "./api/repository.js";
export type {
  ApiClientRepository,
  ApiCredentialStorage,
  ApiCredentialTransaction,
  ApiKeyRepository,
  CreateApiClientInput,
  CreateApiKeyInput,
  SearchApiClientsOptions,
  UpdateApiClientInput,
} from "./api/repository.js";
export { createMemoryApiCredentialStorage } from "./api/memory.js";
export type { MemoryApiCredentialStorageOptions } from "./api/memory.js";
export { createApiCredentialService } from "./api/service.js";
export type { ApiClientWithKeys, ApiCredentialService, ApiCredentialServiceOptions, CreatedApiKey } from "./api/service.js";
export { API_KEY_TOUCH_INTERVAL_MS, authenticateApiKey, clientMayAccessOrganization } from "./api/authenticate.js";
export type { AuthenticateApiKeyOptions } from "./api/authenticate.js";
