import type { Identity } from "../identity/types.js";
import { createAuthorizationEngine } from "../authorization/engine.js";
import type { AuthorizationEngine, AuthorizationEngineOptions } from "../authorization/engine.js";
import { createAuditedStorage } from "../storage/audited.js";
import type { UnioraStorage, UnioraTransaction } from "../storage/types.js";
import { issuePolicyAuthorization } from "./authorization.js";
import type { PolicyOperation } from "./authorization.js";
import type { AuthorizationResult, AuthorizeInput } from "./decider.js";
import { parsePolicyDefinition } from "./definition.js";
import type { ParsedPolicyDefinition } from "./definition.js";
import { PolicyError } from "./errors.js";
import type { ActivePolicySet, CreatePolicyInput, SearchPoliciesOptions, UpdatePolicyInput } from "./repository.js";
import type { Policy, PolicyRevision } from "./types.js";

/**
 * The permission keys the policy service asks the authorization engine about. Register them in your catalog and give them to the
 * roles that should administer policies; override any with `createPolicyService({ permissions })`. They are never subject to policies.
 */
export const POLICY_PERMISSIONS = {
  /** See policies, their revisions, and simulate a decision. */
  read: "policies.read",
  /** Create policies, edit drafts and disabled policies, change names and descriptions, delete drafts. */
  manage: "policies.manage",
  /** Put a policy live: activate, disable, retire, and change the definition of an ACTIVE policy. */
  activate: "policies.activate",
} as const;

export type PolicyPermissionKeys = { [K in keyof typeof POLICY_PERMISSIONS]: string };

export interface PolicyServiceOptions {
  storage: UnioraStorage;
  /** Passed to the engine the service builds (for example `ownerRequiresRegisteredPermission`). */
  engine?: AuthorizationEngineOptions;
  /** Replace any of the default permission keys. */
  permissions?: Partial<PolicyPermissionKeys>;
  /**
   * Separation of duties. When `true`, whoever wrote the current revision of a policy cannot activate it, and the definition of
   * an ACTIVE policy cannot be edited in place (disable it, edit it, and have someone else activate it). Off by default.
   */
  requireSeparateActivator?: boolean;
}

export interface PolicyActor {
  actor: Identity;
}

export interface SimulatePolicyInput extends PolicyActor {
  organizationId: string;
  /** The person the question is about (not necessarily the actor). */
  identity: Identity;
  permission: string;
  teamId?: string;
  resource?: AuthorizeInput["resource"];
  /** The `context.*` signals to pretend the request had (see `AuthorizeInput.context`). */
  context?: AuthorizeInput["context"];
  /** How the person authenticated to pretend they did (see `AuthorizeInput.session`), to test `sensitive` policies. */
  session?: AuthorizeInput["session"];
  /** The moment to pretend the question is asked at, for `environment.*` ("what happens on Saturday at 22:00?"). Defaults to now. */
  at?: Date;
  requireApplicablePolicy?: boolean;
  /**
   * Try a definition without saving it. With `policyId` it takes the place of that policy's definition (whatever its status,
   * even a draft or a disabled one) for this question; without it, it is added as one more active policy.
   */
  candidate?: { policyId?: string; definition: unknown };
}

/**
 * The ONLY sanctioned way to change policies on behalf of a user. Every operation asks the authorization engine first, inside the
 * same transaction as the change, and writes the audit entries with the actor:
 *
 * - Reading needs `policies.read`; writing a draft or a disabled policy needs `policies.manage`.
 * - Anything that changes what is enforced (activate, disable, retire, editing the definition of an active policy) also needs
 *   `policies.activate`, so authoring and publishing can be given to different people.
 * - Policy administration is never subject to policies, so a rule cannot lock anybody out of fixing the rules.
 *
 * It uses the plain repository underneath, which authorizes nothing: do not hand `storage.policies` to code that serves end users.
 */
export interface PolicyService {
  createPolicy(input: Omit<CreatePolicyInput, "authorization" | "createdBy"> & PolicyActor): Promise<Policy>;
  updatePolicy(input: { organizationId: string; policyId: string } & PolicyActor & Omit<UpdatePolicyInput, "authorization" | "actor">): Promise<Policy>;
  activatePolicy(input: { organizationId: string; policyId: string; reason?: string; expectedVersion?: number } & PolicyActor): Promise<Policy>;
  disablePolicy(input: { organizationId: string; policyId: string; reason?: string; expectedVersion?: number } & PolicyActor): Promise<Policy>;
  retirePolicy(input: { organizationId: string; policyId: string; reason?: string; expectedVersion?: number } & PolicyActor): Promise<Policy>;
  deletePolicy(input: { organizationId: string; policyId: string } & PolicyActor): Promise<void>;

