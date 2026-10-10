import { RESOURCE_ATTRIBUTES, SUBJECT_ATTRIBUTES, isBuiltinResourceAttribute, isEnvironmentAttribute, isProtectedPermission, isSubjectAttribute } from "./attributes.js";
import type { EnvironmentAttributeName, SubjectAttributeName } from "./attributes.js";
import { actionMatches } from "./definition.js";
import { DEFAULT_POLICY_TIMEZONE, environmentAt } from "./environment.js";
import type { PolicyAnalysis } from "./definition.js";
import type { AttributeType, AttributeValue, Comparison, Condition, Operand, PolicyDefinition, PolicyEffect } from "./types.js";

/** How much work one decision may do. A rule that needs more is "indeterminate", never silently skipped. */
export const MAX_EVALUATION_STEPS = 20_000;
/** The most active policies one organization can have (so one decision looks at a bounded set). */
export const MAX_ACTIVE_POLICIES = 200;
export const MAX_RESOURCE_ATTRIBUTES = 64;
export const MAX_RESOURCE_VALUE_LENGTH = 1000;
export const MAX_RESOURCE_LIST_ITEMS = 1000;
/** Teams of a resource whose ancestors are expanded for `resource.teamPathIds`; a resource in more teams is "unknown". */
export const MAX_RESOURCE_PATH_TEAMS = 50;
/** The most ids `resource.teamPathIds` holds (50 teams at the deepest nesting is 400); beyond it the attribute is "unknown". */
export const MAX_RESOURCE_PATH_IDS = 500;

/** The three results of an evaluation. `indeterminate` is never turned into an allow. */
export type Verdict = "allow" | "deny" | "indeterminate";

/** Why a part of a condition could not be decided. */
export type UnknownReason =
  | "resource_missing"
  | "attribute_missing"
  | "attribute_type_mismatch"
  | "subject_unavailable"
  | "team_tree_unavailable"
  | "environment_unavailable"
  | "feature_unavailable"
  | "permission_unavailable"
  | "budget_exceeded";

type Tri = "true" | "false" | "unknown";

/** The thing a request is about, as the host's own server code states it. It is never read from the end user's request. */
export interface ResourceFacts {
  id: string;
  /** Teams the resource belongs to. `[]` is a fact ("none"); leave it out when you do not know. */
  teamIds?: readonly string[];
  /** `teamIds` plus their ancestors, filled in by the engine (never by the host) when a policy reads `resource.teamPathIds`. */
  teamPathIds?: readonly string[];
  /** Values of the attributes the policies declare. Anything not declared by an applicable policy is ignored. */
  attributes?: Readonly<Record<string, unknown>>;
}

/** Everything a decision may read, resolved BEFORE evaluating. A fact that could not be resolved is `"unknown"`. */
export interface EvaluationFacts {
  subject: Partial<Record<SubjectAttributeName, AttributeValue>>;
  resource?: ResourceFacts;
  features: ReadonlyMap<string, boolean | "unknown">;
  permissions: ReadonlyMap<string, boolean | "unknown">;
  /** The instant of the decision in epoch milliseconds, from the engine's clock. Absent when the clock could not be read. */
  now?: number;
  /** The values of the `context` signals the host supplied. Anything not declared by an applicable policy is ignored. */
  context?: Readonly<Record<string, unknown>>;
}

export interface PolicyRequest {
  permission: string;
  /** The type of the resource the request is about, when there is one. */
  resourceType?: string;
}

/** A stored policy, as the evaluator needs it. */
export interface EvaluablePolicy {
  id: string;
  key: string;
  revision: number;
  definitionHash: string;
  definition: PolicyDefinition;
}

export interface PolicyOutcome {
  policyId: string;
  key: string;
  revision: number;
  definitionHash: string;
  effect: PolicyEffect;
  result: Verdict;
  /** On a deny: the policy's `denyReason`; on an indeterminate: why. Never holds attribute values. */
  reason?: string;
}

export interface PolicySetEvaluation {
  decision: Verdict;
  /** `allowed`, `policy_denied`, `policy_indeterminate` or `no_applicable_policy`. */
  reason: "allowed" | "policy_denied" | "policy_indeterminate" | "no_applicable_policy";
  outcomes: PolicyOutcome[];
}

/** Whether a policy takes part in a request: `yes`; `no` (another action or another type of resource); `unknown` (it is about a resource and the request names none). */
export type Applicability = "yes" | "no" | "unknown";

