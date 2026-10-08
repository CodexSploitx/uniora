import type { Pool } from "pg";
import type {
  BlockMembershipInput,
  SuspendMembershipInput,
  CreateMembershipInput,
  Identity,
  Membership,
  MembershipListing,
  MembershipRepository,
  MembershipStatus,
  SearchMembershipsOptions,
  MembershipVersionOptions,
  UnblockMembershipInput,
} from "@uniora/core";
import { MembershipError, assertBlockUntil, assertExpectedVersion, sanitizeBlockReason } from "@uniora/core";
import type { Queryable } from "../queryable.js";
import { countByOrganization } from "../pg-counts.js";
import { toLikePattern } from "../pg-like.js";
import { searchCandidates, walkCount } from "../pg-search.js";
import { isUniqueViolation, violatedConstraint } from "../pg-errors.js";

/** Postgres error code for a serializable-transaction conflict (SSI) — same constant as `identity-link.ts`. */
const SERIALIZATION_FAILURE = "40001";

function isSerializationFailure(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === SERIALIZATION_FAILURE;
}

interface MembershipRow {
  id: string;
  organization_id: string;
  provider: string;
  subject: string;
  role_ids: string[];
  status: MembershipStatus;
  created_at: Date;
  updated_at: Date;
  version: number;
  invited_by_provider: string | null;
  invited_by_subject: string | null;
  last_active_at: Date | null;
  blocked_at: Date | null;
  blocked_until: Date | null;
  blocked_by_provider: string | null;
  blocked_by_subject: string | null;
  block_reason: string | null;
}

/**
 * The status that is in force right now: a timed suspension whose `blocked_until` has passed is active again, with no
 * job to flip it (the stored `status` stays `blocked` until the next `block`/`unblock`). Same rule as
 * `uniora.active_membership_id`. `now()` is the database clock.
 */
function effectiveStatus(alias?: string): string {
  const prefix = alias ? `${alias}.` : "";
  return `(case when ${prefix}status = 'blocked' and ${prefix}blocked_until is not null then (case when ${prefix}blocked_until <= now() then 'active' else 'suspended' end) else ${prefix}status end)`;
}

/**
 * The stored `status` is only ever `active` or `blocked` (a suspension is a block with an end date), so a filter for an
 * effective `blocked`/`suspended` member can also say `status = 'blocked'`, which the `(status, id)` index answers without
 * touching the other rows. An `active` filter can't narrow anything (nearly everyone is), so it adds nothing.
 */
function storedStatusPrefilter(status: MembershipStatus | undefined): string {
  return status === "blocked" || status === "suspended" ? "and status = 'blocked'" : "";
}

/** A page can be found by walking the table in id order only when nothing but the text and the organization filters it. */
function pageHint(options?: SearchMembershipsOptions): { after?: string; limit: number } | undefined {
  if (!options?.limit || options.identity || options.status) return undefined;
  return { after: options.after, limit: options.limit };
}

/** Columns of `uniora.memberships` a `Membership` needs, qualified with the alias `m`. */
const MEMBERSHIP_COLUMNS = `m.id, m.organization_id, m.provider, m.subject, ${effectiveStatus("m")} as status, m.created_at, m.updated_at, m.version,
  m.invited_by_provider, m.invited_by_subject, m.last_active_at,
  m.blocked_at, m.blocked_until, m.blocked_by_provider, m.blocked_by_subject, m.block_reason`;

function invitedByOf(row: Pick<MembershipRow, "invited_by_provider" | "invited_by_subject">): Identity | undefined {
  return row.invited_by_provider !== null && row.invited_by_subject !== null
    ? { provider: row.invited_by_provider, subject: row.invited_by_subject }
    : undefined;
}

function toMembership(row: MembershipRow): Membership {
  const invitedBy = invitedByOf(row);
  return {
    id: row.id,
    organizationId: row.organization_id,
    identity: { provider: row.provider, subject: row.subject },
    roleIds: row.role_ids,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
    ...(invitedBy ? { invitedBy } : {}),
    ...(row.last_active_at ? { lastActiveAt: row.last_active_at } : {}),
    ...(row.status !== "active" && row.blocked_at && row.blocked_by_provider !== null && row.blocked_by_subject !== null
      ? {
          blocked: {
            at: row.blocked_at,
            by: { provider: row.blocked_by_provider, subject: row.blocked_by_subject },
            ...(row.block_reason !== null ? { reason: row.block_reason } : {}),
            ...(row.blocked_until !== null ? { until: row.blocked_until } : {}),
          },
        }
      : {}),
  };
}

const SELECT_MEMBERSHIP_WITH_ROLES = `
  select ${MEMBERSHIP_COLUMNS},
         coalesce(array_agg(mr.role_id) filter (where mr.role_id is not null), '{}') as role_ids
  from uniora.memberships m
  left join uniora.membership_roles mr on mr.membership_id = m.id
`;

/**
 * All of `create()`'s real work (validate roleIds, insert, attach roles),
 * against whatever `Queryable` it's given. Shared by both call paths in
 * `createMembershipRepository` below: the ordinary one (whatever isolation
 * the caller's connection already has) and the SERIALIZABLE-wrapped one.
 */
