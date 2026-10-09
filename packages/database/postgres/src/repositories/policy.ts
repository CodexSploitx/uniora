import type { Pool } from "pg";
import type {
  ActivePolicySet,
  ChangePolicyStatusInput,
  CreatePolicyInput,
  Policy,
  PolicyDefinition,
  PolicyEffect,
  PolicyKind,
  PolicyOperation,
  PolicyRepository,
  PolicyRevision,
  PolicyStatus,
  SearchPoliciesOptions,
  UpdatePolicyInput,
} from "@uniora/core";
import {
  MAX_ACTIVE_POLICIES,
  PolicyError,
  assertExpectedVersion,
  assertPolicyAuthorization,
  assertPolicyFilters,
  assertPolicyTransition,
  assertValidCreatePolicy,
  assertValidUpdatePolicy,
  normalizePolicyPage,
  parsePolicyDefinition,
  sanitizePolicyNote,
} from "@uniora/core";
import type { Queryable } from "../queryable.js";
import { isForeignKeyViolation, isUniqueViolation, violatedConstraint } from "../pg-errors.js";
import { toLikePattern } from "../pg-like.js";

interface PolicyRow {
  id: string;
  organization_id: string;
  key: string;
  name: string;
  description: string | null;
  kind: PolicyKind;
  effect: PolicyEffect;
  status: PolicyStatus;
  revision: number;
  definition: PolicyDefinition;
  definition_hash: string;
  created_at: Date;
  created_by_provider: string;
  created_by_subject: string;
  updated_at: Date;
  activated_at: Date | null;
  status_changed_at: Date | null;
  status_changed_by_provider: string | null;
  status_changed_by_subject: string | null;
  status_reason: string | null;
  version: number;
}

interface RevisionRow {
  policy_id: string;
  organization_id: string;
  revision: number;
  definition: PolicyDefinition;
  definition_hash: string;
  created_at: Date;
  created_by_provider: string;
  created_by_subject: string;
  note: string | null;
}

export const POLICY_COLUMNS =
  "id, organization_id, key, name, description, kind, effect, status, revision, definition, definition_hash, created_at, created_by_provider, created_by_subject, updated_at, activated_at, status_changed_at, status_changed_by_provider, status_changed_by_subject, status_reason, version";
const REVISION_COLUMNS = "policy_id, organization_id, revision, definition, definition_hash, created_at, created_by_provider, created_by_subject, note";

function toPolicy(row: PolicyRow): Policy {
  return {
    id: row.id,
    organizationId: row.organization_id,
    key: row.key,
    name: row.name,
    ...(row.description !== null ? { description: row.description } : {}),
    kind: row.kind,
    effect: row.effect,
    status: row.status,
    revision: row.revision,
    definition: row.definition,
    definitionHash: row.definition_hash,
    createdAt: row.created_at,
    createdBy: { provider: row.created_by_provider, subject: row.created_by_subject },
    updatedAt: row.updated_at,
    ...(row.status_changed_at !== null && row.status_changed_by_provider !== null && row.status_changed_by_subject !== null
      ? {
          statusChange: {
            at: row.status_changed_at,
            by: { provider: row.status_changed_by_provider, subject: row.status_changed_by_subject },
            ...(row.status_reason !== null ? { reason: row.status_reason } : {}),
          },
        }
      : {}),
    ...(row.activated_at !== null ? { activatedAt: row.activated_at } : {}),
    version: row.version,
  };
}

function toRevision(row: RevisionRow): PolicyRevision {
  return {
    policyId: row.policy_id,
    organizationId: row.organization_id,
    revision: row.revision,
    definition: row.definition,
    definitionHash: row.definition_hash,
    createdAt: row.created_at,
    createdBy: { provider: row.created_by_provider, subject: row.created_by_subject },
    ...(row.note !== null ? { note: row.note } : {}),
  };
}