export function applicability(definition: PolicyDefinition, request: PolicyRequest): Applicability {
  if (!actionMatches(definition.actions, request.permission)) return "no";
  if (definition.resourceType === undefined) return "yes";
  if (request.resourceType === undefined) return "unknown";
  return definition.resourceType === request.resourceType ? "yes" : "no";
}

// ---------------------------------------------------------------------------------------------------------------------

const hasType = (value: unknown, type: AttributeType): boolean => {
  switch (type) {
    case "string":
      return typeof value === "string" && value.length <= MAX_RESOURCE_VALUE_LENGTH;
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "string[]":
      return Array.isArray(value) && value.length <= MAX_RESOURCE_LIST_ITEMS && value.every((item) => typeof item === "string" && item.length <= MAX_RESOURCE_VALUE_LENGTH);
    case "number[]":
      return Array.isArray(value) && value.length <= MAX_RESOURCE_LIST_ITEMS && value.every((item) => typeof item === "number" && Number.isFinite(item));
  }
};

type Resolved = { ok: true; value: AttributeValue } | { ok: false; reason: UnknownReason } | { ok: true; absent: true; value: undefined };

class Run {
  steps = 0;
  firstUnknown: UnknownReason | undefined;
  private environment: Record<EnvironmentAttributeName, number> | null | undefined;
  constructor(
    readonly definition: PolicyDefinition,
    readonly facts: EvaluationFacts,
    readonly limit: number,
  ) {}

  unknown(reason: UnknownReason): Tri {
    this.firstUnknown ??= reason;
    return "unknown";
  }

  /** The clock in this policy's timezone, computed once per run; `null` when it cannot be read. */
  private clock(): Record<EnvironmentAttributeName, number> | null {
    if (this.environment === undefined) {
      this.environment = this.facts.now === undefined ? null : environmentAt(this.facts.now, this.definition.timezone ?? DEFAULT_POLICY_TIMEZONE);
    }
    return this.environment;
  }

  resolveRef(ref: string): Resolved {
    if (isSubjectAttribute(ref)) {
      const value = this.facts.subject[ref];
      if (value === undefined) return { ok: false, reason: "subject_unavailable" };
      return hasType(value, SUBJECT_ATTRIBUTES[ref]) ? { ok: true, value } : { ok: false, reason: "attribute_type_mismatch" };
    }
    if (isEnvironmentAttribute(ref)) {
      const clock = this.clock();
      return clock === null ? { ok: false, reason: "environment_unavailable" } : { ok: true, value: clock[ref] };
    }
    if (ref.startsWith("context.")) {
      const name = ref.slice("context.".length);
      const contextSignals = this.definition.context;
      const declared = contextSignals !== undefined && Object.hasOwn(contextSignals, name) ? contextSignals[name] : undefined;
      if (declared === undefined) return { ok: false, reason: "attribute_missing" };
      const supplied = this.facts.context;
      const raw = supplied !== undefined && Object.hasOwn(supplied, name) ? supplied[name] : undefined;
      if (raw === undefined || raw === null) return { ok: true, absent: true, value: undefined };
      return hasType(raw, declared) ? { ok: true, value: raw as AttributeValue } : { ok: false, reason: "attribute_type_mismatch" };
    }
    const resource = this.facts.resource;
    if (resource === undefined) return { ok: false, reason: "resource_missing" };
    if (isBuiltinResourceAttribute(ref)) {
      const type = RESOURCE_ATTRIBUTES[ref as keyof typeof RESOURCE_ATTRIBUTES];
      let value: string | string[] | undefined;
      if (ref === "resource.id") value = resource.id;
      else if (ref === "resource.teamIds") value = resource.teamIds === undefined ? undefined : [...resource.teamIds];
      else if (resource.teamIds === undefined) value = undefined;
      else if (resource.teamPathIds === undefined) return { ok: false, reason: "team_tree_unavailable" };
      else value = [...resource.teamPathIds];
      if (value === undefined) return { ok: true, absent: true, value: undefined };
      return hasType(value, type) ? { ok: true, value: value as AttributeValue } : { ok: false, reason: "attribute_type_mismatch" };
    }
    const name = ref.slice("resource.".length);
    const attributes = this.definition.attributes;
    const declared = attributes !== undefined && Object.hasOwn(attributes, name) ? attributes[name] : undefined;
    if (declared === undefined) return { ok: false, reason: "attribute_missing" };
    const raw = resource.attributes !== undefined && Object.hasOwn(resource.attributes, name) ? resource.attributes[name] : undefined;
    if (raw === undefined || raw === null) return { ok: true, absent: true, value: undefined };
    return hasType(raw, declared) ? { ok: true, value: raw as AttributeValue } : { ok: false, reason: "attribute_type_mismatch" };
  }