async function performCreate(db: Queryable, input: CreateMembershipInput): Promise<Membership> {
  const roleIds = input.roleIds ?? [];

  // Validated BEFORE inserting the membership row (not after) — same
  // "validate before insert" pattern as `RoleRepository.create()`'s
  // `permissionKeys` fix: a fault mid-insert must never leave an orphaned
  // membership behind instead of nothing at all (docs/security-pentest-2026-09-24.md
  // Hallazgo 2, found by repository-wide review after fixing `assignRole`).
  if (roleIds.length > 0) {
    const validRoles = await db.query<{ id: string }>(
      `select id from uniora.roles where id = any($1::text[]) and organization_id = $2`,
      [roleIds, input.organizationId],
    );
    const validIds = new Set(validRoles.rows.map((row) => row.id));
    const invalidRoleId = roleIds.find((roleId) => !validIds.has(roleId));
    if (invalidRoleId !== undefined) {
      throw new MembershipError(
        `Cannot assign role "${invalidRoleId}" to membership "${input.id}": the role does not exist or belongs to a different organization than "${input.organizationId}".`,
      );
    }
  }

  // SECURITY FIX (docs/security-pentest-2026-09-24.md Ronda 6): the
  // `unique(organization_id, provider, subject)` constraint (migration
  // 0001) already rejected a duplicate identity in the same organization —
  // fail-closed was never actually broken here — but the raw Postgres
  // error leaked past this repository uncaught, instead of the clear
  // `MembershipError` every other constraint violation in this package
  // translates it to. Distinguished from the `id` collision
  // (`memberships_pkey`) the same way as everywhere else in this package
  // (`violatedConstraint`), so retrying with a fresh `id` for a genuinely
  // duplicate identity doesn't look like it might help.
  //
  // SECURITY FIX (docs/security-pentest-2026-09-24.md Ronda 7 — boundary
  // collapse): `IdentityLinkRepository.link()` refuses to link a `from`
  // identity that already owns a membership directly, in ANY organization
  // ("would create an ambiguous/hijackable lookup" — its own error
  // message). Nothing enforced the same invariant here, so the identical
  // ambiguous state was reachable in the OPPOSITE order (link() first,
  // then a direct create() for that same `from` identity). The `where not
  // exists (...)` guard below makes the check part of the SAME statement
  // as the insert (same atomic-guard pattern as `assignRole`/
  // `unassignOwnerRole` elsewhere in this file) — a duplicate `id`/identity-
  // in-org still throws from the constraint violation below; a `from`-
  // identity conflict instead inserts zero rows, handled right after.
  // Closing the SEQUENTIAL bypass this way is necessary but not
  // sufficient — see `createMembershipRepository` below for why a genuine
  // CONCURRENT race additionally needed `create()` to run under its own
  // SERIALIZABLE transaction, exactly like `link()` already does.
  let result;
  try {
    result = await db.query(
      `insert into uniora.memberships (id, organization_id, provider, subject, invited_by_provider, invited_by_subject, created_at, updated_at)
       select $1, $2, $3, $4, $5, $6, coalesce($7::timestamptz, date_trunc('milliseconds', now())), coalesce($7::timestamptz, date_trunc('milliseconds', now()))
       where not exists (
         select 1 from uniora.identity_links
         where from_provider = $3 and from_subject = $4
       )
       returning created_at`,
      [
        input.id,
        input.organizationId,
        input.identity.provider,
        input.identity.subject,
        input.invitedBy?.provider ?? null,
        input.invitedBy?.subject ?? null,
        input.createdAt ?? null,
      ],
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      if (violatedConstraint(error) === "memberships_pkey") {
        throw new MembershipError(`A membership with id "${input.id}" already exists.`);
      }
      throw new MembershipError(
        `Identity ${input.identity.provider}:${input.identity.subject} already has a membership in organization "${input.organizationId}".`,
      );
    }
    throw error;
  }
  if ((result.rowCount ?? 0) === 0) {
    throw new MembershipError(
      `Cannot create a direct membership for identity ${input.identity.provider}:${input.identity.subject}: it is already linked as an alias of another identity (see IdentityLinkRepository.link) — creating a direct membership here would produce an ambiguous/hijackable lookup.`,
    );
  }

  // SECURITY FIX (docs/security-pentest-2026-09-24.md Ronda 8, ABA — same
  // root cause as `assignRole()`): `roleIds` was validated once, up front
  // (the batch `select` above), then inserted here unconditionally — a
  // window in between where a role could be deleted and recreated with the
  // SAME id in a DIFFERENT organization (`roles.id` is a global PK) would
  // insert a `membership_roles` row for a role that no longer belongs to
  // `input.organizationId`. Re-checks `organization_id` FRESH, correlated
  // within this SAME insert statement, instead of trusting the earlier
  // batch validation.
  for (const roleId of roleIds) {
    await db.query(
      `insert into uniora.membership_roles (membership_id, role_id)
       select $1, $2
       where exists (select 1 from uniora.roles r where r.id = $2 and r.organization_id = $3)
       on conflict do nothing`,
      [input.id, roleId, input.organizationId],
    );
  }

  const createdAt = (result.rows[0] as { created_at: Date }).created_at;
  return {
    id: input.id,
    organizationId: input.organizationId,
    identity: input.identity,
    roleIds: [...roleIds],
    status: "active",
    createdAt,
    updatedAt: createdAt,
    version: 1,
    ...(input.invitedBy ? { invitedBy: input.invitedBy } : {}),
  };
}

