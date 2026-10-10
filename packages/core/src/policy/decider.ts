import type { Identity } from "../identity/types.js";
import type { Membership } from "../membership/types.js";
import type { UnioraStorage } from "../storage/types.js";
import { MAX_SUBJECT_TEAMS } from "../team/repository.js";
import { isProtectedPermission } from "./attributes.js";
import type { SubjectAttributeName } from "./attributes.js";
import { actionMatches, parsePolicyDefinition } from "./definition.js";
import type { PolicyAnalysis } from "./definition.js";
import {
  MAX_ACTIVE_POLICIES,
  MAX_EVALUATION_STEPS,
  MAX_RESOURCE_ATTRIBUTES,
  MAX_RESOURCE_LIST_ITEMS,
  MAX_RESOURCE_PATH_IDS,
  MAX_RESOURCE_PATH_TEAMS,
  combineVerdicts,
  evaluatePolicySet,
  requiredFacts,
} from "./evaluate.js";
import type { EvaluablePolicy, EvaluationFacts, PolicyOutcome, ResourceFacts, Verdict } from "./evaluate.js";
import type { Policy } from "./types.js";

/** The thing the question is about. Your server code states it; never build it from what the end user sent. */
export interface AuthorizeResource {
  /** What kind of resource this is (`vehicle`, `ticket`): policies are matched on it. */
  type: string;
  id: string;
  /** The organization the resource belongs to, as YOUR database says. Compared with `organizationId` before anything else. */
  organizationId: string;
  /** The teams the resource belongs to. `[]` means none; leave it out when unknown. */
  teamIds?: readonly string[];
  /** The values of the attributes policies declare (`status`, `ownerIdentity`...), read from your database. */
  attributes?: Readonly<Record<string, unknown>>;
}

export interface AuthorizeInput {
  identity: Identity;
  organizationId: string;
  permission: string;
  /** The team context of the permission check, with the same meaning as `CanInput.teamId`. */
  teamId?: string;
  resource?: AuthorizeResource;
  /**
   * Signals about the circumstances of the request that YOUR server verified (`{ ipCountry: "ES", deviceManaged: true }`),
   * read by `contextual` policies as `context.<name>`. Only the signals a policy declares are used. Never copy values from the
   * end user's request: a user can put anything in a header or a body. A signal that is missing makes the policy that needs it
   * indeterminate, which refuses. The time is not a signal: the engine reads its own clock (`environment.*`).
   */
  context?: Readonly<Record<string, unknown>>;
  /** A protected operation: with no applicable policy the answer is deny (`no_applicable_policy`). */
  requireApplicablePolicy?: boolean;
}

/**
 * Why the answer is what it is. These codes are part of the public API (only ever added).
 *
 * - `allowed`
 * - `malformed_input`: the identity, the organization, the permission key or the shape of the resource is not valid.
 * - `cross_tenant_resource`: the resource belongs to another organization.
 * - `organization_inactive`, `membership_inactive`, `permission_denied`: the mandatory checks said no (policies were not evaluated).
 * - `policy_denied`: a policy denied. `policy_indeterminate`: a policy could not be decided. `no_applicable_policy`: one was required and none applied.
 * - `evaluation_error`: something failed while deciding (a storage error). `policy_set_too_large`: the organization has more active policies than allowed.
 */
export type AuthorizationReason =
  | "allowed"
  | "malformed_input"
  | "cross_tenant_resource"
  | "organization_inactive"
  | "membership_inactive"
  | "permission_denied"
  | "policy_denied"
  | "policy_indeterminate"
  | "no_applicable_policy"
  | "evaluation_error"
  | "policy_set_too_large";

export interface AuthorizationResult {
  /** `allow`, `deny` or `indeterminate`. Only `allow` lets the operation go on. */
  decision: Verdict;
  /** `decision === "allow"`. Check this, not the absence of an exception. */
  allowed: boolean;
  reason: AuthorizationReason;
  organizationId: string;
  permission: string;
  /** What granted the permission (when the mandatory checks were reached and passed). */
  via?: "membership" | "support_grant";
  /** The policy-set revision the decision used; `null` when no policy was consulted. Key any cache of decisions on it. */
  policyRevision: number | null;
  /** Every policy that applied, with the revision and hash it was at and what it said. Empty when none applied. */
  policies: PolicyOutcome[];
  evaluatedAt: Date;
}