  operand(operand: Operand): Resolved {
    if ("value" in operand) return { ok: true, value: operand.value };
    const resolved = this.resolveRef(operand.ref);
    if (resolved.ok && "absent" in resolved) return { ok: false, reason: "attribute_missing" };
    return resolved;
  }

  compare(op: Comparison, pair: readonly [Operand, Operand]): Tri {
    const left = this.operand(pair[0]);
    if (!left.ok) return this.unknown(left.reason);
    const right = this.operand(pair[1]);
    if (!right.ok) return this.unknown(right.reason);
    const a = left.value as AttributeValue;
    const b = right.value as AttributeValue;
    let result: boolean;
    switch (op) {
      case "eq":
        result = a === b;
        break;
      case "neq":
        result = a !== b;
        break;
      case "lt":
        result = (a as number) < (b as number);
        break;
      case "lte":
        result = (a as number) <= (b as number);
        break;
      case "gt":
        result = (a as number) > (b as number);
        break;
      case "gte":
        result = (a as number) >= (b as number);
        break;
      case "in":
        result = (b as Array<string | number>).includes(a as string | number);
        break;
      case "contains":
        result = (a as Array<string | number>).includes(b as string | number);
        break;
      case "intersects": {
        const set = new Set(a as Array<string | number>);
        result = (b as Array<string | number>).some((item) => set.has(item));
        break;
      }
    }
    return result ? "true" : "false";
  }

  evaluate(condition: Condition): Tri {
    if (++this.steps > this.limit) return this.unknown("budget_exceeded");
    if ("all" in condition) {
      let unknown = false;
      for (const child of condition.all) {
        const value = this.evaluate(child);
        if (value === "false") return "false";
        if (value === "unknown") unknown = true;
      }
      return unknown ? "unknown" : "true";
    }
    if ("any" in condition) {
      let unknown = false;
      for (const child of condition.any) {
        const value = this.evaluate(child);
        if (value === "true") return "true";
        if (value === "unknown") unknown = true;
      }
      return unknown ? "unknown" : "false";
    }
    if ("not" in condition) {
      const value = this.evaluate(condition.not);
      return value === "unknown" ? "unknown" : value === "true" ? "false" : "true";
    }
    if ("exists" in condition) {
      const resolved = this.resolveRef(condition.exists);
      if (!resolved.ok) return this.unknown(resolved.reason);
      return "absent" in resolved ? "false" : "true";
    }
    if ("feature" in condition) {
      const fact = this.facts.features.get(condition.feature);
      if (fact === undefined || fact === "unknown") return this.unknown("feature_unavailable");
      return fact ? "true" : "false";
    }
    if ("permission" in condition) {
      const fact = this.facts.permissions.get(condition.permission);
      if (fact === undefined || fact === "unknown") return this.unknown("permission_unavailable");
      return fact ? "true" : "false";
    }
    for (const op of Object.keys(condition) as Comparison[]) {
      const pair = (condition as Record<string, readonly [Operand, Operand]>)[op];
      if (pair !== undefined) return this.compare(op, pair);
    }
    // A condition the parser would never have produced (a stored row altered by hand): fail closed.
    return this.unknown("attribute_type_mismatch");
  }
}

/**
 * Evaluates ONE policy against facts that are already resolved. Pure: no I/O, no clock, no randomness.
 *
 * - The conditions use three-valued (Kleene) logic: `unknown` is never `true`, `all` with a false member is false even if
 *   another member is unknown, and `not unknown` is unknown.
 * - `deny` policy: condition true → deny; false → allow ("no objection"); unknown → indeterminate.
 * - `require` policy: condition true → allow; false → deny; unknown → indeterminate.
 *
 * `allow` here only means "this policy does not object". A policy can restrict, never grant.
 */
export function evaluatePolicy(policy: EvaluablePolicy, request: PolicyRequest, facts: EvaluationFacts, budget: { steps: number } = { steps: MAX_EVALUATION_STEPS }): PolicyOutcome | null {
  const { definition } = policy;
  const base = { policyId: policy.id, key: policy.key, revision: policy.revision, definitionHash: policy.definitionHash, effect: definition.effect };
  const applies = applicability(definition, request);
  if (applies === "no") return null;
  if (applies === "unknown") return { ...base, result: "indeterminate", reason: "resource_missing" };
  const run = new Run(definition, facts, budget.steps);
  const condition = run.evaluate(definition.condition);
  budget.steps = Math.max(0, budget.steps - run.steps);
  if (condition === "unknown") return { ...base, result: "indeterminate", reason: run.firstUnknown ?? "attribute_missing" };
  if (definition.effect === "deny") {
    return condition === "true" ? { ...base, result: "deny", reason: definition.denyReason ?? "policy_denied" } : { ...base, result: "allow" };
  }
  return condition === "true" ? { ...base, result: "allow" } : { ...base, result: "deny", reason: definition.denyReason ?? "policy_requirement_not_met" };
}

