import type { Identity } from "../identity/types.js";
import type { PolicyAuthorization } from "./authorization.js";
import {
  assertValidPolicyKey,
  parsePolicyDefinition,
  sanitizePolicyDescription,
  sanitizePolicyName,
  sanitizePolicyNote,
} from "./definition.js";
import type { ParsedPolicyDefinition } from "./definition.js";
import { PolicyError } from "./errors.js";
import type { Policy, PolicyEffect, PolicyKind, PolicyRevision, PolicyStatus } from "./types.js";
import { POLICY_EFFECTS, POLICY_KINDS, POLICY_STATUSES } from "./types.js";

/** Policies of one organization, in any status. */
export const MAX_POLICIES_PER_ORGANIZATION = 1000;
/** Definition revisions kept for one policy. */
export const MAX_POLICY_REVISIONS = 1000;
export const MAX_POLICY_PAGE = 200;
export const DEFAULT_POLICY_PAGE = 50;

export interface CreatePolicyInput {
  authorization: PolicyAuthorization;
  id: string;
  /** The organization the policy belongs to, forever. */
  organizationId: string;
  key: string;
  name: string;
  description?: string;
  /** Untrusted: it is parsed and normalized by `parsePolicyDefinition`; what is stored is the normalized form. */
  definition: unknown;
  createdBy: Identity;
  /** Why this version exists (the revision note). */
  note?: string;
  now?: Date;
}

export interface UpdatePolicyInput {
  authorization: PolicyAuthorization;
  actor: Identity;
  name?: string;
  /** `null` clears it. */
  description?: string | null;
  /** A new definition creates a new revision (unless it is identical to the current one). */
  definition?: unknown;
  /** Why the definition changed; kept with the revision. */
  note?: string;
  expectedVersion?: number;
}

export interface ChangePolicyStatusInput {
  authorization: PolicyAuthorization;
  actor: Identity;
  reason?: string;
  expectedVersion?: number;
}

export interface SearchPoliciesOptions {
  /** Policies are always listed within ONE organization. */
  organizationId: string;
  status?: PolicyStatus;
  kind?: PolicyKind;
  effect?: PolicyEffect;
  /** Case-insensitive substring of the key or the name. */
  query?: string;
  limit?: number;
  /** Keyset cursor: the `id` of the last policy of the previous page; results are ordered by `id`. */
  after?: string;
}

export interface ActivePolicySet {
  /** The policy-set revision of the organization when the policies were read. */
  revision: number;
  /** Active policies of the organization, at most `MAX_ACTIVE_POLICIES + 1` (one more than allowed means the limit was bypassed and the engine fails closed). */
  policies: Policy[];
}

/**
 * Every method takes the organization id and treats a policy of ANOTHER organization exactly like one that does not exist.
 * Writes demand a `PolicyAuthorization`; use `createPolicyService` for anything driven by a user.
 */
export interface PolicyRepository {
  /** Creates a `draft`. Rejects an unknown organization, a repeated id or key (a retired policy keeps its key), an invalid name or definition. */
  create(input: CreatePolicyInput): Promise<Policy>;
  findById(organizationId: string, id: string): Promise<Policy | null>;
  findByKey(organizationId: string, key: string): Promise<Policy | null>;
  search(options: SearchPoliciesOptions): Promise<Policy[]>;
  count(options: Omit<SearchPoliciesOptions, "limit" | "after"> & { limit?: number }): Promise<number>;
  /**
   * Changes the name, the description and/or the definition. A retired policy cannot change (`policy_retired`). A call that
   * changes nothing keeps the version. Empty input: `policy_update_empty`.
   */
  update(organizationId: string, id: string, input: UpdatePolicyInput): Promise<Policy>;
  /** `draft` or `disabled` → `active`. Idempotent for an active policy; `policy_retired` for a retired one. At most `MAX_ACTIVE_POLICIES` active per organization (`policy_limit_reached`). */
  activate(organizationId: string, id: string, input: ChangePolicyStatusInput): Promise<Policy>;
  /** `active` → `disabled`. Idempotent. A draft has nothing to disable (`policy_transition_invalid`). */
  disable(organizationId: string, id: string, input: ChangePolicyStatusInput): Promise<Policy>;
  /** `active` or `disabled` → `retired`, for good. Idempotent. A draft is deleted, not retired (`policy_transition_invalid`). */
  retire(organizationId: string, id: string, input: ChangePolicyStatusInput): Promise<Policy>;
  /** Permanently removes a policy that was never active. Anything else is `policy_not_draft`. */
  delete(organizationId: string, id: string, input: { authorization: PolicyAuthorization }): Promise<void>;
  /** The immutable revisions of a policy, newest first. */
  revisions(organizationId: string, id: string, options?: { limit?: number; before?: number }): Promise<PolicyRevision[]>;
  findRevision(organizationId: string, id: string, revision: number): Promise<PolicyRevision | null>;
  /** The active policies of an organization together with its policy-set revision (see `ActivePolicySet`). */
  activeSet(organizationId: string): Promise<ActivePolicySet>;
  /**
   * The policy-set revision of an organization: a number that changes on every change to any of its policies; 0 when it has none.
   * It comes from one counter shared by all organizations, so it is never handed out twice, not even to an organization that was
   * deleted and created again under the same id. It goes up, but it is NOT consecutive: compare it with `===`, never count with it.
   */
  setRevision(organizationId: string): Promise<number>;
}