/** The triggers raise `policy_xxx: message` with SQLSTATE P0001; this turns them into the stable errors. */
function translateWriteError(error: unknown, context: { id?: string; key?: string; organizationId?: string }): never {
  const constraint = violatedConstraint(error);
  if (isUniqueViolation(error)) {
    if (constraint === "policies_pkey") throw new PolicyError(`A policy with id "${context.id}" already exists.`, "policy_exists");
    if (constraint === "policies_organization_id_key_key") {
      throw new PolicyError(`A policy with key "${context.key}" already exists in this organization.`, "policy_key_taken");
    }
  }
  if (isForeignKeyViolation(error) && constraint === "policies_organization_id_fkey") {
    throw new PolicyError(`Organization "${context.organizationId}" does not exist.`, "policy_organization_unknown");
  }
  const message = error instanceof Error ? error.message : "";
  const code = /^(policy_[a-z_]+):/.exec(message)?.[1];
  if (code === "policy_limit_reached") throw new PolicyError(message.slice("policy_limit_reached: ".length), "policy_limit_reached");
  if (code === "policy_retired") throw new PolicyError("A retired policy can never be used again; create a new policy.", "policy_retired");
  if (code === "policy_not_draft") throw new PolicyError("Only a policy that was never active can be deleted; retire it instead.", "policy_not_draft");
  if (code === "policy_transition_invalid") throw new PolicyError(message.slice("policy_transition_invalid: ".length), "policy_transition_invalid");
  if (code === "policy_immutable") throw new PolicyError(message.slice("policy_immutable: ".length), "policy_invalid");
  throw error;
}

/**
 * Runs `work` on a single connection inside a transaction. Inside `storage.transaction()` the repository is already bound to
 * the caller's client and joins it; at the top level (a pool) each write opens its own short transaction, so the organization
 * lock it takes is held for the whole check-then-write.
 */