/**
 * The precedence rule, in one place. Deny overrides; failing that, indeterminate; failing that, allow. Nothing else
 * matters: not the order of the policies, not how many of them allow. No applicable policy is an allow here ("no
 * objection"): whether that is acceptable is the caller's call (`requireApplicablePolicy`).
 */
export function combineVerdicts(verdicts: readonly Verdict[]): Verdict {
  if (verdicts.includes("deny")) return "deny";
  if (verdicts.includes("indeterminate")) return "indeterminate";
  return "allow";
}

export interface EvaluatePolicySetOptions {
  /** A protected operation: with no applicable policy the answer is deny (`no_applicable_policy`). */
  requireApplicablePolicy?: boolean;
  maxSteps?: number;
}

/** Evaluates every applicable policy (in key order, so the trace is stable) and combines the outcomes with `combineVerdicts`. */
export function evaluatePolicySet(
  policies: readonly EvaluablePolicy[],
  request: PolicyRequest,
  facts: EvaluationFacts,
  options: EvaluatePolicySetOptions = {},
): PolicySetEvaluation {
  const budget = { steps: options.maxSteps ?? MAX_EVALUATION_STEPS };
  const outcomes: PolicyOutcome[] = [];
  if (isProtectedPermission(request.permission)) {
    // Policy administration is outside the reach of policies: nobody can lock themselves out of fixing them.
    return { decision: options.requireApplicablePolicy ? "deny" : "allow", reason: options.requireApplicablePolicy ? "no_applicable_policy" : "allowed", outcomes };
  }
  const ordered = [...policies].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  for (const policy of ordered) {
    const outcome = budget.steps <= 0 && applicability(policy.definition, request) !== "no"
      ? ({
          policyId: policy.id,
          key: policy.key,
          revision: policy.revision,
          definitionHash: policy.definitionHash,
          effect: policy.definition.effect,
          result: "indeterminate",
          reason: "budget_exceeded",
        } satisfies PolicyOutcome)
      : evaluatePolicy(policy, request, facts, budget);
    if (outcome) outcomes.push(outcome);
  }
  if (outcomes.length === 0 && options.requireApplicablePolicy) return { decision: "deny", reason: "no_applicable_policy", outcomes };
  const decision = combineVerdicts(outcomes.map((outcome) => outcome.result));
  return {
    decision,
    reason: decision === "allow" ? "allowed" : decision === "deny" ? "policy_denied" : "policy_indeterminate",
    outcomes,
  };
}

/** The facts the applicable policies of a request will read, so the engine loads only those. */
export interface RequiredFacts {
  features: string[];
  permissions: string[];
  subject: SubjectAttributeName[];
  /** Whether any of them reads the resource. */
  resource: boolean;
  /** Whether any of them reads `resource.teamPathIds`, which has to be derived from the team tree. */
  resourceTeamPath: boolean;
  /** Whether any of them reads `environment.*` (the clock). */
  environment: boolean;
  /** The `context.*` signals any of them reads, by name; the engine passes on only these. */
  context: string[];
}

export function requiredFacts(policies: ReadonlyArray<{ definition: PolicyDefinition; analysis: PolicyAnalysis }>, request: PolicyRequest): RequiredFacts {
  const features = new Set<string>();
  const permissions = new Set<string>();
  const subject = new Set<SubjectAttributeName>();
  let resource = false;
  let resourceTeamPath = false;
  let environment = false;
  const context = new Set<string>();
  for (const { definition, analysis } of policies) {
    if (applicability(definition, request) !== "yes") continue;
    for (const feature of analysis.features) features.add(feature);
    for (const permission of analysis.permissions) permissions.add(permission);
    for (const ref of analysis.subjectRefs) subject.add(ref as SubjectAttributeName);
    if (analysis.resourceRefs.length > 0) resource = true;
    if (analysis.resourceRefs.includes("resource.teamPathIds")) resourceTeamPath = true;
    if (analysis.environmentRefs.length > 0) environment = true;
    for (const ref of analysis.contextRefs) context.add(ref.slice("context.".length));
  }
  return { features: [...features].sort(), permissions: [...permissions].sort(), subject: [...subject].sort(), resource, resourceTeamPath, environment, context: [...context].sort() };
}