export interface PolicyDeciderOptions {
  /** Cache the compiled policies of each organization against its policy-set revision. On by default. */
  cache?: boolean;
  /** The evaluation step budget of one decision (default 20,000). */
  maxEvaluationSteps?: number;
  /** The clock for `environment.*` (default `() => new Date()`). Only for tests and simulations; a clock that throws makes those policies indeterminate. */
  now?: () => Date;
  /** Called with whatever made a decision `evaluation_error` (log it). Errors thrown by the hook are ignored. */
  onError?: (error: unknown) => void;
}

/** What the engine's own checks found. */
interface BaseResult {
  allowed: boolean;
  via?: "membership" | "support_grant";
  reason?: "malformed_input" | "organization_inactive" | "membership_inactive" | "permission_denied";
  membership?: Membership;
}

interface CanLikeInput {
  identity: Identity;
  organizationId: string;
  permission: string;
  teamId?: string;
}

interface DeciderDeps {
  storage: UnioraStorage;
  options?: PolicyDeciderOptions;
  /** The role-based decision (mandatory checks). */
  base: (input: CanLikeInput) => Promise<BaseResult>;
  /** Whether the identity holds another permission (for the `permission` predicate), with the same team context. */
  teamAllows: (input: CanLikeInput) => Promise<boolean>;
}

type Compiled =
  | { valid: true; evaluable: EvaluablePolicy; analysis: PolicyAnalysis }
  | { valid: false; policy: Policy; actions?: string[]; resourceType?: string };

interface CachedSet {
  revision: number;
  compiled: Compiled[];
  tooLarge: boolean;
}

const MAX_CACHED_ORGANIZATIONS = 1000;
const MAX_FACT_LOOKUPS_PER_DECISION = 64;
const RESOURCE_TYPE_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/;
const ATTRIBUTE_NAME_PATTERN = /^[a-z][A-Za-z0-9_]{0,63}$/;

/** Only the named own properties, so the evaluator never sees more than the policies declared. */
function pick(values: Record<string, unknown>, names: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const name of names) if (Object.hasOwn(values, name)) out[name] = values[name];
  return out;
}

const isText = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max;

function isIdentity(value: unknown): value is Identity {
  if (typeof value !== "object" || value === null) return false;
  const { provider, subject } = value as Record<string, unknown>;
  return isText(provider, 500) && isText(subject, 500);
}

/** Copies host-supplied values into a plain object without calling any getter, or returns `undefined` when the shape is not acceptable. */
function readValues(raw: unknown): Record<string, unknown> | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const names = Object.keys(raw);
  if (names.length > MAX_RESOURCE_ATTRIBUTES) return undefined;
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const name of names) {
    if (!ATTRIBUTE_NAME_PATTERN.test(name)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(raw, name);
    if (!descriptor || !("value" in descriptor)) return undefined;
    const value = descriptor.value as unknown;
    // Arrays are copied so the evaluator never sees a live object; everything else is a primitive or ignored as a mismatch later.
    out[name] = Array.isArray(value) ? (value.length <= MAX_RESOURCE_LIST_ITEMS ? [...(value as unknown[])] : Symbol("too-long")) : value;
  }
  return out;
}

/** Reads the resource the host passed into plain data, without calling any getter, or reports why it cannot be used. */
function readResource(resource: unknown): { ok: true; facts: ResourceFacts & { type: string; organizationId: string } } | { ok: false } {
  if (typeof resource !== "object" || resource === null || Array.isArray(resource)) return { ok: false };
  const source = resource as Record<string, unknown>;
  const read = (name: string): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(source, name);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  };
  const type = read("type");
  const id = read("id");
  const organizationId = read("organizationId");
  if (!isText(type, 64) || !RESOURCE_TYPE_PATTERN.test(type) || !isText(id, 200) || !isText(organizationId, 200)) return { ok: false };

  let teamIds: string[] | undefined;
  const rawTeams = read("teamIds");
  if (rawTeams !== undefined) {
    if (!Array.isArray(rawTeams) || rawTeams.length > MAX_RESOURCE_LIST_ITEMS || !rawTeams.every((item) => isText(item, 200))) return { ok: false };
    teamIds = [...(rawTeams as string[])];
  }

  const rawAttributes = read("attributes");
  const attributes = rawAttributes === undefined ? (Object.create(null) as Record<string, unknown>) : readValues(rawAttributes);
  if (attributes === undefined) return { ok: false };
  return { ok: true, facts: { type, id, organizationId, ...(teamIds !== undefined ? { teamIds } : {}), attributes } };
}

