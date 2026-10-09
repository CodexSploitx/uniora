import type { AuthorizationDecision } from "../authorization/engine.js";
import { randomId } from "../invitation/token.js";
import type { UnioraStorage } from "../storage/types.js";

export interface PolicyDecisionAuditorOptions {
  /**
   * Which decisions to write to the audit log: `denied` (default) keeps the ones that were refused or could not be decided,
   * which is what an investigation needs; `all` also keeps the allowed ones, which on a busy system is a lot of rows.
   */
  record?: "denied" | "all";
  /** Called when writing an entry fails (the decision itself is never affected). */
  onError?: (error: unknown) => void;
}

/**
 * An `onDecision` hook that writes the result of `engine.authorize()` to the audit log: who asked, for which permission and
 * resource, the verdict and its reason code, and the policies used with their revision (never the attribute values). Plain
 * `can()` and `access.check()` decisions are ignored.
 *
 * ```ts
 * createAuthorizationEngine(storage, { onDecision: createPolicyDecisionAuditor(storage) });
 * ```
 */
export function createPolicyDecisionAuditor(
  storage: Pick<UnioraStorage, "auditLogs">,
  options: PolicyDecisionAuditorOptions = {},
): (decision: AuthorizationDecision) => Promise<void> {
  const mode = options.record ?? "denied";
  return async (decision) => {
    const result = decision.authorization;
    if (decision.kind !== "authorize" || !result) return;
    if (result.decision === "allow" && mode !== "all") return;
    const action =
      result.decision === "allow" ? "policy.decision_allowed" : result.decision === "deny" ? "policy.decision_denied" : "policy.decision_indeterminate";
    try {
      await storage.auditLogs.record({
        id: `audit:${randomId()}`,
        organizationId: result.organizationId === "" ? undefined : result.organizationId,
        actor: decision.identity,
        action,
        target: decision.resource ?? { type: "permission", id: result.permission },
        metadata: {
          permission: result.permission,
          reason: result.reason,
          ...(result.via !== undefined ? { via: result.via } : {}),
          policyRevision: result.policyRevision,
          policies: result.policies.map((policy) => ({
            key: policy.key,
            revision: policy.revision,
            definitionHash: policy.definitionHash,
            result: policy.result,
            ...(policy.reason !== undefined ? { reason: policy.reason } : {}),
          })),
        },
      });
    } catch (error) {
      try {
        options.onError?.(error);
      } catch {
        /* a failing logger changes nothing */
      }
    }
  };
}