/**
 * After a guarded write changed nothing: if the caller passed `expectedVersion` and the membership is at another
 * version, that is why (`membership_version_conflict`). Does nothing for an unknown membership or a matching version.
 */
async function assertNotStale(db: Queryable, membershipId: string, expectedVersion: number | null): Promise<void> {
  if (expectedVersion === null) return;
  const current = await db.query<{ version: number }>(`select version from uniora.memberships where id = $1`, [membershipId]);
  if (current.rows[0] && current.rows[0].version !== expectedVersion) {
    throw new MembershipError("The membership changed since it was read.", "membership_version_conflict");
  }
}

/** Bumps `updated_at` and `version` after a role change. Kept out of the concurrency-guarded statements on purpose. */
async function touch(db: Queryable, membershipId: string): Promise<void> {
  await db.query(`update uniora.memberships set updated_at = date_trunc('milliseconds', now()), version = version + 1 where id = $1`, [membershipId]);
}

/**
 * `db` is used for the ordinary path (including when this repository was
 * built inside `storage.transaction()`, where `db` is already the caller's
 * transactional client). `pool` is only passed at the top level (see
 * `storage.ts`) and, when present, is used to run `create()` in its OWN
 * short-lived SERIALIZABLE transaction — mirror of the exact same pattern
 * `identity-link.ts`'s `link()` uses, needed for the same class of reason.
 */
