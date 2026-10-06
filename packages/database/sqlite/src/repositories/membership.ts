import type { CreateMembershipInput, Identity, Membership, MembershipListing, MembershipRepository, SearchMembershipsOptions } from "@uniora/core";
import { MembershipError } from "@uniora/core";
import type { SqliteExecutor } from "../executor.js";
import { countByOrganization } from "../counts.js";
import { jsonList, parseList } from "../json.js";
import { toLikePattern } from "../like.js";
import { isUniqueViolation, violatedExactly } from "../sqlite-errors.js";

interface MembershipRow {
  id: string;
  organization_id: string;
  provider: string;
  subject: string;
  role_ids: string;
}

function toMembership(row: MembershipRow): Membership {
  return {
    id: row.id,
    organizationId: row.organization_id,
    identity: { provider: row.provider, subject: row.subject },
    roleIds: parseList(row.role_ids),
  };
}

const SELECT_MEMBERSHIP_WITH_ROLES = `
  select m.id, m.organization_id, m.provider, m.subject,
         json_group_array(mr.role_id order by mr.role_id) filter (where mr.role_id is not null) as role_ids
  from uniora_memberships m
  left join uniora_membership_roles mr on mr.membership_id = m.id
`;

const LAST_OWNER_MESSAGE = "Cannot remove the organization's last Owner — every organization must keep at least one.";

/**
 * `create()`'s real work (validate roleIds, insert, attach roles). Always run
 * inside `db.atomic`, which — unlike the Postgres adapter, where this needed
 * its own SERIALIZABLE transaction and a retry loop to notice a concurrent
 * `identity_links` write — makes the `identity_links` check, the insert and
 * every `membership_roles` insert one indivisible step: nothing can link the
 * identity in between. (docs/security-pentest-2026-09-24.md Rondas 6-8.)
 */
async function performCreate(db: SqliteExecutor, input: CreateMembershipInput): Promise<Membership> {
  const roleIds = input.roleIds ?? [];

  // Validated BEFORE inserting the membership row so a bad roleId never
  // leaves an orphaned membership behind (Hallazgo 2).
  if (roleIds.length > 0) {
    const validRoles = await db.query<{ id: string }>(
      `select id from uniora_roles where id in (select value from json_each(?1)) and organization_id = ?2`,
      [jsonList(roleIds), input.organizationId],
    );
    const validIds = new Set(validRoles.rows.map((row) => row.id));
    const invalidRoleId = roleIds.find((roleId) => !validIds.has(roleId));
    if (invalidRoleId !== undefined) {
      throw new MembershipError(
        `Cannot assign role "${invalidRoleId}" to membership "${input.id}": the role does not exist or belongs to a different organization than "${input.organizationId}".`,
      );
    }
  }

  // The `where not exists` makes "this identity is already an alias of
  // another" part of the SAME statement as the insert (Ronda 7: link() refuses
  // a `from` identity that owns a membership, and this closes the opposite
  // order). A duplicate id/identity-in-org still throws from the constraint;
  // an alias conflict instead inserts zero rows, handled right after.
  let result;
  try {
    result = await db.query(
      `insert into uniora_memberships (id, organization_id, provider, subject)
       select ?1, ?2, ?3, ?4
       where not exists (
         select 1 from uniora_identity_links
         where from_provider = ?3 and from_subject = ?4
       )`,
      [input.id, input.organizationId, input.identity.provider, input.identity.subject],
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      if (violatedExactly(error, ["uniora_memberships.id"])) {
        throw new MembershipError(`A membership with id "${input.id}" already exists.`);
      }
      throw new MembershipError(
        `Identity ${input.identity.provider}:${input.identity.subject} already has a membership in organization "${input.organizationId}".`,
      );
    }
    throw error;
  }
  if (result.rowCount === 0) {
    throw new MembershipError(
      `Cannot create a direct membership for identity ${input.identity.provider}:${input.identity.subject}: it is already linked as an alias of another identity (see IdentityLinkRepository.link) — creating a direct membership here would produce an ambiguous/hijackable lookup.`,
    );
  }

  // The organization is re-checked FRESH, correlated within each insert,
  // rather than trusting the batch validation above (Ronda 8, ABA: `roles.id`
  // is a global key, so a role can be deleted and recreated under the same id
  // in another organization between those two steps).
  for (const roleId of roleIds) {
    await db.query(
      `insert into uniora_membership_roles (membership_id, role_id)
       select ?1, ?2
       where exists (select 1 from uniora_roles r where r.id = ?2 and r.organization_id = ?3)
       on conflict do nothing`,
      [input.id, roleId, input.organizationId],
    );
  }

  return { id: input.id, organizationId: input.organizationId, identity: input.identity, roleIds: [...roleIds] };
}

