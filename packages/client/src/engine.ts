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
  // The server refused the question itself (malformed, or an organization this key may not reach, which answers like a missing one):
  // the answer is no, as the local engine's is.
  const malformed = (error: unknown): boolean => error instanceof UnioraApiError && (error.status === 400 || (error.status === 404 && error.code === "organization_not_found"));
  /** Only the two fields of an identity go out, and both must be there: a missing provider must not be completed by the server's default. */
  const who = (identity: unknown): { provider: string; subject: string } | undefined => {
    const value = identity as { provider?: unknown; subject?: unknown } | null | undefined;
    return typeof value?.provider === "string" && value.provider !== "" && typeof value.subject === "string" && value.subject !== "" ? { provider: value.provider, subject: value.subject } : undefined;
  };

  return {
    async can(input) {
      const identity = who(input?.identity);
      if (!identity) return false;
      try {
        const { allowed } = await client.decisions.check({
          identity,
          organizationId: input.organizationId,
          permission: input.permission,
          ...(input.teamId !== undefined ? { teamId: input.teamId } : {}),
        });
        return allowed === true;
      } catch (error) {
        report(error);
        if (malformed(error)) return false;
        throw error;
      }
    },

    access: {
      async check(input) {
        const identity = who(input?.identity);
        if (!identity) return false;
        try {
          const { allowed } = await client.decisions.check({
            identity,
            organizationId: input.organizationId,
            ...(input.permission !== undefined ? { permission: input.permission } : {}),
            ...(input.feature !== undefined ? { feature: input.feature } : {}),
            ...(input.teamId !== undefined ? { teamId: input.teamId } : {}),
          });
          return allowed === true;
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
        organizationId: String(input?.organizationId),
        permission: String(input?.permission),
        policyRevision: null,
        policies: [],
        evaluatedAt: new Date(),
      });
      const identity = who(input?.identity);
      if (!identity) return refused("malformed_input");
      try {
        const result = await client.decisions.authorize({
          identity,
          organizationId: input.organizationId,
          permission: input.permission,
          ...(input.teamId !== undefined ? { teamId: input.teamId } : {}),
          ...(input.resource !== undefined ? { resource: input.resource as never } : {}),
          ...(input.context !== undefined ? { context: input.context as never } : {}),
          ...(input.session !== undefined ? { session: input.session as never } : {}),
          ...(input.requireApplicablePolicy !== undefined ? { requireApplicablePolicy: input.requireApplicablePolicy } : {}),
        });
        // The decision and the flag must agree, and only a plain `true` with `allow` lets anything through.
        if (result.allowed !== (result.decision === "allow") || !["allow", "deny", "indeterminate"].includes(result.decision)) return refused("evaluation_error");
        return {
          decision: result.decision,
          allowed: result.allowed === true,
          reason: result.reason,
          organizationId: input.organizationId,
          permission: input.permission,
          ...(result.via !== undefined ? { via: result.via } : {}),
          policyRevision: result.policyRevision,
          ...(result.stepUp !== undefined ? { stepUp: { policyKeys: [...result.stepUp.policyKeys] } } : {}),
          policies: [],
          evaluatedAt: Number.isFinite(Date.parse(result.evaluatedAt)) ? new Date(result.evaluatedAt) : new Date(),
        };
      } catch (error) {
        report(error);
        return refused(malformed(error) ? "malformed_input" : "evaluation_error");
      }
    },
  };
}
