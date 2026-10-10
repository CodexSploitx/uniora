import {
  createAccessAdminService,
  createAuditContextStorage,
  createGuardedStorage,
  createInvitationService,
  createPolicyService,
  createTeamService,
} from "@uniora/core";
import type { ApiPrincipal, Identity } from "@uniora/core";
import type { ResolvedConfig } from "./config.js";
import type { ApplicationContext, DelegatedContext } from "./route.js";

/** The operator's storage under the access guard and the audit context, for ONE request. */
function requestStorage(config: ResolvedConfig, principal: ApiPrincipal, requestId: string) {
  // Two layers that no route can take off:
  // - the access guard (`createGuardedStorage`): every write that decides who holds which power needs the proof only the services can
  //   issue, so a handler that tried to write power directly would get `access_authorization_required`;
  // - the audit context: every audit entry carries `metadata.via = { apiClientId, keyId, requestId }`, set here, inside the hash chain,
  //   where the person the call speaks for cannot forge it.
  return createGuardedStorage(createAuditContextStorage(config.storage, { apiClientId: principal.client.id, keyId: principal.key.id, requestId }));
}

export function createApplicationContext(config: ResolvedConfig, principal: ApiPrincipal, requestId: string): ApplicationContext {
  const storage = requestStorage(config, principal, requestId);
  const engine = config.engine;
  return {
    principal: { provider: "uniora-api", subject: principal.client.id },
    storage,
    invitations: config.invitations ? createInvitationService({ storage, ...(engine ? { engine } : {}), ...invitationOptions(config) }) : undefined,
  };
}

/** The services a delegated call uses, built for ONE request, acting as `actor`. */
export function createDelegatedContext(config: ResolvedConfig, principal: ApiPrincipal, requestId: string, actor: Identity): DelegatedContext {
  const application = createApplicationContext(config, principal, requestId);
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
