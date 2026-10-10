import type { Identity } from "../identity/types.js";

/**
 * What a policy does when it applies to a request. A policy can only RESTRICT, never grant: there is no `allow` effect.
 *
 * - `deny`: the request is refused when the condition holds ("nobody edits a locked vehicle").
 * - `require`: the request is refused unless the condition holds ("only vehicles of your own branch").
 *
 * Both are the same rule seen from two sides (`require C` is `deny when not C`); having both keeps definitions readable.
 */
export const POLICY_EFFECTS = ["deny", "require"] as const;
export type PolicyEffect = (typeof POLICY_EFFECTS)[number];

/**
 * The taxonomy of policies. A kind is a label that is also checked against the definition (see `parsePolicyDefinition`), so
 * it cannot drift into meaning nothing:
 *
 * - `access`: who may reach the resource at all (membership, roles, team, nothing about the resource's state).
 * - `resource`: a condition on the state of the resource (needs a `resourceType`).
 * - `scope`: limits the resources a person reaches by comparing who they are with the resource (their teams with the resource's).
 * - `feature`: the action needs a Feature enabled for the organization.
 * - `contextual`: depends on WHEN or in WHAT CIRCUMSTANCES the request happens (`environment.*`: the engine's clock in the policy's
 *   timezone; `context.*`: signals your server verified and declares). It may also read the person and the resource.
 */
export const POLICY_KINDS = ["access", "resource", "scope", "feature", "contextual"] as const;
export type PolicyKind = (typeof POLICY_KINDS)[number];
/** Designed, not implemented yet: a definition using one is refused with a clear message instead of being half-supported. */
export const RESERVED_POLICY_KINDS = ["sensitive"] as const;

/**
 * - `draft`: being written; never evaluated; can be deleted.
 * - `active`: evaluated on every matching request.
 * - `disabled`: not evaluated; can be activated again.
 * - `retired`: not evaluated, kept for the record (decisions refer to it); it can never be activated again and its key is never reused.
 */
export const POLICY_STATUSES = ["draft", "active", "disabled", "retired"] as const;
export type PolicyStatus = (typeof POLICY_STATUSES)[number];

/** The only data types a condition handles. There is no coercion: a value of another type makes the decision indeterminate. */
export const ATTRIBUTE_TYPES = ["string", "number", "boolean", "string[]", "number[]"] as const;
export type AttributeType = (typeof ATTRIBUTE_TYPES)[number];

export type Scalar = string | number | boolean;
export type AttributeValue = Scalar | string[] | number[];

/** A literal or an attribute of the request. */
export type Operand = { readonly ref: string } | { readonly value: AttributeValue };

export const COMPARISONS = ["eq", "neq", "lt", "lte", "gt", "gte", "in", "contains", "intersects"] as const;
export type Comparison = (typeof COMPARISONS)[number];

/**
 * A condition is a tree of data, never code. Leaves compare two operands, test that an attribute exists, or ask for a
 * Feature or a Permission; `all`/`any`/`not` combine them. A leaf that cannot be decided is "unknown" and unknown never
 * counts as true (Kleene logic): see `evaluatePolicy`.
 */
export type Condition =
  | { readonly all: readonly Condition[] }
  | { readonly any: readonly Condition[] }
  | { readonly not: Condition }
  | { readonly exists: string }
  | { readonly feature: string }
  | { readonly permission: string }
  | { readonly [K in Comparison]: { readonly [P in K]: readonly [Operand, Operand] } }[Comparison];

export interface PolicyDefinition {
  kind: PolicyKind;
  effect: PolicyEffect;
  /** Permission keys the policy applies to: an exact key (`vehicles.update`), a prefix (`vehicles.*`) or `*` (every key outside the `policies.*` namespace). */
  actions: string[];
  /** The type of resource the condition is about; a request for another type does not match. Required to read `resource.*`. */
  resourceType?: string;
  /** The resource attributes the condition reads, with their type: the policy states what it needs, and nothing else is read. */
  attributes?: Record<string, AttributeType>;
  /**
   * The request-context signals the condition reads as `context.<name>` (`ipCountry`, `deviceManaged`), with their type. Your
   * server states them in `authorize({ context })` after verifying them; the end user's request never supplies them.
   */
  context?: Record<string, AttributeType>;
  /** The IANA timezone (`Europe/Madrid`) in which `environment.hour`, `dayOfWeek`... are computed. Defaults to `UTC`. */
  timezone?: string;
  condition: Condition;
  /** A short machine code returned when this policy denies (`vehicle_locked`). Defaults to `policy_denied`. */
  denyReason?: string;
}

export interface PolicyStatusChange {
  readonly at: Date;
  readonly by: Identity;
  readonly reason?: string;
}

/** An immutable version of a policy's definition. Decisions record the revision they used. */
export interface PolicyRevision {
  readonly policyId: string;
  readonly organizationId: string;
  /** 1, 2, 3... */
  readonly revision: number;
  readonly definition: PolicyDefinition;
  /** SHA-256 of the canonical JSON of the definition: two revisions with the same hash are the same rule. */
  readonly definitionHash: string;
  readonly createdAt: Date;
  readonly createdBy: Identity;
  readonly note?: string;
}

/**
 * A conditional authorization rule of ONE organization. It never grants anything: it narrows what the Authorization Engine
 * would otherwise allow.
 */
export interface Policy {
  readonly id: string;
  /** The only organization this policy exists in and applies to. */
  readonly organizationId: string;
  /** Stable handle, unique in the organization for all time (a retired policy keeps its key). */
  readonly key: string;
  name: string;
  description?: string;
  readonly kind: PolicyKind;
  readonly effect: PolicyEffect;
  status: PolicyStatus;
  /** The revision of `definition` (starts at 1; goes up when the definition changes). This is what a decision records. */
  readonly revision: number;
  readonly definition: PolicyDefinition;
  readonly definitionHash: string;
  readonly createdAt: Date;
  readonly createdBy: Identity;
  readonly updatedAt: Date;
  /** The last time the policy became active, disabled or retired. */
  readonly statusChange?: PolicyStatusChange;
  /** When the policy first became active; absent for a draft. A policy that has been active can no longer be deleted. */
  readonly activatedAt?: Date;
  /** Starts at 1 and goes up on every change (metadata, definition, status). Pass it back as `expectedVersion`. */
  readonly version: number;
}
