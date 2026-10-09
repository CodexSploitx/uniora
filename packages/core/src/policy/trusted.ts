import type { Identity } from "../identity/types.js";
import type { UnioraStorage, UnioraTransaction } from "../storage/types.js";
import { issuePolicyAuthorization } from "./authorization.js";
import type { PolicyAuthorization, PolicyOperation } from "./authorization.js";
import { PolicyError } from "./errors.js";
import type { PolicyRepository } from "./repository.js";

/** Drops `authorization` from the last parameter; when nothing else in it is required, the parameter becomes optional. */
type StripAuthorization<A extends unknown[]> = A extends [...infer Head, infer Last]
  ? Last extends { authorization: PolicyAuthorization }
    ? {} extends Omit<Last, "authorization">
      ? [...Head, Omit<Last, "authorization">?]
      : [...Head, Omit<Last, "authorization">]
    : A
  : A;
type Trusted<R> = {
  [K in keyof R]: R[K] extends (...args: infer A) => infer Ret ? (...args: StripAuthorization<A>) => Ret : R[K];
};

/** `storage.policies` with the authorization filled in by the trusted wrapper. */
export type TrustedPolicyStorage = Omit<UnioraStorage, "policies" | "transaction"> & {
  policies: Trusted<PolicyRepository>;
  transaction<T>(callback: (tx: TrustedPolicyTransaction) => Promise<T>): Promise<T>;
};
export type TrustedPolicyTransaction = Omit<UnioraTransaction, "policies"> & { policies: Trusted<PolicyRepository> };

export interface TrustedPolicyStorageOptions {
  /** Who is making the changes (recorded in the audit log when the storage is audited). */
  actor: Identity;
  /** Why this code is allowed to skip the permission check: "import from the old rule engine", "nightly sync job". Required. */
  reason: string;
}

/**
 * Back-office access to the policy repository WITHOUT a permission check: for imports, migrations, sync jobs, tests and admin
 * tooling that run as the system, never in a request handler that serves end users (use `createPolicyService` there). Every
 * write is stamped with an authorization issued for exactly that organization and operation, so the storage accepts it; nothing
 * else about the rules changes (isolation, lifecycle, validation, versions). Wrap an audited storage with it to keep the trail.
 */
export function createTrustedPolicyStorage(storage: UnioraStorage, options: TrustedPolicyStorageOptions): TrustedPolicyStorage {
  if (typeof options?.reason !== "string" || options.reason.trim() === "") {
    throw new PolicyError("A trusted policy storage needs a reason saying why it skips the permission check.", "policy_invalid");
  }
  const { actor } = options;
  const token = (organizationId: string, operation: PolicyOperation): PolicyAuthorization =>
    issuePolicyAuthorization(organizationId, actor, [operation], { trusted: true });

  function wrap(scope: UnioraStorage | UnioraTransaction) {
    const { policies } = scope;
    return {
      policies: {
        ...policies,
        create: (input: Omit<Parameters<PolicyRepository["create"]>[0], "authorization">) =>
          policies.create({ ...input, authorization: token(input.organizationId, "policy.create") }),
        update: (organizationId: string, id: string, input: object) =>
          policies.update(organizationId, id, { ...(input as { actor: Identity }), authorization: token(organizationId, "policy.update") }),
        activate: (organizationId: string, id: string, input: { actor: Identity }) =>
          policies.activate(organizationId, id, { ...input, authorization: token(organizationId, "policy.activate") }),
        disable: (organizationId: string, id: string, input: { actor: Identity }) =>
          policies.disable(organizationId, id, { ...input, authorization: token(organizationId, "policy.disable") }),
        retire: (organizationId: string, id: string, input: { actor: Identity }) =>
          policies.retire(organizationId, id, { ...input, authorization: token(organizationId, "policy.retire") }),
        delete: (organizationId: string, id: string) => policies.delete(organizationId, id, { authorization: token(organizationId, "policy.delete") }),
      },
    };
  }

  const top = wrap(storage);
  return {
    ...storage,
    ...top,
    transaction: (callback: (tx: TrustedPolicyTransaction) => Promise<never>) =>
      storage.transaction((tx) => callback({ ...tx, ...wrap(tx) } as unknown as TrustedPolicyTransaction)),
  } as unknown as TrustedPolicyStorage;
}
