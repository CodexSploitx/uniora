import { assertExpectedVersion } from "../shared/version.js";
import { assertPolicyAuthorization } from "./authorization.js";
import { parsePolicyDefinition } from "./definition.js";
import { PolicyError } from "./errors.js";
import { MAX_ACTIVE_POLICIES } from "./evaluate.js";
import {
  MAX_POLICIES_PER_ORGANIZATION,
  MAX_POLICY_REVISIONS,
  assertPolicyFilters,
  assertPolicyTransition,
  assertValidCreatePolicy,
  assertValidUpdatePolicy,
  normalizePolicyPage,
} from "./repository.js";
import type { PolicyRepository, SearchPoliciesOptions } from "./repository.js";
import { sanitizePolicyNote } from "./definition.js";
import type { Policy, PolicyRevision, PolicyStatus } from "./types.js";

const clone = <T,>(value: T): T => structuredClone(value);
const byId = <T extends { id: string }>(a: T, b: T): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * The in-memory policy repository: same rules as the databases, enforced in code. `organizationExists` is how the memory
 * storage tells it which organizations exist.
 */
export function createMemoryPolicyRepository(organizationExists: (organizationId: string) => boolean): PolicyRepository {
  const policies = new Map<string, Policy>();
  const revisions = new Map<string, PolicyRevision[]>();
  const setRevisions = new Map<string, number>();

  const bump = (organizationId: string): void => {
    setRevisions.set(organizationId, (setRevisions.get(organizationId) ?? 0) + 1);
  };
  const inOrganization = (organizationId: string): Policy[] => [...policies.values()].filter((policy) => policy.organizationId === organizationId);
  const find = (organizationId: string, id: string): Policy | undefined => {
    const policy = policies.get(id);
    return policy && policy.organizationId === organizationId ? policy : undefined;
  };
  const require = (organizationId: string, id: string): Policy => {
    const policy = find(organizationId, id);
    if (!policy) throw new PolicyError(`Policy not found: ${id}`, "policy_not_found");
    return policy;
  };
  const assertVersion = (policy: Policy, expectedVersion: number | undefined): void => {
    const expected = assertExpectedVersion(expectedVersion);
    if (expected !== undefined && expected !== policy.version) {
      throw new PolicyError(`The policy changed (version ${policy.version}, expected ${expected}).`, "policy_version_conflict");
    }
  };
  const matches = (policy: Policy, filter: Omit<SearchPoliciesOptions, "limit" | "after">): boolean => {
    if (policy.organizationId !== filter.organizationId) return false;
    if (filter.status !== undefined && policy.status !== filter.status) return false;
    if (filter.kind !== undefined && policy.kind !== filter.kind) return false;
    if (filter.effect !== undefined && policy.effect !== filter.effect) return false;
    const query = filter.query?.trim().toLowerCase();
    return !query || policy.name.toLowerCase().includes(query) || policy.key.includes(query);
  };

  function changeStatus(
    organizationId: string,
    id: string,
    to: PolicyStatus,
    operation: "policy.activate" | "policy.disable" | "policy.retire",
    input: { authorization: unknown; actor: Policy["createdBy"]; reason?: string; expectedVersion?: number },
  ): Policy {
    assertPolicyAuthorization(input.authorization, { organizationId, operation, actor: input.actor });
    const policy = require(organizationId, id);
    assertVersion(policy, input.expectedVersion);
    if (policy.status === to) return clone(policy);
    assertPolicyTransition(policy.status, to);
    if (to === "active") {
      // The stored definition is read again with the current rules before it can go live.
      parsePolicyDefinition(policy.definition);
      if (inOrganization(organizationId).filter((other) => other.status === "active").length >= MAX_ACTIVE_POLICIES) {
        throw new PolicyError(`An organization can have at most ${MAX_ACTIVE_POLICIES} active policies.`, "policy_limit_reached");
      }
    }
    const reason = sanitizePolicyNote(input.reason);
    const now = new Date();
    const saved: Policy = {
      ...policy,
      status: to,
      statusChange: { at: now, by: { ...input.actor }, ...(reason !== undefined ? { reason } : {}) },
      ...(to === "active" && policy.activatedAt === undefined ? { activatedAt: now } : {}),
      updatedAt: now,
      version: policy.version + 1,
    };
    policies.set(id, saved);
    bump(organizationId);
    return clone(saved);
  }

  return {
    async create(input) {
      assertPolicyAuthorization(input.authorization, { organizationId: input.organizationId, operation: "policy.create", actor: input.createdBy });
      const valid = assertValidCreatePolicy(input);
      if (!organizationExists(input.organizationId)) {
        throw new PolicyError(`Organization "${input.organizationId}" does not exist.`, "policy_organization_unknown");
      }
      if (policies.has(input.id)) throw new PolicyError(`A policy with id "${input.id}" already exists.`, "policy_exists");
      const existing = inOrganization(input.organizationId);
      if (existing.some((policy) => policy.key === valid.key)) {
        throw new PolicyError(`A policy with key "${valid.key}" already exists in this organization.`, "policy_key_taken");
      }
      if (existing.length >= MAX_POLICIES_PER_ORGANIZATION) {
        throw new PolicyError(`An organization can have at most ${MAX_POLICIES_PER_ORGANIZATION} policies.`, "policy_limit_reached");
      }
      const policy: Policy = {
        id: input.id,
        organizationId: input.organizationId,
        key: valid.key,
        name: valid.name,
        ...(valid.description !== undefined ? { description: valid.description } : {}),
        kind: valid.parsed.definition.kind,
        effect: valid.parsed.definition.effect,
        status: "draft",
        revision: 1,
        definition: valid.parsed.definition,
        definitionHash: valid.parsed.hash,
        createdAt: valid.now,
        createdBy: { ...input.createdBy },
        updatedAt: valid.now,
        version: 1,
      };
      policies.set(policy.id, policy);
      revisions.set(policy.id, [
        {
          policyId: policy.id,
          organizationId: policy.organizationId,
          revision: 1,
          definition: policy.definition,
          definitionHash: policy.definitionHash,
          createdAt: valid.now,
          createdBy: { ...input.createdBy },
          ...(valid.note !== undefined ? { note: valid.note } : {}),
        },
      ]);
      bump(policy.organizationId);
      return clone(policy);
    },

    async findById(organizationId, id) {
      const policy = find(organizationId, id);
      return policy ? clone(policy) : null;
    },

    async findByKey(organizationId, key) {
      const policy = inOrganization(organizationId).find((candidate) => candidate.key === key);
      return policy ? clone(policy) : null;
    },

    async search(options) {
      assertPolicyFilters(options);
      const limit = normalizePolicyPage(options);
      return [...policies.values()]
        .filter((policy) => matches(policy, options) && (options.after === undefined || policy.id > options.after))
        .sort(byId)
        .slice(0, limit)
        .map(clone);
    },

    async count(options) {
      assertPolicyFilters(options);
      const total = [...policies.values()].filter((policy) => matches(policy, options)).length;
      return options.limit === undefined ? total : Math.min(total, options.limit);
    },

    async update(organizationId, id, input) {
      assertPolicyAuthorization(input.authorization, { organizationId, operation: "policy.update", actor: input.actor });
      const change = assertValidUpdatePolicy(input);
      const policy = require(organizationId, id);
      assertVersion(policy, input.expectedVersion);
      if (policy.status === "retired") throw new PolicyError("A retired policy cannot be changed.", "policy_retired");
      const next: Policy = { ...policy };
      let changed = false;
      if (change.name !== undefined && change.name !== policy.name) {
        next.name = change.name;
        changed = true;
      }
      if (change.description !== undefined && (change.description ?? undefined) !== policy.description) {
        if (change.description === null) delete next.description;
        else next.description = change.description;
        changed = true;
      }
      let revision: PolicyRevision | undefined;
      if (change.parsed !== undefined && change.parsed.hash !== policy.definitionHash) {
        const history = revisions.get(id) ?? [];
        if (history.length >= MAX_POLICY_REVISIONS) {
          throw new PolicyError(`A policy can have at most ${MAX_POLICY_REVISIONS} revisions; create a new policy.`, "policy_limit_reached");
        }
        const now = new Date();
        revision = {
          policyId: id,
          organizationId,
          revision: policy.revision + 1,
          definition: change.parsed.definition,
          definitionHash: change.parsed.hash,
          createdAt: now,
          createdBy: { ...input.actor },
          ...(change.note !== undefined ? { note: change.note } : {}),
        };
        Object.assign(next, {
          revision: revision.revision,
          definition: change.parsed.definition,
          definitionHash: change.parsed.hash,
          kind: change.parsed.definition.kind,
          effect: change.parsed.definition.effect,
        });
        changed = true;
      }
      if (!changed) return clone(policy);
      const saved: Policy = { ...next, updatedAt: new Date(), version: policy.version + 1 };
      policies.set(id, saved);
      if (revision) revisions.set(id, [...(revisions.get(id) ?? []), revision]);
      bump(organizationId);
      return clone(saved);
    },

    async activate(organizationId, id, input) {
      return changeStatus(organizationId, id, "active", "policy.activate", input);
    },
    async disable(organizationId, id, input) {
      return changeStatus(organizationId, id, "disabled", "policy.disable", input);
    },
    async retire(organizationId, id, input) {
      return changeStatus(organizationId, id, "retired", "policy.retire", input);
    },

    async delete(organizationId, id, input) {
      assertPolicyAuthorization(input?.authorization, { organizationId, operation: "policy.delete" });
      const policy = require(organizationId, id);
      if (policy.status !== "draft" || policy.activatedAt !== undefined) {
        throw new PolicyError("Only a policy that was never active can be deleted; retire it instead.", "policy_not_draft");
      }
      policies.delete(id);
      revisions.delete(id);
      bump(organizationId);
    },

    async revisions(organizationId, id, options = {}) {
      require(organizationId, id);
      const limit = normalizePolicyPage(options);
      return [...(revisions.get(id) ?? [])]
        .filter((row) => options.before === undefined || row.revision < options.before)
        .sort((a, b) => b.revision - a.revision)
        .slice(0, limit)
        .map(clone);
    },

    async findRevision(organizationId, id, revision) {
      if (!find(organizationId, id)) return null;
      const row = (revisions.get(id) ?? []).find((candidate) => candidate.revision === revision);
      return row ? clone(row) : null;
    },

    async activeSet(organizationId) {
      const revision = setRevisions.get(organizationId) ?? 0;
      const active = inOrganization(organizationId).filter((policy) => policy.status === "active").sort(byId).slice(0, MAX_ACTIVE_POLICIES + 1);
      return { revision, policies: active.map(clone) };
    },

    async setRevision(organizationId) {
      return setRevisions.get(organizationId) ?? 0;
    },
  };
}
