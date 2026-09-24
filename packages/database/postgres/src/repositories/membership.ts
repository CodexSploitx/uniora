import type { CreateMembershipInput, Identity, Membership, MembershipListing, MembershipRepository, SearchMembershipsOptions } from "@uniora/core";
import { MembershipError } from "@uniora/core";
import type { Queryable } from "../queryable.js";
import { countByOrganization } from "../pg-counts.js";
import { toLikePattern } from "../pg-like.js";

interface MembershipRow {
  id: string;
  organization_id: string;
  provider: string;
  subject: string;
  role_ids: string[];
}

function toMembership(row: MembershipRow): Membership {
  return {
    id: row.id,
    organizationId: row.organization_id,
    identity: { provider: row.provider, subject: row.subject },
    roleIds: row.role_ids,
  };
}

const SELECT_MEMBERSHIP_WITH_ROLES = `
  select m.id, m.organization_id, m.provider, m.subject,
         coalesce(array_agg(mr.role_id) filter (where mr.role_id is not null), '{}') as role_ids
  from uniora.memberships m
  left join uniora.membership_roles mr on mr.membership_id = m.id
`;

export function createMembershipRepository(db: Queryable): MembershipRepository {
  return {
    async create(input: CreateMembershipInput) {
      await db.query(
        `insert into uniora.memberships (id, organization_id, provider, subject) values ($1, $2, $3, $4)`,
        [input.id, input.organizationId, input.identity.provider, input.identity.subject],
      );

      for (const roleId of input.roleIds ?? []) {
        await db.query(
          `insert into uniora.membership_roles (membership_id, role_id) values ($1, $2) on conflict do nothing`,
          [input.id, roleId],
        );
      }

      return { id: input.id, organizationId: input.organizationId, identity: input.identity, roleIds: [...(input.roleIds ?? [])] };
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
      // Page the memberships FIRST (index-ordered by id, limited), and only
      // then join/aggregate their roles — so the cost is one page of rows,
      // not "every matching member joined to its roles".
      const result = await db.query<MembershipRow>(
        `select m.id, m.organization_id, m.provider, m.subject,
                coalesce(array_agg(mr.role_id) filter (where mr.role_id is not null), '{}') as role_ids
         from (
           select id, organization_id, provider, subject
           from uniora.memberships
           where ($1::text is null or organization_id = $1)
             and ($2::text is null or provider ilike $2 or subject ilike $2)
             and ($3::text is null or id > $3)
             and ($5::text is null or (provider = $5 and subject = $6))
           order by id asc
           limit $4
         ) m
         left join uniora.membership_roles mr on mr.membership_id = m.id
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
        roles: { id: string; organization_id: string; name: string; key: string; is_owner_role: boolean }[];
      }
      // Page the memberships first, then, per row, count its roles and take
      // only a bounded preview (Owner first, then by name) — so a member with
      // hundreds of roles costs the same as one with three.
      const result = await db.query<ListingRow>(
        `select m.id, m.organization_id, m.provider, m.subject,
                (select count(*) from uniora.membership_roles mr where mr.membership_id = m.id)::int as role_count,
                coalesce((
                  select json_agg(json_build_object('id', p.id, 'organization_id', p.organization_id, 'name', p.name,
                                                    'key', p.key, 'is_owner_role', p.is_owner_role)
                                  order by p.is_owner_role desc, p.name, p.id)
                  from (
                    select r.id, r.organization_id, r.name, r.key, r.is_owner_role
                    from uniora.membership_roles mr
                    join uniora.roles r on r.id = mr.role_id
                    where mr.membership_id = m.id
                    order by r.is_owner_role desc, r.name, r.id
                    limit $5
                  ) p
                ), '[]'::json) as roles
         from (
           select id, organization_id, provider, subject
           from uniora.memberships
           where ($1::text is null or organization_id = $1)
             and ($2::text is null or provider ilike $2 or subject ilike $2)
             and ($3::text is null or id > $3)
             and ($6::text is null or (provider = $6 and subject = $7))
           order by id asc
           limit $4
         ) m
         order by m.id asc`,
        [options.organizationId ?? null, query ? toLikePattern(query) : null, options.after ?? null, options.limit ?? null, options.rolesPerMember, options.identity?.provider ?? null, options.identity?.subject ?? null],
      );
      return result.rows.map(
        (row): MembershipListing => ({
          id: row.id,
          organizationId: row.organization_id,
          identity: { provider: row.provider, subject: row.subject },
          roleCount: row.role_count,
          roles: row.roles.map((role) => ({
            id: role.id,
            organizationId: role.organization_id,
            name: role.name,
            key: role.key,
            isOwnerRole: role.is_owner_role,
          })),
        }),
      );
    },

    async count(options?: { organizationId?: string; query?: string; identity?: Identity }) {
      const query = options?.query?.trim();
      const result = await db.query<{ count: string }>(
        `select count(*)::text as count
         from uniora.memberships
         where ($1::text is null or organization_id = $1)
           and ($2::text is null or provider ilike $2 or subject ilike $2)
           and ($3::text is null or (provider = $3 and subject = $4))`,
        [options?.organizationId ?? null, query ? toLikePattern(query) : null, options?.identity?.provider ?? null, options?.identity?.subject ?? null],
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

    async countByOrganization(organizationIds: string[]) {
      return countByOrganization(db, "memberships", organizationIds);
    },

    async assignRole(membershipId: string, roleId: string) {
      await db.query(
        `insert into uniora.membership_roles (membership_id, role_id) values ($1, $2) on conflict do nothing`,
        [membershipId, roleId],
      );
    },

    async unassignRole(membershipId: string, roleId: string) {
      // Single WHERE-guarded DELETE, not check-then-delete: the "never drop
      // the organization's last Owner" decision must be atomic with the
      // unassignment itself (uniora-security-engineering §11, §21 Race
      // Conditions). A role is only ever the protected Owner role for one
      // organization, so checking by `roleId` alone is already tenant-safe.
      const result = await db.query(
        `delete from uniora.membership_roles mr
         where mr.membership_id = $1 and mr.role_id = $2
           and (
             not exists (select 1 from uniora.roles r where r.id = $2 and r.is_owner_role)
             or exists (
               select 1 from uniora.membership_roles mr2
               where mr2.role_id = $2 and mr2.membership_id <> $1
             )
           )`,
        [membershipId, roleId],
      );
      if ((result.rowCount ?? 0) > 0) return;

      const stillAssigned = await db.query(
        `select 1 from uniora.membership_roles where membership_id = $1 and role_id = $2`,
        [membershipId, roleId],
      );
      if ((stillAssigned.rowCount ?? 0) > 0) {
        throw new MembershipError(
          "Cannot remove the organization's last Owner — every organization must keep at least one.",
        );
      }
      // else: wasn't assigned to begin with — idempotent no-op.
    },

    async delete(membershipId: string) {
      // Same atomic WHERE-guard pattern as `unassignRole`: the delete
      // itself carries the "not the org's last Owner" check, so there is
      // no window where a concurrent request could observe (or create) an
      // organization with zero Owners.
      const result = await db.query(
        `delete from uniora.memberships m
         where m.id = $1
           and not exists (
             select 1
             from uniora.membership_roles mr
             join uniora.roles r on r.id = mr.role_id
             where mr.membership_id = m.id
               and r.is_owner_role
               and not exists (
                 select 1 from uniora.membership_roles mr2
                 where mr2.role_id = mr.role_id and mr2.membership_id <> m.id
               )
           )`,
        [membershipId],
      );
      if ((result.rowCount ?? 0) > 0) return;

      const stillExists = await db.query(`select 1 from uniora.memberships where id = $1`, [membershipId]);
      if ((stillExists.rowCount ?? 0) > 0) {
        throw new MembershipError(
          "Cannot remove the organization's last Owner — every organization must keep at least one.",
        );
      }
      throw new MembershipError(`Membership not found: ${membershipId}`);
    },
  };
}