function transactional(db: Queryable, pool: Pool | undefined) {
  return async function run<T>(work: (q: Queryable) => Promise<T>): Promise<T> {
    if (!pool) return work(db);
    const client = await pool.connect();
    try {
      await client.query("begin");
      const result = await work(client);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  };
}

const lockOrganization = (q: Queryable, organizationId: string) => q.query("select uniora.policies_org_lock($1)", [organizationId]);

export function createPolicyRepository(db: Queryable, pool?: Pool): PolicyRepository {
  const run = transactional(db, pool);

  const find = async (q: Queryable, organizationId: string, id: string, forUpdate = false): Promise<Policy | null> => {
    const result = await q.query<PolicyRow>(`select ${POLICY_COLUMNS} from uniora.policies where id = $1 and organization_id = $2${forUpdate ? " for update" : ""}`, [id, organizationId]);
    return result.rows[0] ? toPolicy(result.rows[0]) : null;
  };

  const requirePolicy = async (q: Queryable, organizationId: string, id: string, forUpdate = false): Promise<Policy> => {
    const policy = await find(q, organizationId, id, forUpdate);
    if (!policy) throw new PolicyError(`Policy not found: ${id}`, "policy_not_found");
    return policy;
  };

  function assertVersion(policy: Policy, expected: number | undefined): void {
    if (expected !== undefined && expected !== policy.version) {
      throw new PolicyError(`The policy changed (version ${policy.version}, expected ${expected}).`, "policy_version_conflict");
    }
  }

  const filters = (options: Omit<SearchPoliciesOptions, "limit" | "after">) => {
    const query = options.query?.trim().toLowerCase();
    return { sql: `organization_id = $1 and ($2::text is null or status = $2) and ($3::text is null or kind = $3) and ($4::text is null or effect = $4)
           and ($5::text is null or key ilike $5 or name ilike $5)`, params: [options.organizationId, options.status ?? null, options.kind ?? null, options.effect ?? null, query ? toLikePattern(query) : null] };
  };

  async function changeStatus(
    organizationId: string,
    id: string,
    to: PolicyStatus,
    operation: PolicyOperation,
    input: ChangePolicyStatusInput,
  ): Promise<Policy> {
    assertPolicyAuthorization(input.authorization, { organizationId, operation, actor: input.actor });
    const expected = assertExpectedVersion(input.expectedVersion);
    const reason = sanitizePolicyNote(input.reason);
    try {
      return await run(async (q) => {
        await lockOrganization(q, organizationId);
        const policy = await requirePolicy(q, organizationId, id, true);
        assertVersion(policy, expected);
        if (policy.status === to) return policy;
        assertPolicyTransition(policy.status, to);
        if (to === "active") {
          // The stored definition is read again with the current rules before it can go live.
          parsePolicyDefinition(policy.definition);
          const active = await q.query<{ n: string }>(`select count(*) as n from uniora.policies where organization_id = $1 and status = 'active'`, [organizationId]);
          if (Number(active.rows[0]!.n) >= MAX_ACTIVE_POLICIES) {
            throw new PolicyError(`An organization can have at most ${MAX_ACTIVE_POLICIES} active policies.`, "policy_limit_reached");
          }
        }
        const now = new Date();
        const result = await q.query<PolicyRow>(
          `update uniora.policies
           set status = $3, activated_at = case when $3 = 'active' then coalesce(activated_at, $4) else activated_at end,
               status_changed_at = $4, status_changed_by_provider = $5, status_changed_by_subject = $6, status_reason = $7,
               updated_at = $4, version = version + 1
           where id = $1 and organization_id = $2 returning ${POLICY_COLUMNS}`,
          [id, organizationId, to, now, input.actor.provider, input.actor.subject, reason ?? null],
        );
        return toPolicy(result.rows[0]!);
      });
    } catch (error) {
      return translateWriteError(error, { id, organizationId });
    }
  }

  const setRevision = async (organizationId: string): Promise<number> => {
    const result = await db.query<{ revision: string }>(`select revision from uniora.policy_set_revisions where organization_id = $1`, [organizationId]);
    return result.rows[0] ? Number(result.rows[0].revision) : 0;
  };

  return {
    async create(input: CreatePolicyInput) {
      assertPolicyAuthorization(input.authorization, { organizationId: input.organizationId, operation: "policy.create", actor: input.createdBy });
      const valid = assertValidCreatePolicy(input);
      try {
        return await run(async (q) => {
          await lockOrganization(q, input.organizationId);
          const inserted = await q.query<PolicyRow>(
            `insert into uniora.policies (id, organization_id, key, name, description, kind, effect, revision, definition, definition_hash,
               created_at, created_by_provider, created_by_subject, updated_at)
             values ($1, $2, $3, $4, $5, $6, $7, 1, $8::jsonb, $9, $10, $11, $12, $10) returning ${POLICY_COLUMNS}`,
            [
              input.id,
              input.organizationId,
              valid.key,
              valid.name,
              valid.description ?? null,
              valid.parsed.definition.kind,
              valid.parsed.definition.effect,
              JSON.stringify(valid.parsed.definition),
              valid.parsed.hash,
              valid.now,
              input.createdBy.provider,
              input.createdBy.subject,
            ],
          );
          await q.query(
            `insert into uniora.policy_revisions (policy_id, organization_id, revision, definition, definition_hash, created_at, created_by_provider, created_by_subject, note)
             values ($1, $2, 1, $3::jsonb, $4, $5, $6, $7, $8)`,
            [input.id, input.organizationId, JSON.stringify(valid.parsed.definition), valid.parsed.hash, valid.now, input.createdBy.provider, input.createdBy.subject, valid.note ?? null],
          );
          return toPolicy(inserted.rows[0]!);
        });
      } catch (error) {
        return translateWriteError(error, { id: input.id, key: valid.key, organizationId: input.organizationId });
      }
    },

    findById: (organizationId, id) => find(db, organizationId, id),

    async findByKey(organizationId, key) {
      const result = await db.query<PolicyRow>(`select ${POLICY_COLUMNS} from uniora.policies where organization_id = $1 and key = $2`, [organizationId, key]);
      return result.rows[0] ? toPolicy(result.rows[0]) : null;
    },

    async search(options) {
      assertPolicyFilters(options);
      const where = filters(options);
      const result = await db.query<PolicyRow>(
        `select ${POLICY_COLUMNS} from uniora.policies where ${where.sql} and ($6::text is null or id > $6) order by id limit $7`,
        [...where.params, options.after ?? null, normalizePolicyPage(options)],
      );
      return result.rows.map(toPolicy);
    },

    async count(options) {
      assertPolicyFilters(options);
      const where = filters(options);
      const result = await db.query<{ n: string }>(
        `select count(*) as n from (select 1 from uniora.policies where ${where.sql} limit $6::integer) c`,
        [...where.params, options.limit ?? 1_000_000],
      );
      return Number(result.rows[0]!.n);
    },

    async update(organizationId: string, id: string, input: UpdatePolicyInput) {
      assertPolicyAuthorization(input.authorization, { organizationId, operation: "policy.update", actor: input.actor });
      const change = assertValidUpdatePolicy(input);
      const expected = assertExpectedVersion(input.expectedVersion);
      try {
        return await run(async (q) => {
          await lockOrganization(q, organizationId);
          const policy = await requirePolicy(q, organizationId, id, true);
          assertVersion(policy, expected);
          if (policy.status === "retired") throw new PolicyError("A retired policy cannot be changed.", "policy_retired");
          const name = change.name ?? policy.name;
          const description = change.description === undefined ? (policy.description ?? null) : change.description;
          const newDefinition = change.parsed !== undefined && change.parsed.hash !== policy.definitionHash ? change.parsed : undefined;
          if (name === policy.name && description === (policy.description ?? null) && newDefinition === undefined) return policy;
          const now = new Date();
          if (newDefinition) {
            await q.query(
              `insert into uniora.policy_revisions (policy_id, organization_id, revision, definition, definition_hash, created_at, created_by_provider, created_by_subject, note)
               values ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9)`,
              [id, organizationId, policy.revision + 1, JSON.stringify(newDefinition.definition), newDefinition.hash, now, input.actor.provider, input.actor.subject, change.note ?? null],
            );
          }
          const result = await q.query<PolicyRow>(
            `update uniora.policies
             set name = $3, description = $4, kind = $5, effect = $6, revision = $7, definition = $8::jsonb, definition_hash = $9,
                 updated_at = $10, version = version + 1
             where id = $1 and organization_id = $2 returning ${POLICY_COLUMNS}`,
            [
              id,
              organizationId,
              name,
              description,
              newDefinition ? newDefinition.definition.kind : policy.kind,
              newDefinition ? newDefinition.definition.effect : policy.effect,
              newDefinition ? policy.revision + 1 : policy.revision,
              JSON.stringify(newDefinition ? newDefinition.definition : policy.definition),
              newDefinition ? newDefinition.hash : policy.definitionHash,
              now,
            ],
          );
          return toPolicy(result.rows[0]!);
        });
      } catch (error) {
        return translateWriteError(error, { id, organizationId });
      }
    },

    activate: (organizationId, id, input) => changeStatus(organizationId, id, "active", "policy.activate", input),
    disable: (organizationId, id, input) => changeStatus(organizationId, id, "disabled", "policy.disable", input),
    retire: (organizationId, id, input) => changeStatus(organizationId, id, "retired", "policy.retire", input),

    async delete(organizationId: string, id: string, input: { authorization: UpdatePolicyInput["authorization"] }) {
      assertPolicyAuthorization(input?.authorization, { organizationId, operation: "policy.delete" });
      try {
        await run(async (q) => {
          await lockOrganization(q, organizationId);
          const policy = await requirePolicy(q, organizationId, id, true);
          if (policy.status !== "draft" || policy.activatedAt !== undefined) {
            throw new PolicyError("Only a policy that was never active can be deleted; retire it instead.", "policy_not_draft");
          }
          await q.query(`delete from uniora.policies where id = $1 and organization_id = $2`, [id, organizationId]);
        });
      } catch (error) {
        translateWriteError(error, { id, organizationId });
      }
    },

    async revisions(organizationId, id, options = {}) {
      await requirePolicy(db, organizationId, id);
      const result = await db.query<RevisionRow>(
        `select ${REVISION_COLUMNS} from uniora.policy_revisions
         where policy_id = $1 and organization_id = $2 and ($3::integer is null or revision < $3)
         order by revision desc limit $4`,
        [id, organizationId, options.before ?? null, normalizePolicyPage(options)],
      );
      return result.rows.map(toRevision);
    },

    async findRevision(organizationId, id, revision) {
      const result = await db.query<RevisionRow>(
        `select ${REVISION_COLUMNS} from uniora.policy_revisions where policy_id = $1 and organization_id = $2 and revision = $3`,
        [id, organizationId, revision],
      );
      return result.rows[0] ? toRevision(result.rows[0]) : null;
    },

    async activeSet(organizationId): Promise<ActivePolicySet> {
      // The counter is read FIRST: the policies read after it are at least as new as the number, so a cache keyed by it is never stale.
      const revision = await setRevision(organizationId);
      const result = await db.query<PolicyRow>(
        `select ${POLICY_COLUMNS} from uniora.policies where organization_id = $1 and status = 'active' order by id limit $2`,
        [organizationId, MAX_ACTIVE_POLICIES + 1],
      );
      return { revision, policies: result.rows.map(toPolicy) };
    },

    setRevision,
  };
}
