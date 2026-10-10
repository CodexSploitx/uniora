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
import type { DelegatedContext } from "./route.js";

/**
 * The services a delegated call uses, built for ONE request. Their storage is the operator's storage, under two layers that no
 * route can take off:
 *
 * - the access guard (`createGuardedStorage`): every write that decides who holds which power needs the proof only the services
 *   can issue, so a handler that tried to write power directly would get `access_authorization_required`;
 * - the audit context: every audit entry carries `metadata.via = { apiClientId, keyId, requestId }`, set here, inside the hash
 *   chain, where the person the call speaks for cannot forge it.
 */
export function createDelegatedContext(config: ResolvedConfig, principal: ApiPrincipal, requestId: string, actor: Identity): DelegatedContext {
  const storage = createGuardedStorage(createAuditContextStorage(config.storage, { apiClientId: principal.client.id, keyId: principal.key.id, requestId }));
  const engine = config.engine;
  return {
    actor,
    access: createAccessAdminService({ storage, ...(engine ? { engine } : {}) }),
    teams: createTeamService({ storage, ...(engine ? { engine } : {}) }),
    policies: createPolicyService({ storage, ...(engine ? { engine } : {}), ...config.policies }),
    invitations: config.invitations ? createInvitationService({ storage, ...(engine ? { engine } : {}), ...config.invitations }) : undefined,
  };
}