export function createMembershipRepository(db: SqliteExecutor): MembershipRepository {
  return {
    async create(input: CreateMembershipInput) {
      return db.atomic(() => performCreate(db, input));
    },

    async findByIdentity(organizationId: string, identity: Identity) {
      // Matches directly, or transparently through a cross-provider identity
      // link (`uniora_identity_links`) — so a migrated identity resolves to
      // the same membership without any role/permission being touched.
      const result = await db.query<MembershipRow>(
        `${SELECT_MEMBERSHIP_WITH_ROLES}
         where m.organization_id = ?1
           and (
             (m.provider = ?2 and m.subject = ?3)
             or exists (
               select 1 from uniora_identity_links il
               where il.from_provider = ?2 and il.from_subject = ?3
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
        `${SELECT_MEMBERSHIP_WITH_ROLES} where m.organization_id = ?1 group by m.id`,
        [organizationId],
      );
      return result.rows.map(toMembership);
    },

    async findById(id: string) {
      const result = await db.query<MembershipRow>(`${SELECT_MEMBERSHIP_WITH_ROLES} where m.id = ?1 group by m.id`, [id]);
      return result.rows[0] ? toMembership(result.rows[0]) : null;
    },

    async search(options?: SearchMembershipsOptions) {
      const query = options?.query?.trim();
      // Page the memberships FIRST (index-ordered by id, limited), and only
      // then join/aggregate their roles — so the cost is one page of rows,
      // not "every matching member joined to its roles".
      const result = await db.query<MembershipRow>(
        `select m.id, m.organization_id, m.provider, m.subject,
                json_group_array(mr.role_id order by mr.role_id) filter (where mr.role_id is not null) as role_ids
         from (
           select id, organization_id, provider, subject
           from uniora_memberships
           where (?1 is null or organization_id = ?1)
             and (?2 is null or uniora_ilike(provider, ?2) or uniora_ilike(subject, ?2))
             and (?3 is null or id > ?3)
             and (?5 is null or (provider = ?5 and subject = ?6))
           order by id asc
           limit coalesce(?4, -1)
         ) m
         left join uniora_membership_roles mr on mr.membership_id = m.id
         group by m.id, m.organization_id, m.provider, m.subject
         order by m.id asc`,
        [options?.organizationId ?? null, query ? toLikePattern(query) : null, options?.after ?? null, options?.limit ?? null, options?.identity?.provider ?? null, options?.identity?.subject ?? null],
      );
      return result.rows.map(toMembership);
    },

    async searchListing(options: SearchMembershipsOptions & { rolesPerMember: number }) {
      const query = options.query?.trim();
      interface ListingRow {
        id: string;
        organization_id: string;
        provider: string;
        subject: string;
        role_count: number;
        roles: string;
      }
      interface ListingRole {
        id: string;
        organization_id: string;
        name: string;
        key: string;
        is_owner_role: number;
      }
      // Page the memberships first, then, per row, count its roles and take
      // only a bounded preview (Owner first, then by name) — so a member with
      // hundreds of roles costs the same as one with three.
      const result = await db.query<ListingRow>(
        `select m.id, m.organization_id, m.provider, m.subject,
                (select count(*) from uniora_membership_roles mr where mr.membership_id = m.id) as role_count,
                coalesce((
                  select json_group_array(json_object('id', p.id, 'organization_id', p.organization_id, 'name', p.name,
                                                      'key', p.key, 'is_owner_role', p.is_owner_role)
                                          order by p.is_owner_role desc, p.name, p.id)
                  from (
                    select r.id, r.organization_id, r.name, r.key, r.is_owner_role
                    from uniora_membership_roles mr
                    join uniora_roles r on r.id = mr.role_id
                    where mr.membership_id = m.id
                    order by r.is_owner_role desc, r.name, r.id
                    limit ?5
                  ) p
                ), '[]') as roles
         from (
           select id, organization_id, provider, subject
           from uniora_memberships
           where (?1 is null or organization_id = ?1)
             and (?2 is null or uniora_ilike(provider, ?2) or uniora_ilike(subject, ?2))
             and (?3 is null or id > ?3)
             and (?6 is null or (provider = ?6 and subject = ?7))
           order by id asc
           limit coalesce(?4, -1)
         ) m
         order by m.id asc`,
        [options.organizationId ?? null, query ? toLikePattern(query) : null, options.after ?? null, options.limit ?? null, options.rolesPerMember, options.identity?.provider ?? null, options.identity?.subject ?? null],
      );
      return result.rows.map(
        (row): MembershipListing => ({
          id: row.id,
          organizationId: row.organization_id,
          identity: { provider: row.provider, subject: row.subject },
          roleCount: Number(row.role_count),
          roles: (JSON.parse(row.roles) as ListingRole[]).map((role) => ({
            id: role.id,
            organizationId: role.organization_id,
            name: role.name,
            key: role.key,
            isOwnerRole: role.is_owner_role === 1,
          })),
        }),
      );
    },

    async count(options?: { organizationId?: string; query?: string; identity?: Identity }) {
      const query = options?.query?.trim();
      const result = await db.query<{ count: number }>(
        `select count(*) as count
         from uniora_memberships
         where (?1 is null or organization_id = ?1)
           and (?2 is null or uniora_ilike(provider, ?2) or uniora_ilike(subject, ?2))
           and (?3 is null or (provider = ?3 and subject = ?4))`,
        [options?.organizationId ?? null, query ? toLikePattern(query) : null, options?.identity?.provider ?? null, options?.identity?.subject ?? null],
      );
      return Number(result.rows[0]!.count);
    },

    async countByRole(roleIds: string[]) {
      const counts: Record<string, number> = Object.fromEntries(roleIds.map((id) => [id, 0]));
      if (roleIds.length === 0) return counts;
      const result = await db.query<{ role_id: string; count: number }>(
        `select role_id, count(*) as count from uniora_membership_roles where role_id in (select value from json_each(?1)) group by role_id`,
        [jsonList(roleIds)],
      );
      for (const row of result.rows) counts[row.role_id] = Number(row.count);
      return counts;
    },

    async countByOrganization(organizationIds: string[]) {
      return countByOrganization(db, "memberships", organizationIds);
    },

    async assignRole(membershipId: string, roleId: string) {
      await db.atomic(async () => {
        // The role's type is resolved and checked FIRST, unconditionally —
        // never skipped by an "already assigned" idempotency short-circuit
        // (Hallazgo 7): calling the wrong method must always be reported.
        const role = await db.query<{ organization_id: string; is_owner_role: number }>(
          `select organization_id, is_owner_role from uniora_roles where id = ?1`,
          [roleId],
        );
        const roleRow = role.rows[0];
        if (!roleRow) throw new MembershipError(`Role not found: ${roleId}`);
        if (roleRow.is_owner_role === 1) {
          throw new MembershipError(
            `Cannot assign the protected Owner role "${roleId}" via assignRole() — use assignOwnerRole() instead.`,
          );
        }

        // The organization match is re-read FRESH, correlated within the
        // insert itself, instead of trusting the snapshot above (Ronda 8, ABA).
        const result = await db.query(
          `insert into uniora_membership_roles (membership_id, role_id)
           select ?1, ?2
           where exists (
             select 1 from uniora_memberships m
             join uniora_roles r on r.id = ?2
             where m.id = ?1 and m.organization_id = r.organization_id
           )
           on conflict do nothing`,
          [membershipId, roleId],
        );
        if (result.rowCount > 0) return; // newly assigned

        const alreadyAssigned = await db.query(
          `select 1 from uniora_membership_roles where membership_id = ?1 and role_id = ?2`,
          [membershipId, roleId],
        );
        if (alreadyAssigned.rowCount > 0) return; // idempotent no-op

        const membership = await db.query(`select 1 from uniora_memberships where id = ?1`, [membershipId]);
        if (membership.rowCount === 0) throw new MembershipError(`Membership not found: ${membershipId}`);

        throw new MembershipError(
          `Cannot assign role "${roleId}" to membership "${membershipId}": the role belongs to a different organization than the membership.`,
        );
      });
    },

    async assignOwnerRole(membershipId: string, roleId: string) {
      await db.atomic(async () => {
        // Mirror of `assignRole` — role type checked first, unconditionally.
        const role = await db.query<{ organization_id: string; is_owner_role: number }>(
          `select organization_id, is_owner_role from uniora_roles where id = ?1`,
          [roleId],
        );
        const roleRow = role.rows[0];
        if (!roleRow) throw new MembershipError(`Role not found: ${roleId}`);
        if (roleRow.is_owner_role !== 1) {
          throw new MembershipError(`Role "${roleId}" is not the protected Owner role — use assignRole() instead.`);
        }

        const result = await db.query(
          `insert into uniora_membership_roles (membership_id, role_id)
           select ?1, ?2
           where exists (select 1 from uniora_memberships m where m.id = ?1 and m.organization_id = ?3)
           on conflict do nothing`,
          [membershipId, roleId, roleRow.organization_id],
        );
        if (result.rowCount > 0) return;

        const alreadyAssigned = await db.query(
          `select 1 from uniora_membership_roles where membership_id = ?1 and role_id = ?2`,
          [membershipId, roleId],
        );
        if (alreadyAssigned.rowCount > 0) return;

        const membership = await db.query(`select 1 from uniora_memberships where id = ?1`, [membershipId]);
        if (membership.rowCount === 0) throw new MembershipError(`Membership not found: ${membershipId}`);

        throw new MembershipError(
          `Cannot assign role "${roleId}" to membership "${membershipId}": the role belongs to a different organization than the membership.`,
        );
      });
    },

    async unassignRole(membershipId: string, roleId: string) {
      await db.atomic(async () => {
        // Role type checked first, unconditionally (Hallazgo 7). An unknown
        // `roleId` obviously isn't the Owner role that needs protecting, so it
        // falls through to the plain delete.
        const role = await db.query<{ is_owner_role: number }>(`select is_owner_role from uniora_roles where id = ?1`, [roleId]);
        if (role.rows[0]?.is_owner_role === 1) {
          throw new MembershipError(
            `Cannot unassign the protected Owner role "${roleId}" via unassignRole() — use unassignOwnerRole() instead.`,
          );
        }

        await db.query(`delete from uniora_membership_roles where membership_id = ?1 and role_id = ?2`, [membershipId, roleId]);
      });
    },

    async unassignOwnerRole(membershipId: string, roleId: string) {
      await db.atomic(async () => {
        // Role type checked first, unconditionally. An unknown `roleId` can't
        // be the Owner role, so it's an idempotent no-op.
        const role = await db.query<{ is_owner_role: number }>(`select is_owner_role from uniora_roles where id = ?1`, [roleId]);
        const roleRow = role.rows[0];
        if (!roleRow) return;
        if (roleRow.is_owner_role !== 1) {
          throw new MembershipError(`Role "${roleId}" is not the protected Owner role — use unassignRole() instead.`);
        }

        // Last-Owner guard (Hallazgo 8, the write-skew race: two Owners
        // removing EACH OTHER at once must never leave zero). Postgres needed
        // `SELECT ... FOR UPDATE` on every holder row to make the count
        // trustworthy; here the count and the delete run inside this
        // `begin immediate` transaction, and SQLite admits a single writer at
        // a time — across processes too — so the count can't go stale.
        const result = await db.query(
          `delete from uniora_membership_roles
           where membership_id = ?1 and role_id = ?2
             and (select count(*) from uniora_membership_roles where role_id = ?2) > 1`,
          [membershipId, roleId],
        );
        if (result.rowCount > 0) return;

        const stillAssigned = await db.query(
          `select 1 from uniora_membership_roles where membership_id = ?1 and role_id = ?2`,
          [membershipId, roleId],
        );
        if (stillAssigned.rowCount === 0) return; // wasn't assigned to begin with — idempotent no-op

        throw new MembershipError(LAST_OWNER_MESSAGE);
      });
    },

    async delete(membershipId: string) {
      await db.atomic(async () => {
        // Same last-Owner guard as `unassignOwnerRole` (deleting a membership
        // drops its Owner role the same way): refuse when this membership is
        // the only holder of the (at most one) protected Owner role it has.
        // A membership with no Owner role never matches the subquery, so the
        // ordinary delete path is unaffected.
        const result = await db.query(
          `delete from uniora_memberships
           where id = ?1
             and not exists (
               select 1
               from uniora_membership_roles mr
               join uniora_roles r on r.id = mr.role_id
               where mr.membership_id = ?1 and r.is_owner_role = 1
                 and (select count(*) from uniora_membership_roles holders where holders.role_id = mr.role_id) <= 1
             )`,
          [membershipId],
        );
        if (result.rowCount > 0) return;

        const stillExists = await db.query(`select 1 from uniora_memberships where id = ?1`, [membershipId]);
        if (stillExists.rowCount > 0) throw new MembershipError(LAST_OWNER_MESSAGE);
        throw new MembershipError(`Membership not found: ${membershipId}`);
      });
    },
  };
}