  getPolicy(input: { organizationId: string; policyId: string } & PolicyActor): Promise<Policy>;
  listPolicies(input: Omit<SearchPoliciesOptions, "organizationId"> & { organizationId: string } & PolicyActor): Promise<Policy[]>;
  listRevisions(input: { organizationId: string; policyId: string; limit?: number; before?: number } & PolicyActor): Promise<PolicyRevision[]>;

  /** Checks a definition without saving anything: returns the normalized definition and what it reads, or throws `policy_definition_invalid`. */
  validate(input: { organizationId: string; definition: unknown } & PolicyActor): Promise<ParsedPolicyDefinition>;
  /** Answers "what would be decided?" for any member and any resource, optionally with a candidate definition. Writes nothing. */
  simulate(input: SimulatePolicyInput): Promise<AuthorizationResult>;
}

const forbidden = (what: string) => new PolicyError(`You are not allowed to ${what}.`, "policy_forbidden");

export function createPolicyService(options: PolicyServiceOptions): PolicyService {
  const keys: PolicyPermissionKeys = { ...POLICY_PERMISSIONS, ...options.permissions };

  interface Context {
    tx: UnioraTransaction;
    engine: AuthorizationEngine;
    actor: Identity;
  }

  /** Runs `work` in one transaction with an engine bound to that same transaction and an audited view that records the actor. */
  function run<T>(actor: Identity, work: (ctx: Context) => Promise<T>): Promise<T> {
    const audited = createAuditedStorage(options.storage, { actor });
    return audited.transaction(async (tx) => {
      const engine = createAuthorizationEngine({ ...tx, transaction: options.storage.transaction.bind(options.storage) } as UnioraStorage, options.engine);
      return work({ tx, engine, actor });
    });
  }

  // `can`, never `authorize`: the administration of policies is decided by roles alone.
  const has = (ctx: Context, organizationId: string, permission: string): Promise<boolean> =>
    ctx.engine.can({ identity: ctx.actor, organizationId, permission });

  async function require(ctx: Context, organizationId: string, permission: string, what: string): Promise<void> {
    if (!(await has(ctx, organizationId, permission))) throw forbidden(what);
  }

  const grant = (ctx: Context, organizationId: string, ...operations: PolicyOperation[]) => issuePolicyAuthorization(organizationId, ctx.actor, operations);

  async function load(ctx: Context, organizationId: string, policyId: string): Promise<Policy> {
    // A policy of another organization is the same as a missing one: the actor learns nothing about it.
    const policy = await ctx.tx.policies.findById(organizationId, policyId);
    if (!policy) throw new PolicyError(`Policy not found: ${policyId}`, "policy_not_found");
    return policy;
  }

  async function currentRevisionAuthor(ctx: Context, policy: Policy): Promise<Identity | undefined> {
    return (await ctx.tx.policies.findRevision(policy.organizationId, policy.id, policy.revision))?.createdBy;
  }

  /**
   * What was checked (status, author of the current revision) is only valid for the version that was read. Pinning the write to
   * that version means a concurrent change between the check and the write is a conflict, never a write that skipped a check.
   * A version the caller named has to be the one just read.
   */
  function pinVersion(policy: Policy, expectedVersion: number | undefined): number {
    if (expectedVersion !== undefined && expectedVersion !== policy.version) {
      throw new PolicyError(`The policy changed (version ${policy.version}, expected ${expectedVersion}).`, "policy_version_conflict");
    }
    return policy.version;
  }

  const same = (a: Identity, b: Identity) => a.provider === b.provider && a.subject === b.subject;

  async function assertSeparateActivator(ctx: Context, policy: Policy): Promise<void> {
    if (options.requireSeparateActivator !== true) return;
    const author = await currentRevisionAuthor(ctx, policy);
    if (author && same(author, ctx.actor)) {
      throw new PolicyError("With separation of duties on, the author of a revision cannot activate it; ask someone else.", "policy_separation_of_duties");
    }
  }

  return {
    createPolicy: ({ actor, ...input }) =>
      run(actor, async (ctx) => {
        await require(ctx, input.organizationId, keys.manage, "create policies");
        return ctx.tx.policies.create({ ...input, createdBy: actor, authorization: grant(ctx, input.organizationId, "policy.create") });
      }),

    updatePolicy: ({ actor, organizationId, policyId, ...change }) =>
      run(actor, async (ctx) => {
        await require(ctx, organizationId, keys.manage, "change this policy");
        const current = await load(ctx, organizationId, policyId);
        if (current.status === "active" && change.definition !== undefined) {
          // The definition of a live policy changes what is enforced: publishing rights are needed too.
          await require(ctx, organizationId, keys.activate, "change the definition of an active policy");
          if (options.requireSeparateActivator === true) {
            throw new PolicyError("With separation of duties on, an active policy cannot be edited in place; disable it, edit it, and have someone else activate it.", "policy_separation_of_duties");
          }
        }
        return ctx.tx.policies.update(organizationId, policyId, {
          ...change,
          actor,
          expectedVersion: pinVersion(current, change.expectedVersion),
          authorization: grant(ctx, organizationId, "policy.update"),
        });
      }),

    activatePolicy: ({ actor, organizationId, policyId, ...rest }) =>
      run(actor, async (ctx) => {
        await require(ctx, organizationId, keys.activate, "activate policies");
        const current = await load(ctx, organizationId, policyId);
        if (current.status !== "active") await assertSeparateActivator(ctx, current);
        return ctx.tx.policies.activate(organizationId, policyId, {
          ...rest,
          actor,
          expectedVersion: pinVersion(current, rest.expectedVersion),
          authorization: grant(ctx, organizationId, "policy.activate"),
        });
      }),

    disablePolicy: ({ actor, organizationId, policyId, ...rest }) =>
      run(actor, async (ctx) => {
        await require(ctx, organizationId, keys.activate, "disable policies");
        return ctx.tx.policies.disable(organizationId, policyId, { ...rest, actor, authorization: grant(ctx, organizationId, "policy.disable") });
      }),

    retirePolicy: ({ actor, organizationId, policyId, ...rest }) =>
      run(actor, async (ctx) => {
        await require(ctx, organizationId, keys.activate, "retire policies");
        return ctx.tx.policies.retire(organizationId, policyId, { ...rest, actor, authorization: grant(ctx, organizationId, "policy.retire") });
      }),

    deletePolicy: ({ actor, organizationId, policyId }) =>
      run(actor, async (ctx) => {
        await require(ctx, organizationId, keys.manage, "delete policies");
        await ctx.tx.policies.delete(organizationId, policyId, { authorization: grant(ctx, organizationId, "policy.delete") });
      }),

    getPolicy: ({ actor, organizationId, policyId }) =>
      run(actor, async (ctx) => {
        await require(ctx, organizationId, keys.read, "see policies");
        return load(ctx, organizationId, policyId);
      }),

    listPolicies: ({ actor, ...search }) =>
      run(actor, async (ctx) => {
        await require(ctx, search.organizationId, keys.read, "see policies");
        return ctx.tx.policies.search(search);
      }),

    listRevisions: ({ actor, organizationId, policyId, ...page }) =>
      run(actor, async (ctx) => {
        await require(ctx, organizationId, keys.read, "see policies");
        await load(ctx, organizationId, policyId);
        return ctx.tx.policies.revisions(organizationId, policyId, page);
      }),

    validate: ({ actor, organizationId, definition }) =>
      run(actor, async (ctx) => {
        await require(ctx, organizationId, keys.read, "check policies");
        return parsePolicyDefinition(definition);
      }),

    simulate: ({ actor, candidate, ...question }) =>
      run(actor, async (ctx) => {
        await require(ctx, question.organizationId, keys.read, "simulate decisions");
        const parsed = candidate ? parsePolicyDefinition(candidate.definition) : undefined;
        let candidatePolicy: Policy | undefined;
        if (candidate && parsed) {
          const stored = candidate.policyId !== undefined ? await load(ctx, question.organizationId, candidate.policyId) : undefined;
          const now = new Date();
          candidatePolicy = {
            id: stored?.id ?? "candidate",
            organizationId: question.organizationId,
            key: stored?.key ?? "candidate",
            name: stored?.name ?? "Candidate",
            kind: parsed.definition.kind,
            effect: parsed.definition.effect,
            status: "active",
            revision: stored ? stored.revision + 1 : 1,
            definition: parsed.definition,
            definitionHash: parsed.hash,
            createdAt: now,
            createdBy: actor,
            updatedAt: now,
            version: 1,
          };
        }
        // The same decider the engine uses, over a view of the storage whose active set has the candidate in it.
        const view: UnioraStorage = {
          ...ctx.tx,
          policies: {
            ...ctx.tx.policies,
            async activeSet(organizationId): Promise<ActivePolicySet> {
              const set = await ctx.tx.policies.activeSet(organizationId);
              if (!candidatePolicy) return set;
              const others = set.policies.filter((policy) => policy.id !== candidatePolicy!.id);
              return { revision: set.revision, policies: [...others, candidatePolicy] };
            },
          },
          transaction: options.storage.transaction.bind(options.storage),
        };
        // A simulation is not a decision anybody acts on: no `onDecision`, no cache.
        const simulator = createAuthorizationEngine(view, { ...options.engine, onDecision: undefined, policies: { ...options.engine?.policies, cache: false, ...(question.at !== undefined ? { now: () => question.at as Date } : {}) } });
        const { organizationId, identity, permission, teamId, resource, context, session, requireApplicablePolicy } = question;
        return simulator.authorize({
          organizationId,
          identity,
          permission,
          ...(teamId !== undefined ? { teamId } : {}),
          ...(resource !== undefined ? { resource } : {}),
          ...(context !== undefined ? { context } : {}),
          ...(session !== undefined ? { session } : {}),
          ...(requireApplicablePolicy !== undefined ? { requireApplicablePolicy } : {}),
        });
      }),
  };
}
