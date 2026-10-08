import type {
  AddTeamMemberInput,
  SearchTeamMembersOptions,
  SetTeamMemberStatusInput,
  TeamMemberChangeOptions,
  TeamMemberStatus,
  TeamMembership,
  TeamMembershipRepository,
  TeamResponsibility,
} from "@uniora/core";
import {
  TeamError,
  assertExpectedVersion,
  assertTeamMemberStatus,
  assertTeamResponsibility,
  assertValidAddTeamMember,
  isTeamMemberTransitionAllowed,
  sanitizeTeamReason,
} from "@uniora/core";
import type { Queryable } from "../queryable.js";
import { isForeignKeyViolation, isUniqueViolation } from "../pg-errors.js";

interface TeamMembershipRow {
  id: string;
  organization_id: string;
  team_id: string;
  membership_id: string;
  status: TeamMemberStatus;
  responsibility: TeamResponsibility;
  role_ids: string[];
  created_at: Date;
  updated_at: Date;
  joined_at: Date | null;
  invited_by_provider: string | null;
  invited_by_subject: string | null;
  status_changed_at: Date | null;
  status_changed_by_provider: string | null;
  status_changed_by_subject: string | null;
  status_reason: string | null;
  version: number;
}

const COLUMNS = `tm.id, tm.organization_id, tm.team_id, tm.membership_id, tm.status, tm.responsibility,
  coalesce((select array_agg(r.role_id order by r.role_id) from uniora.team_membership_roles r where r.team_membership_id = tm.id), '{}') as role_ids,
  tm.created_at, tm.updated_at, tm.joined_at, tm.invited_by_provider, tm.invited_by_subject,
  tm.status_changed_at, tm.status_changed_by_provider, tm.status_changed_by_subject, tm.status_reason, tm.version`;

function toTeamMembership(row: TeamMembershipRow): TeamMembership {
  return {
    id: row.id,
    organizationId: row.organization_id,
    teamId: row.team_id,
    membershipId: row.membership_id,
    status: row.status,
    responsibility: row.responsibility,
    roleIds: row.role_ids,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.joined_at !== null ? { joinedAt: row.joined_at } : {}),
    ...(row.invited_by_provider !== null && row.invited_by_subject !== null
      ? { invitedBy: { provider: row.invited_by_provider, subject: row.invited_by_subject } }
      : {}),
    ...(row.status_changed_at !== null && row.status_changed_by_provider !== null && row.status_changed_by_subject !== null
      ? {
          statusChange: {
            at: row.status_changed_at,
            by: { provider: row.status_changed_by_provider, subject: row.status_changed_by_subject },
            ...(row.status_reason !== null ? { reason: row.status_reason } : {}),
          },
        }
      : {}),
    version: row.version,
  };
}