// ---------------------------------------------------------------------------------------------------------------------
// Rules every backend applies the same way.
// ---------------------------------------------------------------------------------------------------------------------

const TRANSITIONS: Record<PolicyStatus, readonly PolicyStatus[]> = {
  draft: ["active"],
  active: ["disabled", "retired"],
  disabled: ["active", "retired"],
  retired: [],
};

/** Whether `from → to` is a legal move (the same status is a no-op, handled by the caller). */
export function isPolicyTransitionAllowed(from: PolicyStatus, to: PolicyStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Throws the stable error for an illegal move; `retired` is the dead end. */
export function assertPolicyTransition(from: PolicyStatus, to: PolicyStatus): void {
  if (from === to) return;
  if (from === "retired") throw new PolicyError("A retired policy can never be used again; create a new policy.", "policy_retired");
  if (!isPolicyTransitionAllowed(from, to)) {
    throw new PolicyError(
      from === "draft" ? `A draft cannot be ${to === "retired" ? "retired; delete it instead" : to} (activate it first).` : `A policy cannot go from ${from} to ${to}.`,
      "policy_transition_invalid",
    );
  }
}

export function assertPolicyId(value: unknown, what = "policy id"): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > 200) {
    throw new PolicyError(`The ${what} must be a non-empty text of at most 200 characters.`, "policy_invalid");
  }
  return value;
}

export function assertPolicyStatus(value: unknown): PolicyStatus {
  if (typeof value !== "string" || !(POLICY_STATUSES as readonly string[]).includes(value)) {
    throw new PolicyError(`A policy status must be one of: ${POLICY_STATUSES.join(", ")}.`, "policy_invalid");
  }
  return value as PolicyStatus;
}

export interface ValidCreatePolicy {
  key: string;
  name: string;
  description?: string;
  parsed: ParsedPolicyDefinition;
  note?: string;
  now: Date;
}

/** Validates a creation input the same way in every backend and returns the normalized pieces. */
export function assertValidCreatePolicy(input: CreatePolicyInput): ValidCreatePolicy {
  assertPolicyId(input.id);
  assertPolicyId(input.organizationId, "organization id");
  const description = sanitizePolicyDescription(input.description);
  const note = sanitizePolicyNote(input.note);
  return {
    key: assertValidPolicyKey(input.key),
    name: sanitizePolicyName(input.name),
    ...(description !== undefined ? { description } : {}),
    parsed: parsePolicyDefinition(input.definition),
    ...(note !== undefined ? { note } : {}),
    now: input.now ?? new Date(),
  };
}

export interface ValidUpdatePolicy {
  name?: string;
  description?: string | null;
  parsed?: ParsedPolicyDefinition;
  note?: string;
}

export function assertValidUpdatePolicy(input: UpdatePolicyInput): ValidUpdatePolicy {
  const update: ValidUpdatePolicy = {};
  if (input.name !== undefined) update.name = sanitizePolicyName(input.name);
  if (input.description !== undefined) update.description = input.description === null ? null : (sanitizePolicyDescription(input.description) ?? null);
  if (input.definition !== undefined) update.parsed = parsePolicyDefinition(input.definition);
  const note = sanitizePolicyNote(input.note);
  if (note !== undefined) update.note = note;
  if (update.name === undefined && update.description === undefined && update.parsed === undefined) {
    throw new PolicyError("Nothing to update.", "policy_update_empty");
  }
  return update;
}

export function normalizePolicyPage(options: { limit?: number }): number {
  return Math.min(Math.max(Math.trunc(options.limit ?? DEFAULT_POLICY_PAGE), 1), MAX_POLICY_PAGE);
}

export function assertPolicyFilters(options: { status?: unknown; kind?: unknown; effect?: unknown }): void {
  if (options.status !== undefined) assertPolicyStatus(options.status);
  if (options.kind !== undefined && !(POLICY_KINDS as readonly string[]).includes(options.kind as string)) throw new PolicyError("Unknown policy kind.", "policy_invalid");
  if (options.effect !== undefined && !(POLICY_EFFECTS as readonly string[]).includes(options.effect as string)) throw new PolicyError("Unknown policy effect.", "policy_invalid");
}
