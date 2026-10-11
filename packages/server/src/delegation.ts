import {
  createAccessAdminService,
  createAuditContextStorage,
  createGuardedStorage,
  createInvitationService,
  createPlatformAuditContext,
  createPlatformService,
  createPolicyService,
  createTeamService,
} from "@uniora/core";
import type { ApiPrincipal, Identity } from "@uniora/core";
import type { ResolvedConfig } from "./config.js";
import type { VerifiedActor } from "./actor-token.js";
import type { ApplicationContext, DelegatedContext, PlatformContext } from "./route.js";

/** The operator's storage under the access guard and the audit context, for ONE request. */
function requestStorage(config: ResolvedConfig, principal: ApiPrincipal, requestId: string, actorMode?: "asserted" | "verified") {
  // Two layers that no route can take off:
  // - the access guard (`createGuardedStorage`): every write that decides who holds which power needs the proof only the services can
  //   issue, so a handler that tried to write power directly would get `access_authorization_required`;
  // - the audit context: every audit entry carries `metadata.via = { apiClientId, keyId, requestId }`, set here, inside the hash chain,
  //   where the person the call speaks for cannot forge it.
  return createGuardedStorage(createAuditContextStorage(config.storage, { apiClientId: principal.client.id, keyId: principal.key.id, requestId, ...(actorMode ? { actorMode } : {}) }));
}

export function createApplicationContext(config: ResolvedConfig, principal: ApiPrincipal, requestId: string, actorMode?: "asserted" | "verified"): ApplicationContext {
  const storage = requestStorage(config, principal, requestId, actorMode);
  const engine = config.engine;
  return {
    principal: { provider: "uniora-api", subject: principal.client.id },
    storage,
    invitations: config.invitations ? createInvitationService({ storage, ...(engine ? { engine } : {}), ...invitationOptions(config) }) : undefined,
  };
}

/** The services a delegated call uses, built for ONE request, acting as `actor`. */
export function createDelegatedContext(config: ResolvedConfig, principal: ApiPrincipal, requestId: string, actor: Identity, actorMode: "asserted" | "verified"): DelegatedContext {
  const application = createApplicationContext(config, principal, requestId, actorMode);
  const { storage } = application;
  const engine = config.engine;
  return {
    ...application,
    actor,
    access: createAccessAdminService({ storage, ...(engine ? { engine } : {}) }),
    teams: createTeamService({ storage, ...(engine ? { engine } : {}) }),
    policies: createPolicyService({ storage, ...(engine ? { engine } : {}), ...config.policies }),
  };
}

function invitationOptions(config: ResolvedConfig) {
  const { includeAcceptUrl: _includeAcceptUrl, ...rest } = config.invitations!;
  return rest;
}

/**
 * The platform service for ONE request, acting as the operator the verified token names. The step-up question is answered from that
 * very token: the operator must have signed in recently (`auth_time`) with a second factor (`amr`), as `platform.stepUp` says. Both the
 * platform trail and the organization trail stamp `via`, so an entry says which API client relayed the operator's call.
 */
export function createPlatformContext(config: ResolvedConfig, principal: ApiPrincipal, requestId: string, operator: VerifiedActor): PlatformContext {
  const platform = config.platform;
  if (!platform) throw new Error("The platform is not configured.");
  const via = { apiClientId: principal.client.id, keyId: principal.key.id, requestId, actorMode: "verified" };
  const rule = platform.stepUp;
  const service = createPlatformService({
    platform: createPlatformAuditContext(platform.storage, via),
    storage: createAuditContextStorage(config.storage, via),
    ...(platform.engine ? { engine: platform.engine } : {}),
    ...(platform.supportGrantablePermissions ? { supportGrantablePermissions: platform.supportGrantablePermissions } : {}),
    stepUp: () => {
      const session = operator.session;
      if (!session.authenticatedAt) return false;
      const ageMs = config.now().getTime() - session.authenticatedAt.getTime();
      if (ageMs > rule.maxAgeSeconds * 1000) return false;
      if (rule.requireMfa && session.mfa !== true) return false;
      if (rule.minAssuranceLevel !== undefined && (session.assuranceLevel ?? -1) < rule.minAssuranceLevel) return false;
      return true;
    },
  });
  return { actor: operator.identity, service, providers: platform.providers };
}