export function createTeamMembershipRepository(db: Queryable): TeamMembershipRepository {
  const where = (options: Omit<SearchTeamMembersOptions, "limit" | "after">): { sql: string; params: unknown[] } => ({
    sql: `tm.organization_id = $1
      and ($2::text is null or tm.team_id = $2)
      and ($3::text is null or tm.membership_id = $3)
      and ($4::text is null or tm.status = $4)
      and ($5::text is null or tm.responsibility = $5)
      and ($6::text is null or exists (
        select 1 from uniora.memberships m where m.id = tm.membership_id and m.provider = $6 and m.subject = $7))`,
    params: [
      options.organizationId,
      options.teamId ?? null,
      options.membershipId ?? null,
      options.status ?? null,
      options.responsibility ?? null,
      options.identity?.provider ?? null,
      options.identity?.subject ?? null,
    ],
  });

  const byId = async (organizationId: string, id: string): Promise<TeamMembership | null> => {
    const result = await db.query<TeamMembershipRow>(
      `select ${COLUMNS} from uniora.team_memberships tm where tm.id = $1 and tm.organization_id = $2`,
      [id, organizationId],
    );
    return result.rows[0] ? toTeamMembership(result.rows[0]) : null;
  };

  const require = async (organizationId: string, id: string): Promise<TeamMembership> => {
    const row = await byId(organizationId, id);
    if (!row) throw new TeamError(`Team membership not found: ${id}`, "team_membership_not_found");
    return row;
  };

  /** Roles must exist in the organization and none may be its Owner role. */
  async function assertRoles(organizationId: string, roleIds: string[]): Promise<void> {
    if (roleIds.length === 0) return;
    const result = await db.query<{ id: string; is_owner_role: boolean }>(
      `select id, is_owner_role from uniora.roles where organization_id = $1 and id = any($2::text[])`,
      [organizationId, roleIds],
    );
    if (result.rows.length !== roleIds.length) {
      throw new TeamError("Every role of a team member must exist in the same organization.", "team_role_invalid");
    }
    if (result.rows.some((row) => row.is_owner_role)) {
      throw new TeamError("The Owner role cannot be held inside a team.", "team_role_owner_protected");
    }
  }

  function assertVersion(row: TeamMembership, expected: number | undefined): void {
    if (expected !== undefined && expected !== row.version) {
      throw new TeamError(`The team membership changed (version ${row.version}, expected ${expected}).`, "team_membership_version_conflict");
    }
  }

  /** Read, decide, write guarded by the version just read; start over if somebody got in between (see `team.ts`). */
  async function mutate(
    organizationId: string,
    id: string,
    expectedVersion: number | undefined,
    step: (current: TeamMembership) => Promise<TeamMembership | null>,
  ): Promise<TeamMembership> {
    const expected = assertExpectedVersion(expectedVersion);
    for (let attempt = 0; attempt < 5; attempt++) {
      const current = await require(organizationId, id);
      assertVersion(current, expected);
      const next = await step(current);
      if (next !== null) return next;
      if (expected !== undefined) throw new TeamError("The team membership changed since it was read.", "team_membership_version_conflict");
    }
    throw new TeamError("The team membership keeps changing concurrently; try again.", "team_membership_version_conflict");
  }

  return {
    async add(input: AddTeamMemberInput) {
      const valid = assertValidAddTeamMember(input);
      const team = await db.query<{ status: string }>(`select status from uniora.teams where id = $1 and organization_id = $2`, [input.teamId, input.organizationId]);
      if (!team.rows[0]) throw new TeamError(`Team not found: ${input.teamId}`, "team_not_found");
      const member = await db.query(`select 1 from uniora.memberships where id = $1 and organization_id = $2`, [input.membershipId, input.organizationId]);
      if (member.rows.length === 0) {
        throw new TeamError(`Membership "${input.membershipId}" does not exist in this organization.`, "team_member_unknown");
      }
      if (team.rows[0].status !== "active") throw new TeamError("An archived team accepts no new members; restore it first.", "team_archived");
      await assertRoles(input.organizationId, valid.roleIds);

      for (let attempt = 0; attempt < 5; attempt++) {
        const existing = await db.query<TeamMembershipRow>(
          `select ${COLUMNS} from uniora.team_memberships tm where tm.team_id = $1 and tm.membership_id = $2`,
          [input.teamId, input.membershipId],
        );
        const previous = existing.rows[0];
        if (previous && previous.status !== "removed") {
          throw new TeamError("This member already belongs to the team (or has a pending invitation).", "team_membership_exists");
        }
        try {
          if (previous) {
            // Bring a removed member back on the same row, so the history (id, creation, first join) stays.
            await db.query(
              `with upd as (
                 update uniora.team_memberships
                 set status = $3, responsibility = $4, updated_at = $5, invited_by_provider = $6, invited_by_subject = $7,
                     joined_at = case when $3 = 'active' then coalesce(joined_at, $5) else joined_at end,
                     version = version + 1
                 where id = $1 and organization_id = $2 and status = 'removed' and version = $8 returning id
               )
               insert into uniora.team_membership_roles (team_membership_id, role_id, organization_id)
               select $1, r, $2 from unnest($9::text[]) as r where exists (select 1 from upd)`,
              [previous.id, input.organizationId, valid.status, valid.responsibility, valid.now, input.invitedBy?.provider ?? null, input.invitedBy?.subject ?? null, previous.version, valid.roleIds],
            );
            const done = await byId(input.organizationId, previous.id);
            if (done && done.version === previous.version + 1) return done;
            continue;
          }
          await db.query(
            `with ins as (
               insert into uniora.team_memberships
                 (id, organization_id, team_id, membership_id, status, responsibility, created_at, updated_at, joined_at, invited_by_provider, invited_by_subject)
               select $1, $2, $3, $4, $5, $6, $7, $7, $8, $9, $10
               where exists (select 1 from uniora.teams t where t.id = $3 and t.organization_id = $2 and t.status = 'active')
               returning id
             )
             insert into uniora.team_membership_roles (team_membership_id, role_id, organization_id)
             select $1, r, $2 from unnest($11::text[]) as r where exists (select 1 from ins)`,
            [input.id, input.organizationId, input.teamId, input.membershipId, valid.status, valid.responsibility, valid.now, valid.status === "active" ? valid.now : null, input.invitedBy?.provider ?? null, input.invitedBy?.subject ?? null, valid.roleIds],
          );
          const created = await byId(input.organizationId, input.id);
          if (!created) throw new TeamError("An archived team accepts no new members; restore it first.", "team_archived");
          return created;
        } catch (error) {
          if (isUniqueViolation(error)) {
            const clash = await db.query(`select 1 from uniora.team_memberships where team_id = $1 and membership_id = $2`, [input.teamId, input.membershipId]);
            if (clash.rows.length === 0) throw new TeamError(`A team membership with id "${input.id}" already exists.`, "team_membership_exists");
            continue;
          }
          if (isForeignKeyViolation(error)) throw new TeamError("The team, the member or one of the roles was removed meanwhile.", "team_role_invalid");
          throw error;
        }
      }
      throw new TeamError("The team membership keeps changing concurrently; try again.", "team_membership_exists");
    },

    findById: byId,

    async find(organizationId, teamId, membershipId) {
      const result = await db.query<TeamMembershipRow>(
        `select ${COLUMNS} from uniora.team_memberships tm where tm.organization_id = $1 and tm.team_id = $2 and tm.membership_id = $3`,
        [organizationId, teamId, membershipId],
      );
      return result.rows[0] ? toTeamMembership(result.rows[0]) : null;
    },

    async search(options: SearchTeamMembersOptions) {
      const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
      const filter = where(options);
      const result = await db.query<TeamMembershipRow>(
        `select ${COLUMNS} from uniora.team_memberships tm where ${filter.sql} and ($8::text is null or tm.id > $8) order by tm.id limit $9`,
        [...filter.params, options.after ?? null, limit],
      );
      return result.rows.map(toTeamMembership);
    },

    async count(options) {
      const filter = where(options);
      const result = await db.query<{ n: string }>(`select count(*) as n from uniora.team_memberships tm where ${filter.sql}`, filter.params);
      return Number(result.rows[0]!.n);
    },

    async setStatus(organizationId: string, id: string, status: TeamMemberStatus, input: SetTeamMemberStatusInput) {
      assertTeamMemberStatus(status);
      const reason = sanitizeTeamReason(input.reason);
      return mutate(organizationId, id, input.expectedVersion, async (current) => {
        if (current.status === status) return current;
        if (!isTeamMemberTransitionAllowed(current.status, status)) {
          throw new TeamError(`A ${current.status} team membership cannot become ${status}.`, "team_membership_transition_invalid");
        }
        // Removing someone drops the roles they held in the team, in the same statement.
        const result = await db.query<{ n: string }>(
          `with upd as (
             update uniora.team_memberships
             set status = $4, updated_at = date_trunc('milliseconds', now()),
                 joined_at = case when $4 = 'active' then coalesce(joined_at, date_trunc('milliseconds', now())) else joined_at end,
                 status_changed_at = date_trunc('milliseconds', now()), status_changed_by_provider = $5, status_changed_by_subject = $6, status_reason = $7,
                 version = version + 1
             where id = $1 and organization_id = $2 and version = $3 and status = $8 returning id
           ),
           dropped as (
             delete from uniora.team_membership_roles where team_membership_id = $1 and $4 = 'removed' and exists (select 1 from upd) returning 1
           )
           select count(*) as n from upd`,
          [id, organizationId, current.version, status, input.actor.provider, input.actor.subject, reason ?? null, current.status],
        );
        if (Number(result.rows[0]!.n) === 0) return null;
        return byId(organizationId, id);
      });
    },

    async accept(organizationId, id, input) {
      return mutate(organizationId, id, input.expectedVersion, async (current) => {
        const owner = await db.query(
          `select 1 from uniora.team_memberships tm join uniora.memberships m on m.id = tm.membership_id and m.organization_id = tm.organization_id
           where tm.id = $1 and tm.organization_id = $2 and m.provider = $3 and m.subject = $4`,
          [id, organizationId, input.actor.provider, input.actor.subject],
        );
        if (owner.rows.length === 0) throw new TeamError("Only the invited person can accept a team invitation.", "team_accept_forbidden");
        if (current.status === "active") return current;
        if (current.status !== "pending") {
          throw new TeamError(`A ${current.status} team membership cannot be accepted.`, "team_membership_transition_invalid");
        }
        const result = await db.query(
          `update uniora.team_memberships
           set status = 'active', updated_at = date_trunc('milliseconds', now()), joined_at = coalesce(joined_at, date_trunc('milliseconds', now())),
               status_changed_at = date_trunc('milliseconds', now()), status_changed_by_provider = $4, status_changed_by_subject = $5, status_reason = null,
               version = version + 1
           where id = $1 and organization_id = $2 and version = $3 and status = 'pending'`,
          [id, organizationId, current.version, input.actor.provider, input.actor.subject],
        );
        return (result.rowCount ?? 0) > 0 ? byId(organizationId, id) : null;
      });
    },

    async setResponsibility(organizationId, id, responsibility, options?: TeamMemberChangeOptions) {
      assertTeamResponsibility(responsibility);
      return mutate(organizationId, id, options?.expectedVersion, async (current) => {
        if (current.responsibility === responsibility) return current;
        const result = await db.query(
          `update uniora.team_memberships set responsibility = $4, updated_at = date_trunc('milliseconds', now()), version = version + 1
           where id = $1 and organization_id = $2 and version = $3`,
          [id, organizationId, current.version, responsibility],
        );
        return (result.rowCount ?? 0) > 0 ? byId(organizationId, id) : null;
      });
    },

    async assignRole(organizationId, id, roleId, options?: TeamMemberChangeOptions) {
      await require(organizationId, id);
      await assertRoles(organizationId, [roleId]);
      return mutate(organizationId, id, options?.expectedVersion, async (current) => {
        if (current.roleIds.includes(roleId)) return current;
        try {
          const result = await db.query(
            `with upd as (
               update uniora.team_memberships set updated_at = date_trunc('milliseconds', now()), version = version + 1
               where id = $1 and organization_id = $2 and version = $3 returning id
             )
             insert into uniora.team_membership_roles (team_membership_id, role_id, organization_id)
             select $1, $4, $2 from upd`,
            [id, organizationId, current.version, roleId],
          );
          return (result.rowCount ?? 0) > 0 ? byId(organizationId, id) : null;
        } catch (error) {
          if (isUniqueViolation(error)) return null;
          if (isForeignKeyViolation(error)) throw new TeamError("The role was removed meanwhile.", "team_role_invalid");
          throw error;
        }
      });
    },

    async unassignRole(organizationId, id, roleId, options?: TeamMemberChangeOptions) {
      return mutate(organizationId, id, options?.expectedVersion, async (current) => {
        if (!current.roleIds.includes(roleId)) return current;
        const result = await db.query<{ n: string }>(
          `with upd as (
             update uniora.team_memberships set updated_at = date_trunc('milliseconds', now()), version = version + 1
             where id = $1 and organization_id = $2 and version = $3 returning id
           ),
           dropped as (
             delete from uniora.team_membership_roles where team_membership_id = $1 and role_id = $4 and exists (select 1 from upd) returning 1
           )
           select count(*) as n from upd`,
          [id, organizationId, current.version, roleId],
        );
        return Number(result.rows[0]!.n) > 0 ? byId(organizationId, id) : null;
      });
    },
  };
}