/** The part of a stored definition that can be read without trusting it: used only to decide whether a broken policy is in scope. */
function tolerantScope(policy: Policy): { actions?: string[]; resourceType?: string } {
  const raw = policy.definition as unknown as { actions?: unknown; resourceType?: unknown } | null;
  const actions = Array.isArray(raw?.actions) && raw.actions.every((item) => typeof item === "string") ? (raw.actions as string[]) : undefined;
  const resourceType = typeof raw?.resourceType === "string" ? raw.resourceType : undefined;
  return { ...(actions !== undefined ? { actions } : {}), ...(resourceType !== undefined ? { resourceType } : {}) };
}

function compile(policy: Policy): Compiled {
  try {
    const parsed = parsePolicyDefinition(policy.definition);
    // A stored row whose hash does not match its definition was changed behind the repository's back.
    if (parsed.hash !== policy.definitionHash) return { valid: false, policy, ...tolerantScope(policy) };
    return {
      valid: true,
      analysis: parsed.analysis,
      evaluable: { id: policy.id, key: policy.key, revision: policy.revision, definitionHash: policy.definitionHash, definition: parsed.definition },
    };
  } catch {
    return { valid: false, policy, ...tolerantScope(policy) };
  }
}

export interface PolicyDecider {
  authorize(input: AuthorizeInput): Promise<AuthorizationResult>;
}

