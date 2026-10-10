import type { AuthorizationEngine, AuthorizationReason, AuthorizationResult } from "@uniora/core";
import type { UnioraClient } from "./client.js";
import { UnioraApiError } from "./errors.js";

export interface RemoteEngineOptions {
  /** Called with whatever made a decision fail (a network error, a refused key). Log it; throwing from it is ignored. */
  readonly onError?: (error: unknown) => void;
}

/**
 * An `AuthorizationEngine` that asks a UNIORA server, so `@uniora/express` and `@uniora/next` guards (and anything written
 * against the engine) work unchanged when the engine lives in another process:
 *
 * ```ts
 * const engine = createRemoteEngine(createUnioraClient({ baseUrl, apiKey }));
 * app.delete("/vehicles/:id", requirePermission(engine, { permission: "vehicles.delete", resolve }), handler);
 * ```
 *
 * It fails closed. `authorize()` never throws, like the local one: anything it cannot answer is `indeterminate`, which is not
 * allowed. `can()` and `access.check()` answer `false` for input the server refuses as malformed, and throw when the server could
 * not be asked at all (so a guard turns an outage into an error, never into a silent allow).
 *
 * The answers do not include the per-policy detail (`policies` is empty): the API gives the decision, the reason and `stepUp`.
 * Your key needs the `check` scope.
 */
export function createRemoteEngine(client: UnioraClient, options: RemoteEngineOptions = {}): AuthorizationEngine {
  const report = (error: unknown) => {
    try {
      options.onError?.(error);
    } catch {
      // a failing logger never changes the decision
    }
  };
  const malformed = (error: unknown): boolean => error instanceof UnioraApiError && error.status === 400;

  return {
    async can(input) {
      try {
        const { allowed } = await client.decisions.check({
          identity: input.identity,
          organizationId: input.organizationId,
          permission: input.permission,
          ...(input.teamId !== undefined ? { teamId: input.teamId } : {}),
        });
        return allowed;
      } catch (error) {
        report(error);
        if (malformed(error)) return false;
        throw error;
      }
    },

    access: {
      async check(input) {
        try {
          const { allowed } = await client.decisions.check({
            identity: input.identity,
            organizationId: input.organizationId,
            ...(input.permission !== undefined ? { permission: input.permission } : {}),
            ...(input.feature !== undefined ? { feature: input.feature } : {}),
            ...(input.teamId !== undefined ? { teamId: input.teamId } : {}),
          });
          return allowed;
        } catch (error) {
          report(error);
          if (malformed(error)) return false;
          throw error;
        }
      },
    },

    async authorize(input) {
      const refused = (reason: AuthorizationReason): AuthorizationResult => ({
        decision: reason === "malformed_input" ? "deny" : "indeterminate",
        allowed: false,
        reason,
        organizationId: input.organizationId,
        permission: input.permission,
        policyRevision: null,
        policies: [],
        evaluatedAt: new Date(),
      });
      try {
        const result = await client.decisions.authorize({
          identity: input.identity,
          organizationId: input.organizationId,
          permission: input.permission,
          ...(input.teamId !== undefined ? { teamId: input.teamId } : {}),
          ...(input.resource !== undefined ? { resource: input.resource as never } : {}),
          ...(input.context !== undefined ? { context: input.context as never } : {}),
          ...(input.session !== undefined ? { session: input.session as never } : {}),
          ...(input.requireApplicablePolicy !== undefined ? { requireApplicablePolicy: input.requireApplicablePolicy } : {}),
        });
        return {
          decision: result.decision,
          allowed: result.allowed,
          reason: result.reason,
          organizationId: input.organizationId,
          permission: input.permission,
          ...(result.via !== undefined ? { via: result.via } : {}),
          policyRevision: result.policyRevision,
          ...(result.stepUp !== undefined ? { stepUp: { policyKeys: [...result.stepUp.policyKeys] } } : {}),
          policies: [],
          evaluatedAt: new Date(result.evaluatedAt),
        };
      } catch (error) {
        report(error);
        return refused(malformed(error) ? "malformed_input" : "evaluation_error");
      }
    },
  };
}