export function createMembershipRepository(db: Queryable, pool?: Pool): MembershipRepository {
  /** `block` (no `until`) and `suspend` (with one) are the same write: a timed suspension is a block that ends. */
  async function blockWithin(membershipId: string, input: BlockMembershipInput, until: Date | undefined): Promise<Membership> {
    const expectedVersion = assertExpectedVersion(input.expectedVersion) ?? null;
    // Same write-skew defence as `unassignOwnerRole`: lock every membership holding one of this member's Owner
    // roles (ordered, so two concurrent blockers contend in the same order) BEFORE counting the ACTIVE ones, so
    // two Owners blocking each other at the same instant can't leave nobody able to act.
    if (until === undefined) {
      // `block` over a timed suspension makes it indefinite (the member was already inactive: no Owner guard applies).
      const escalated = await db.query(
        `update uniora.memberships
         set blocked_at = date_trunc('milliseconds', now()), blocked_until = null,
             blocked_by_provider = $2, blocked_by_subject = $3, block_reason = $4,
             updated_at = date_trunc('milliseconds', now()), version = version + 1
         where id = $1 and status = 'blocked' and ${effectiveStatus()} = 'suspended' and ($5::integer is null or version = $5)`,
        [membershipId, input.actor.provider, input.actor.subject, sanitizeBlockReason(input.reason) ?? null, expectedVersion],
      );
      if ((escalated.rowCount ?? 0) > 0) return (await repository.findById(membershipId))!;
    }
    const changed = await db.query(
      `with owner_role_ids as (
         select mr.role_id
         from uniora.membership_roles mr
         join uniora.roles r on r.id = mr.role_id
         where mr.membership_id = $1 and r.is_owner_role
       ),
       locked as (
         select mr.membership_id, mr.role_id, ${effectiveStatus("m")} as status
         from uniora.membership_roles mr
         join uniora.memberships m on m.id = mr.membership_id
         where mr.role_id in (select role_id from owner_role_ids)
         order by mr.role_id, mr.membership_id
         for update of mr, m
       )
       update uniora.memberships m
       set status = 'blocked', blocked_at = date_trunc('milliseconds', now()), blocked_until = $5::timestamptz,
           blocked_by_provider = $2, blocked_by_subject = $3, block_reason = $4,
           updated_at = date_trunc('milliseconds', now()), version = m.version + 1
       where m.id = $1 and ${effectiveStatus("m")} = 'active' and ($6::integer is null or m.version = $6)
         and not exists (
           select 1 from owner_role_ids o
           where (select count(*) from locked l where l.role_id = o.role_id and l.status = 'active' and l.membership_id <> $1) < 1
         )
       returning m.id`,
      [membershipId, input.actor.provider, input.actor.subject, sanitizeBlockReason(input.reason) ?? null, until ?? null, expectedVersion],
    );
    const current = await repository.findById(membershipId);
    if (!current) throw new MembershipError(`Membership not found: ${membershipId}`);
    if ((changed.rowCount ?? 0) === 0 && expectedVersion !== null && current.version !== expectedVersion) {
      throw new MembershipError("The membership changed since it was read.", "membership_version_conflict");
    }
    // Also when this very write already lapsed (a suspension ending within milliseconds): it was applied, not refused.
    if (current.status !== "active" || (changed.rowCount ?? 0) > 0) return current; // changed now, or was already blocked or suspended (idempotent)
    throw new MembershipError(
      "Cannot block the organization's last active Owner — every organization must keep at least one.",
      "last_owner",
    );
  }

  const repository: MembershipRepository = {
    async create(input: CreateMembershipInput) {
      if (!pool) return performCreate(db, input);

      // SECURITY FIX (docs/security-pentest-2026-09-24.md Ronda 7 —
      // boundary collapse, part 2). The `where not exists (...)` guard
      // above closes the SEQUENTIAL bypass (link() then create()), but a
      // genuine CONCURRENT race between them still reproduced the same
      // ambiguous state 25/25 times even after that fix: `create()`'s read
      // of `identity_links` only matters to Postgres's SSI conflict
      // detector if `create()` ITSELF is a SERIALIZABLE transaction —
      // SIREAD predicate locks (the mechanism SSI uses to notice "this read
      // would have seen different data") are only taken by SERIALIZABLE
      // transactions, never by a plain autocommit statement. Without that,
      // `create()`'s read of `identity_links` left no trace for SSI to
      // reference, so when `link()` (which IS serializable, see
      // `identity-link.ts` Hallazgo 9) later wrote to `identity_links`,
      // there was nothing to conflict against — only a one-way rw edge
      // (`link()` → `create()`, via `memberships`), never the two-way cycle
      // SSI requires to detect write skew. Wrapping `create()` in its own
      // SERIALIZABLE transaction gives it a symmetric SIREAD lock on
      // `identity_links`, completing the cycle: verified empirically, 0/25
      // concurrent trials left the ambiguous state after this fix (vs.
      // 25/25 before it). Same retry-with-jitter treatment as `link()`,
      // for the same reason (a `40001` here can be a genuine conflict — the
      // retry correctly re-observes state and rejects normally — or
      // incidental contention from unrelated activity).
      let lastError: unknown;
      for (let attempt = 0; attempt < 5; attempt++) {
        const client = await pool.connect();
        try {
          await client.query("begin isolation level serializable");
          const created = await performCreate(client, input);
          await client.query("commit");
          return created;
        } catch (error) {
          await client.query("rollback").catch(() => {});
          if (isSerializationFailure(error)) {
            lastError = error;
            await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1) + Math.random() * 20));
            continue;
          }
          throw error;
        } finally {
          client.release();
        }
      }
      throw new MembershipError(
        `Cannot create membership "${input.id}": too much concurrent identity-linking activity to safely resolve this request (${(lastError as Error | undefined)?.message ?? "serialization failure"}). Please retry.`,
      );
    },

    async findByIdentity(organizationId: string, identity: Identity) {
      // Matches directly, or transparently through a cross-provider
      // identity link (`uniora.identity_links`, see docs/postgres.md) —
      // so a migrated identity resolves to the same membership without
      // any role/permission being touched.
      const result = await db.query<MembershipRow>(
        `${SELECT_MEMBERSHIP_WITH_ROLES}
         where m.organization_id = $1
           and (
             (m.provider = $2 and m.subject = $3)
             or exists (
               select 1 from uniora.identity_links il
               where il.from_provider = $2 and il.from_subject = $3
                 and il.to_provider = m.provider and il.to_subject = m.subject
             )
           )
         group by m.id`,
        [organizationId, identity.provider, identity.subject],
      );
      return result.rows[0] ? toMembership(result.rows[0]) : null;
    },

    async listByOrganization(organizationId: string) {
      const result = await db.query<MembershipRow>(
        `${SELECT_MEMBERSHIP_WITH_ROLES} where m.organization_id = $1 group by m.id`,
        [organizationId],
      );
      return result.rows.map(toMembership);
    },

    async findById(id: string) {
      const result = await db.query<MembershipRow>(`${SELECT_MEMBERSHIP_WITH_ROLES} where m.id = $1 group by m.id`, [id]);
      return result.rows[0] ? toMembership(result.rows[0]) : null;
    },

    async search(options?: SearchMembershipsOptions) {
      const query = options?.query?.trim();
      const candidates = await searchCandidates(db, "memberships", query, options?.organizationId, pageHint(options));
      // Page the memberships FIRST (index-ordered by id, limited), and only
      // then join/aggregate their roles — so the cost is one page of rows,
      // not "every matching member joined to its roles".
      const result = await db.query<MembershipRow>(
        `select ${MEMBERSHIP_COLUMNS},
                coalesce(array_agg(mr.role_id) filter (where mr.role_id is not null), '{}') as role_ids
         from (
           select *
           from uniora.memberships
           where ($1::text is null or organization_id = $1)
             and ($2::text is null or provider ilike $2 or subject ilike $2)
             and ($3::text is null or id > $3)
             and ($5::text is null or (provider = $5 and subject = $6))
             and ($7::text is null or ${effectiveStatus()} = $7)
             ${storedStatusPrefilter(options?.status)}
             and ($8::text[] is null or id = any($8))
           order by id asc
           limit $4
         ) m
         left join uniora.membership_roles mr on mr.membership_id = m.id
         group by m.id, m.organization_id, m.provider, m.subject, m.status, m.created_at, m.updated_at,
                  m.invited_by_provider, m.invited_by_subject, m.last_active_at,
                  m.blocked_at, m.blocked_until, m.blocked_by_provider, m.blocked_by_subject, m.block_reason, m.version
         order by m.id asc`,
        [options?.organizationId ?? null, query ? toLikePattern(query) : null, options?.after ?? null, options?.limit ?? null, options?.identity?.provider ?? null, options?.identity?.subject ?? null, options?.status ?? null, candidates],
      );
      return result.rows.map(toMembership);
    },

    async searchListing(options: SearchMembershipsOptions & { rolesPerMember: number }) {
      const query = options.query?.trim();
      const candidates = await searchCandidates(db, "memberships", query, options.organizationId, pageHint(options));
      interface ListingRow {
        id: string;
        organization_id: string;
        provider: string;
        subject: string;
        status: MembershipStatus;
        created_at: Date;
        invited_by_provider: string | null;
        invited_by_subject: string | null;
        last_active_at: Date | null;
        role_count: number;
        roles: { id: string; organization_id: string; name: string; key: string; is_owner_role: boolean; is_system: boolean }[];
      }
      // Page the memberships first, then, per row, count its roles and take
      // only a bounded preview (Owner first, then by name) — so a member with
      // hundreds of roles costs the same as one with three.
      const result = await db.query<ListingRow>(
        `select m.id, m.organization_id, m.provider, m.subject, m.status, m.created_at,
                m.invited_by_provider, m.invited_by_subject, m.last_active_at,
                (select count(*) from uniora.membership_roles mr where mr.membership_id = m.id)::int as role_count,
                coalesce((
                  select json_agg(json_build_object('id', p.id, 'organization_id', p.organization_id, 'name', p.name,
                                                    'key', p.key, 'is_owner_role', p.is_owner_role, 'is_system', p.is_system)
                                  order by p.is_owner_role desc, p.name, p.id)
                  from (
                    select r.id, r.organization_id, r.name, r.key, r.is_owner_role, r.is_system
                    from uniora.membership_roles mr
                    join uniora.roles r on r.id = mr.role_id
                    where mr.membership_id = m.id
                    order by r.is_owner_role desc, r.name, r.id
                    limit $5
                  ) p
                ), '[]'::json) as roles
         from (
           select id, organization_id, provider, subject, ${effectiveStatus()} as status, created_at, invited_by_provider, invited_by_subject, last_active_at
           from uniora.memberships
           where ($1::text is null or organization_id = $1)
             and ($2::text is null or provider ilike $2 or subject ilike $2)
             and ($3::text is null or id > $3)
             and ($6::text is null or (provider = $6 and subject = $7))
             and ($8::text is null or ${effectiveStatus()} = $8)
             ${storedStatusPrefilter(options?.status)}
             and ($9::text[] is null or id = any($9))
           order by id asc
           limit $4
         ) m
         order by m.id asc`,
        [options.organizationId ?? null, query ? toLikePattern(query) : null, options.after ?? null, options.limit ?? null, options.rolesPerMember, options.identity?.provider ?? null, options.identity?.subject ?? null, options.status ?? null, candidates],
      );
      return result.rows.map(
        (row): MembershipListing => ({
          id: row.id,
          organizationId: row.organization_id,
          identity: { provider: row.provider, subject: row.subject },
          roleCount: row.role_count,
          status: row.status,
          createdAt: row.created_at,
          ...(invitedByOf(row) ? { invitedBy: invitedByOf(row)! } : {}),
          ...(row.last_active_at ? { lastActiveAt: row.last_active_at } : {}),
          roles: row.roles.map((role) => ({
            id: role.id,
            organizationId: role.organization_id,
            name: role.name,
            key: role.key,
            isOwnerRole: role.is_owner_role,
            isSystem: role.is_system,
          })),
        }),
      );
    },

    async count(options?: { organizationId?: string; query?: string; identity?: Identity; status?: MembershipStatus; limit?: number }) {
      const query = options?.query?.trim();
      // A common term reaches the cap within the first rows of the table: no need to ask the index at all.
      if (query && options?.limit && !options.identity && !options.status) {
        if ((await walkCount(db, query, options.organizationId, options.limit)) >= options.limit) return options.limit;
      }
      const candidates = await searchCandidates(db, "memberships", query, options?.organizationId);
      // With `limit`, counting stops there, so a filter matching millions of rows costs a page of work.
      const result = await db.query<{ count: string }>(
        `select count(*)::text as count
         from (
           select 1
           from uniora.memberships
           where ($1::text is null or organization_id = $1)
             and ($2::text is null or provider ilike $2 or subject ilike $2)
             and ($3::text is null or (provider = $3 and subject = $4))
             and ($5::text is null or ${effectiveStatus()} = $5)
             ${storedStatusPrefilter(options?.status)}
             and ($7::text[] is null or id = any($7))
           limit $6::integer
         ) matching`,
        [options?.organizationId ?? null, query ? toLikePattern(query) : null, options?.identity?.provider ?? null, options?.identity?.subject ?? null, options?.status ?? null, options?.limit ?? null, candidates],
      );
      return Number(result.rows[0]!.count);
    },

    async countByRole(roleIds: string[]) {
      const counts: Record<string, number> = Object.fromEntries(roleIds.map((id) => [id, 0]));
      if (roleIds.length === 0) return counts;
      const result = await db.query<{ role_id: string; count: string }>(
        `select role_id, count(*)::text as count from uniora.membership_roles where role_id = any($1::text[]) group by role_id`,
        [roleIds],
      );
      for (const row of result.rows) counts[row.role_id] = Number(row.count);
      return counts;
    },

    async countByOrganization(organizationIds: string[], options?: { limit?: number }) {
      return countByOrganization(db, "memberships", organizationIds, options?.limit);
    },

    async assignRole(membershipId: string, roleId: string, options?: MembershipVersionOptions) {
      const expectedVersion = assertExpectedVersion(options?.expectedVersion) ?? null;
      // Security fix (docs/security-pentest-2026-09-24.md Hallazgo 7): the
      // role's type is resolved and checked FIRST, unconditionally — never
      // skipped by an "already assigned" idempotency short-circuit. Without
      // this ordering, calling assignRole() on a pair that's already
      // correctly assigned (e.g. via assignOwnerRole()) would silently
      // "succeed" instead of telling the caller it used the wrong method,
      // defeating the whole point of the split for that caller.
      const role = await db.query<{ organization_id: string; is_owner_role: boolean }>(
        `select organization_id, is_owner_role from uniora.roles where id = $1`,
        [roleId],
      );
      const roleRow = role.rows[0];
      if (!roleRow) throw new MembershipError(`Role not found: ${roleId}`);
      if (roleRow.is_owner_role) {
        throw new MembershipError(
          `Cannot assign the protected Owner role "${roleId}" via assignRole() — use assignOwnerRole() instead.`,
        );
      }

      // SECURITY FIX (docs/security-pentest-2026-09-24.md Ronda 8, ABA):
      // the comment this replaced claimed "a role's own organization never
      // changes after creation, so no race applies" — true for a single
      // Role ENTITY, but false for a role `id`: `roles.id` is a global PK
      // (not per-organization), so deleting a role and creating a NEW one
      // with the SAME id in a DIFFERENT organization is reachable through
      // the public API alone. The `organization_id` captured in the SELECT
      // above is a snapshot — if it goes stale between that read and this
      // insert (role deleted + recreated elsewhere in between), using the
      // captured value here would insert a `membership_roles` row for a
      // role that no longer belongs to the organization being validated —
      // reproduced empirically. The `where exists (...)` below now
      // re-reads `uniora.roles` FRESH, correlated within this SAME
      // statement, instead of trusting the earlier snapshot — closing the
      // ABA window entirely (the org-match decision and the insert are now
      // atomic against current data, not a captured value). `on conflict
      // do nothing` keeps this idempotent.
      // ONE statement: the membership row is locked (and its version checked) before the role is attached and the
      // version goes up, so two callers holding the same `expectedVersion` can't both win.
      const result = await db.query(
        `with target as (
           select m.id from uniora.memberships m
           join uniora.roles r on r.id = $2
           where m.id = $1 and m.organization_id = r.organization_id and ($3::integer is null or m.version = $3)
           for update of m
         ),
         inserted as (
           insert into uniora.membership_roles (membership_id, role_id)
           select $1, $2 from target
           on conflict do nothing
           returning 1
         )
         update uniora.memberships set updated_at = date_trunc('milliseconds', now()), version = version + 1
         where id = $1 and exists (select 1 from inserted)`,
        [membershipId, roleId, expectedVersion],
      );
      if ((result.rowCount ?? 0) > 0) return; // newly assigned

      await assertNotStale(db, membershipId, expectedVersion);

      const alreadyAssigned = await db.query(
        `select 1 from uniora.membership_roles where membership_id = $1 and role_id = $2`,
        [membershipId, roleId],
      );
      if ((alreadyAssigned.rowCount ?? 0) > 0) return; // idempotent no-op

      const membership = await db.query(`select 1 from uniora.memberships where id = $1`, [membershipId]);
      if ((membership.rowCount ?? 0) === 0) throw new MembershipError(`Membership not found: ${membershipId}`);

      throw new MembershipError(
        `Cannot assign role "${roleId}" to membership "${membershipId}": the role belongs to a different organization than the membership.`,
      );
    },

    async assignOwnerRole(membershipId: string, roleId: string) {
      // Mirror of `assignRole` above — role type checked first,
      // unconditionally, same reasoning (Hallazgo 7).
      const role = await db.query<{ organization_id: string; is_owner_role: boolean }>(
        `select organization_id, is_owner_role from uniora.roles where id = $1`,
        [roleId],
      );
      const roleRow = role.rows[0];
      if (!roleRow) throw new MembershipError(`Role not found: ${roleId}`);
      if (!roleRow.is_owner_role) {
        throw new MembershipError(`Role "${roleId}" is not the protected Owner role — use assignRole() instead.`);
      }

      const result = await db.query(
        `insert into uniora.membership_roles (membership_id, role_id)
         select $1, $2
         where exists (select 1 from uniora.memberships m where m.id = $1 and m.organization_id = $3)
         on conflict do nothing`,
        [membershipId, roleId, roleRow.organization_id],
      );
      if ((result.rowCount ?? 0) > 0) {
        await touch(db, membershipId);
        return;
      }

      const alreadyAssigned = await db.query(
        `select 1 from uniora.membership_roles where membership_id = $1 and role_id = $2`,
        [membershipId, roleId],
      );
      if ((alreadyAssigned.rowCount ?? 0) > 0) return;

      const membership = await db.query(`select 1 from uniora.memberships where id = $1`, [membershipId]);
      if ((membership.rowCount ?? 0) === 0) throw new MembershipError(`Membership not found: ${membershipId}`);

      throw new MembershipError(
        `Cannot assign role "${roleId}" to membership "${membershipId}": the role belongs to a different organization than the membership.`,
      );
    },

    async unassignRole(membershipId: string, roleId: string, options?: MembershipVersionOptions) {
      const expectedVersion = assertExpectedVersion(options?.expectedVersion) ?? null;
      // Security fix (docs/security-pentest-2026-09-24.md Hallazgo 7): role
      // type checked first, unconditionally — same reasoning as
      // `assignRole` above (an already-not-assigned Owner role must still
      // be reported as "wrong method", never silently treated as a no-op).
      // An unknown `roleId` (never registered, or since deleted) obviously
      // isn't the Owner role that needs protecting, so it falls through to
      // the plain delete below — a non-owner role never needs the atomic
      // last-owner guard that `unassignOwnerRole` has, so a plain
      // unconditional delete is correct and sufficient here.
      const role = await db.query<{ is_owner_role: boolean }>(`select is_owner_role from uniora.roles where id = $1`, [roleId]);
      if (role.rows[0]?.is_owner_role) {
        throw new MembershipError(
          `Cannot unassign the protected Owner role "${roleId}" via unassignRole() — use unassignOwnerRole() instead.`,
        );
      }

      const removed = await db.query(
        `with target as (
           select id from uniora.memberships where id = $1 and ($3::integer is null or version = $3) for update
         ),
         deleted as (
           delete from uniora.membership_roles
           where membership_id = $1 and role_id = $2 and exists (select 1 from target)
           returning 1
         )
         update uniora.memberships set updated_at = date_trunc('milliseconds', now()), version = version + 1
         where id = $1 and exists (select 1 from deleted)`,
        [membershipId, roleId, expectedVersion],
      );
      if ((removed.rowCount ?? 0) === 0) await assertNotStale(db, membershipId, expectedVersion);
    },

    async unassignOwnerRole(membershipId: string, roleId: string) {
      // Role type checked first, unconditionally (same reasoning as
      // `assignOwnerRole`/`unassignRole` above) — an unknown `roleId` can't
      // be the Owner role, so it's an idempotent no-op with nothing further
      // to protect.
      const role = await db.query<{ is_owner_role: boolean }>(`select is_owner_role from uniora.roles where id = $1`, [roleId]);
      const roleRow = role.rows[0];
      if (!roleRow) return;
      if (!roleRow.is_owner_role) {
        throw new MembershipError(`Role "${roleId}" is not the protected Owner role — use unassignRole() instead.`);
      }

      // SECURITY FIX (docs/security-pentest-2026-09-24.md Hallazgo 8, Ronda
      // 4 — CRITICAL): the single WHERE-guarded DELETE below still isn't
      // enough on its own. It correctly makes "check + delete" atomic
      // against itself, but the `exists (...)` subquery is a plain read —
      // it does not lock the row it inspects. Two DIFFERENT owners removing
      // EACH OTHER at the same instant is the textbook "write skew"
      // anomaly: TX1 reads "does mr2 (owner B) still exist?" (yes) and
      // deletes owner A; concurrently TX2 reads "does mr2 (owner A) still
      // exist?" (yes, TX1 hasn't committed yet) and deletes owner B — both
      // succeed, leaving ZERO owners. Reproduced against real Postgres: 4/5
      // trials with no locking left the organization ownerless.
      //
      // Fix: a CTE locks every `membership_roles` row for this `role_id`
      // with `SELECT ... FOR UPDATE` (ordered by `membership_id`, so two
      // concurrent callers always contend for the SAME lock in the SAME
      // order — no deadlock) *before* counting them. Unlike a plain
      // advisory lock, `FOR UPDATE` returns the row's latest COMMITTED
      // content once the lock is acquired — the waiting transaction sees
      // the other one's deletion, not its own stale start-of-statement
      // snapshot. Verified empirically: 0/15 trials left an organization
      // ownerless after this fix (docs/security-pentest-2026-09-24.md
      // Ronda 4).
      const result = await db.query(
        `with locked as (
           select mr.membership_id, ${effectiveStatus("m")} as status
           from uniora.membership_roles mr
           join uniora.memberships m on m.id = mr.membership_id
           where mr.role_id = $2
           order by mr.membership_id
           for update of mr, m
         )
         delete from uniora.membership_roles
         where membership_id = $1 and role_id = $2
           and (select count(*) from locked) > 1
           and (
             (select status from locked where membership_id = $1) <> 'active'
             or exists (select 1 from locked where membership_id <> $1 and status = 'active')
           )`,
        [membershipId, roleId],
      );
      if ((result.rowCount ?? 0) > 0) {
        await touch(db, membershipId);
        return;
      }

      const stillAssigned = await db.query(
        `select 1 from uniora.membership_roles where membership_id = $1 and role_id = $2`,
        [membershipId, roleId],
      );
      if ((stillAssigned.rowCount ?? 0) === 0) return; // wasn't assigned to begin with — idempotent no-op

      throw new MembershipError(
        "Cannot remove the organization's last Owner — every organization must keep at least one.",
        "last_owner",
      );
    },

    async block(membershipId: string, input: BlockMembershipInput) {
      return blockWithin(membershipId, input, undefined);
    },

    async suspend(membershipId: string, input: SuspendMembershipInput) {
      const until = assertBlockUntil(input.until);
      if (until === undefined) throw new MembershipError("A suspension needs an end date (`until`).", "membership_block_until_invalid");
      return blockWithin(membershipId, input, until);
    },

    async unblock(membershipId: string, input: UnblockMembershipInput) {
      const expectedVersion = assertExpectedVersion(input.expectedVersion) ?? null;
      const changed = await db.query(
        `update uniora.memberships
         set status = 'active', blocked_at = null, blocked_until = null, blocked_by_provider = null, blocked_by_subject = null,
             block_reason = null, updated_at = date_trunc('milliseconds', now()), version = version + 1
         where id = $1 and status = 'blocked' and ($2::integer is null or version = $2)`,
        [membershipId, expectedVersion],
      );
      const current = await repository.findById(membershipId);
      if (!current) throw new MembershipError(`Membership not found: ${membershipId}`);
      if ((changed.rowCount ?? 0) === 0 && expectedVersion !== null && current.version !== expectedVersion) {
        throw new MembershipError("The membership changed since it was read.", "membership_version_conflict");
      }
      return current;
    },

    async recordActivity(membershipId: string, at: Date = new Date()) {
      await db.query(
        `update uniora.memberships set last_active_at = $2
         where id = $1 and (last_active_at is null or last_active_at < $2)`,
        [membershipId, at],
      );
    },

    async delete(membershipId: string) {
      // SECURITY FIX (docs/security-pentest-2026-09-24.md Hallazgo 8, Ronda
      // 4 — same write-skew race as `unassignOwnerRole` above, reachable
      // here too since deleting a membership drops its Owner role the same
      // way). `locked` first resolves which of this membership's roles are
      // the (at most one) protected Owner role, then `FOR UPDATE`-locks
      // every `membership_roles` row sharing that `role_id` (ordered, same
      // deadlock-avoidance reasoning as above) before counting survivors. A
      // membership with no Owner role never touches `locked`'s lock set, so
      // the ordinary (non-owner) delete path is unaffected.
      const result = await db.query(
        `with owner_role_ids as (
           select mr.role_id
           from uniora.membership_roles mr
           join uniora.roles r on r.id = mr.role_id
           where mr.membership_id = $1 and r.is_owner_role
         ),
         locked as (
           select mr.membership_id, mr.role_id, ${effectiveStatus("lm")} as status
           from uniora.membership_roles mr
           join uniora.memberships lm on lm.id = mr.membership_id
           where mr.role_id in (select role_id from owner_role_ids)
           order by mr.role_id, mr.membership_id
           for update of mr, lm
         ),
         deleted as (
           delete from uniora.memberships m
           where m.id = $1
             and not exists (
               select 1 from owner_role_ids o
               where (select count(*) from locked l where l.role_id = o.role_id) <= 1
                  or (
                    (select l.status from locked l where l.role_id = o.role_id and l.membership_id = $1) = 'active'
                    and not exists (select 1 from locked l where l.role_id = o.role_id and l.membership_id <> $1 and l.status = 'active')
                  )
             )
           returning m.id
         )
         -- "existed" is read from this statement's own snapshot, so the verdict (deleted / refused as the last Owner / never
         -- there) comes from ONE consistent view — never from a second query that could see a different state.
         select (select count(*) from deleted)::int as deleted,
                exists (select 1 from uniora.memberships e where e.id = $1) as existed`,
        [membershipId],
      );
      const verdict = result.rows[0] as { deleted: number; existed: boolean } | undefined;
      if (verdict && verdict.deleted > 0) return;
      if (verdict?.existed) {
        throw new MembershipError(
          "Cannot remove the organization's last Owner — every organization must keep at least one.",
          "last_owner",
        );
      }
      throw new MembershipError(`Membership not found: ${membershipId}`, "membership_not_found");
    },
  };
  return repository;
}