export function createPolicyDecider(deps: DeciderDeps): PolicyDecider {
  const { storage } = deps;
  const useCache = deps.options?.cache !== false;
  const cache = new Map<string, CachedSet>();

  async function loadSet(organizationId: string): Promise<CachedSet> {
    if (useCache) {
      const current = await storage.policies.setRevision(organizationId);
      const hit = cache.get(organizationId);
      if (hit && hit.revision === current) return hit;
    }
    // The revision is read BEFORE the policies, so what is cached is never older than its revision.
    const set = await storage.policies.activeSet(organizationId);
    const entry: CachedSet = {
      revision: set.revision,
      compiled: set.policies.slice(0, MAX_ACTIVE_POLICIES).map(compile),
      tooLarge: set.policies.length > MAX_ACTIVE_POLICIES,
    };
    if (useCache) {
      cache.delete(organizationId);
      cache.set(organizationId, entry);
      if (cache.size > MAX_CACHED_ORGANIZATIONS) cache.delete(cache.keys().next().value as string);
    }
    return entry;
  }

  async function subjectFacts(membership: Membership | undefined, needed: SubjectAttributeName[], organizationId: string): Promise<EvaluationFacts["subject"]> {
    const subject: EvaluationFacts["subject"] = {};
    if (!membership) return subject;
    for (const name of needed) {
      try {
        switch (name) {
          case "subject.membershipId":
            subject[name] = membership.id;
            break;
          case "subject.membershipStatus":
            subject[name] = membership.status;
            break;
          case "subject.identity":
            subject[name] = `${membership.identity.provider}:${membership.identity.subject}`;
            break;
          case "subject.roleKeys": {
            const roles = await storage.roles.findByIds(membership.roleIds);
            subject[name] = roles.filter((role) => role.organizationId === organizationId).map((role) => role.key);
            break;
          }
          case "subject.managedTeamIds": {
            const ids = await storage.teamMemberships.activeTeamIds(organizationId, membership.id, { limit: MAX_SUBJECT_TEAMS + 1, responsibilities: ["owner", "manager"] });
            if (ids.length <= MAX_SUBJECT_TEAMS) subject[name] = ids;
            break;
          }
          case "subject.teamIds": {
            const ids = await storage.teamMemberships.activeTeamIds(organizationId, membership.id, { limit: MAX_SUBJECT_TEAMS + 1 });
            // A member in more teams than we can list is not "in these teams only": leave it unknown.
            if (ids.length <= MAX_SUBJECT_TEAMS) subject[name] = ids;
            break;
          }
        }
      } catch {
        /* the attribute stays unavailable and the policies that read it become indeterminate */
      }
    }
    return subject;
  }

  /** `teamIds` plus their ancestors, or `undefined` when it cannot be known (the policies that read it become indeterminate). */
  async function teamPath(organizationId: string, teamIds: readonly string[] | undefined): Promise<string[] | undefined> {
    if (teamIds === undefined) return undefined;
    if (teamIds.length === 0) return [];
    if (new Set(teamIds).size > MAX_RESOURCE_PATH_TEAMS) return undefined;
    try {
      const ids = await storage.teams.pathIds(organizationId, teamIds, { limit: MAX_RESOURCE_PATH_IDS + 1 });
      return ids.length <= MAX_RESOURCE_PATH_IDS ? ids : undefined;
    } catch {
      return undefined;
    }
  }

  async function lookups(input: AuthorizeInput, needs: { features: string[]; permissions: string[] }): Promise<Pick<EvaluationFacts, "features" | "permissions">> {
    const features = new Map<string, boolean | "unknown">();
    const permissions = new Map<string, boolean | "unknown">();
    let budget = MAX_FACT_LOOKUPS_PER_DECISION;
    await Promise.all([
      ...needs.features.map(async (key) => {
        if (budget-- <= 0) return void features.set(key, "unknown");
        try {
          features.set(key, await storage.features.isEnabled(input.organizationId, key));
        } catch {
          features.set(key, "unknown");
        }
      }),
      ...needs.permissions.map(async (key) => {
        if (budget-- <= 0) return void permissions.set(key, "unknown");
        try {
          const allowed = await deps.teamAllows({
            identity: input.identity,
            organizationId: input.organizationId,
            permission: key,
            ...(input.teamId !== undefined ? { teamId: input.teamId } : {}),
          });
          permissions.set(key, allowed);
        } catch {
          permissions.set(key, "unknown");
        }
      }),
    ]);
    return { features, permissions };
  }

  /** The instant of the decision for `environment.*`, or nothing when the clock cannot be read (those policies become indeterminate). */
  function clockFact(): { now?: number } {
    try {
      const at = (deps.options?.now ?? (() => new Date()))().getTime();
      return Number.isFinite(at) ? { now: at } : {};
    } catch {
      return {};
    }
  }

  async function decide(input: AuthorizeInput, now: Date): Promise<AuthorizationResult> {
    const permission = typeof input.permission === "string" ? input.permission : "";
    const organizationId = typeof input.organizationId === "string" ? input.organizationId : "";
    const finish = (decision: Verdict, reason: AuthorizationReason, extra: Partial<AuthorizationResult> = {}): AuthorizationResult => ({
      decision,
      allowed: decision === "allow",
      reason,
      organizationId,
      permission,
      policyRevision: null,
      policies: [],
      evaluatedAt: now,
      ...extra,
    });

    if (!isIdentity(input.identity) || !isText(input.organizationId, 200) || typeof input.permission !== "string") return finish("deny", "malformed_input");
    if (input.teamId !== undefined && !isText(input.teamId, 200)) return finish("deny", "malformed_input");

    let resource: ReturnType<typeof readResource> | undefined;
    if (input.resource !== undefined) {
      resource = readResource(input.resource);
      if (!resource.ok) return finish("deny", "malformed_input");
      // Mandatory, before anything else and whatever the policies say: a resource of another organization is never reachable.
      if (resource.facts.organizationId !== input.organizationId) return finish("deny", "cross_tenant_resource");
    }

    const base = await deps.base({
      identity: input.identity,
      organizationId: input.organizationId,
      permission: input.permission,
      ...(input.teamId !== undefined ? { teamId: input.teamId } : {}),
    });
    if (!base.allowed) return finish("deny", base.reason ?? "permission_denied");
    const via = base.via;

    // Policy administration is outside the reach of policies (a rule can never lock anybody out of fixing the rules).
    if (isProtectedPermission(input.permission)) {
      if (input.requireApplicablePolicy === true) return finish("deny", "no_applicable_policy", { ...(via ? { via } : {}) });
      return finish("allow", "allowed", { ...(via ? { via } : {}) });
    }

    const set = await loadSet(input.organizationId);
    if (set.tooLarge) return finish("indeterminate", "policy_set_too_large", { ...(via ? { via } : {}), policyRevision: set.revision });

    let context: Record<string, unknown> | undefined;
    if (input.context !== undefined) {
      context = readValues(input.context);
      if (context === undefined) return finish("deny", "malformed_input");
    }

    const request = { permission: input.permission, ...(resource?.ok ? { resourceType: resource.facts.type } : {}) };
    const valid = set.compiled.filter((entry): entry is Extract<Compiled, { valid: true }> => entry.valid);
    const broken = set.compiled.filter((entry): entry is Extract<Compiled, { valid: false }> => !entry.valid);

    const needs = requiredFacts(valid.map((entry) => ({ definition: entry.evaluable.definition, analysis: entry.analysis })), request);
    const teamPathIds = resource?.ok && needs.resourceTeamPath ? await teamPath(input.organizationId, resource.facts.teamIds) : undefined;
    const facts: EvaluationFacts = {
      subject: await subjectFacts(base.membership, needs.subject, input.organizationId),
      ...(resource?.ok
        ? {
            resource: {
              id: resource.facts.id,
              ...(resource.facts.teamIds !== undefined ? { teamIds: resource.facts.teamIds } : {}),
              ...(teamPathIds !== undefined ? { teamPathIds } : {}),
              attributes: resource.facts.attributes ?? {},
            },
          }
        : {}),
      ...(needs.environment ? clockFact() : {}),
      ...(context !== undefined && needs.context.length > 0 ? { context: pick(context, needs.context) } : {}),
      ...(await lookups(input, needs)),
    };

    const evaluation = evaluatePolicySet(
      valid.map((entry) => entry.evaluable),
      request,
      facts,
      { maxSteps: deps.options?.maxEvaluationSteps ?? MAX_EVALUATION_STEPS },
    );

    // A stored policy that no longer validates cannot say what it wants: it blocks whatever it might cover.
    const outcomes: PolicyOutcome[] = [...evaluation.outcomes];
    for (const entry of broken) {
      const inScope =
        entry.actions === undefined
          ? true
          : actionMatches(entry.actions, input.permission) && (entry.resourceType === undefined || (resource?.ok ? entry.resourceType === resource.facts.type : true));
      if (inScope) {
        outcomes.push({
          policyId: entry.policy.id,
          key: entry.policy.key,
          revision: entry.policy.revision,
          definitionHash: entry.policy.definitionHash,
          effect: entry.policy.effect,
          result: "indeterminate",
          reason: "policy_definition_invalid",
        });
      }
    }
    outcomes.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

    if (outcomes.length === 0 && input.requireApplicablePolicy === true) {
      return finish("deny", "no_applicable_policy", { ...(via ? { via } : {}), policyRevision: set.revision });
    }
    const decision = combineVerdicts(outcomes.map((outcome) => outcome.result));
    const reason: AuthorizationReason = decision === "allow" ? "allowed" : decision === "deny" ? "policy_denied" : "policy_indeterminate";
    return finish(decision, reason, { ...(via ? { via } : {}), policyRevision: set.revision, policies: outcomes });
  }

  return {
    async authorize(input) {
      const now = new Date();
      try {
        return await decide(input ?? ({} as AuthorizeInput), now);
      } catch (error) {
        try {
          deps.options?.onError?.(error);
        } catch {
          /* a failing logger changes nothing */
        }
        const safe = (value: unknown): string => (typeof value === "string" ? value : "");
        return {
          decision: "indeterminate",
          allowed: false,
          reason: "evaluation_error",
          organizationId: safe(input?.organizationId),
          permission: safe(input?.permission),
          policyRevision: null,
          policies: [],
          evaluatedAt: now,
        };
      }
    },
  };
}

