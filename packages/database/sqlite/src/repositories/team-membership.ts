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
import type { SqliteExecutor } from "../executor.js";
import { parseList } from "../json.js";
import { isForeignKeyViolation, isUniqueViolation } from "../sqlite-errors.js";

interface TeamMembershipRow {
  id: string;
  organization_id: string;
  team_id: string;
  membership_id: string;
  status: TeamMemberStatus;
  responsibility: TeamResponsibility;
  role_ids: string;
  created_at: string;
  updated_at: string;
  joined_at: string | null;
  invited_by_provider: string | null;
  invited_by_subject: string | null;
  status_changed_at: string | null;
  status_changed_by_provider: string | null;
  status_changed_by_subject: string | null;
  status_reason: string | null;
  version: number;
}

const COLUMNS = `tm.id, tm.organization_id, tm.team_id, tm.membership_id, tm.status, tm.responsibility,
  (select json_group_array(role_id) from (select role_id from uniora_team_membership_roles r where r.team_membership_id = tm.id order by role_id)) as role_ids,
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
    roleIds: parseList(row.role_ids),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    ...(row.joined_at !== null ? { joinedAt: new Date(row.joined_at) } : {}),
    ...(row.invited_by_provider !== null && row.invited_by_subject !== null
      ? { invitedBy: { provider: row.invited_by_provider, subject: row.invited_by_subject } }
      : {}),
    ...(row.status_changed_at !== null && row.status_changed_by_provider !== null && row.status_changed_by_subject !== null
      ? {
          statusChange: {
            at: new Date(row.status_changed_at),
            by: { provider: row.status_changed_by_provider, subject: row.status_changed_by_subject },
            ...(row.status_reason !== null ? { reason: row.status_reason } : {}),
          },
        }
      : {}),
    version: row.version,
  };
}

export function createTeamMembershipRepository(db: SqliteExecutor): TeamMembershipRepository {
  const where = (options: Omit<SearchTeamMembersOptions, "limit" | "after">): { sql: string; params: unknown[] } => ({
    sql: `tm.organization_id = ?1
      and (?2 is null or tm.team_id = ?2)
      and (?3 is null or tm.membership_id = ?3)
      and (?4 is null or tm.status = ?4)
      and (?5 is null or tm.responsibility = ?5)
      and (?6 is null or exists (
        select 1 from uniora_memberships m where m.id = tm.membership_id and m.provider = ?6 and m.subject = ?7))`,
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
    const result = await db.query<TeamMembershipRow>(`select ${COLUMNS} from uniora_team_memberships tm where tm.id = ?1 and tm.organization_id = ?2`, [id, organizationId]);
    return result.rows[0] ? toTeamMembership(result.rows[0]) : null;
  };

  async function assertRoles(organizationId: string, roleIds: string[]): Promise<void> {
    if (roleIds.length === 0) return;
    const result = await db.query<{ id: string; is_owner_role: number }>(
      `select id, is_owner_role from uniora_roles where organization_id = ?1 and id in (select value from json_each(?2))`,
      [organizationId, JSON.stringify(roleIds)],
    );
    if (result.rows.length !== roleIds.length) {
      throw new TeamError("Every role of a team member must exist in the same organization.", "team_role_invalid");
    }
    if (result.rows.some((row) => Number(row.is_owner_role) === 1)) {
      throw new TeamError("The Owner role cannot be held inside a team.", "team_role_owner_protected");
    }
  }

  /** Read, check the version, change: all inside one writer turn. */
  function mutate(
    organizationId: string,
    id: string,
    expectedVersion: number | undefined,
    step: (current: TeamMembership) => Promise<TeamMembership>,
  ): Promise<TeamMembership> {
    const expected = assertExpectedVersion(expectedVersion);
    return db.atomic(async () => {
      const current = await byId(organizationId, id);
      if (!current) throw new TeamError(`Team membership not found: ${id}`, "team_membership_not_found");
      if (expected !== undefined && expected !== current.version) {
        throw new TeamError(`The team membership changed (version ${current.version}, expected ${expected}).`, "team_membership_version_conflict");
      }
      return step(current);
    });
  }

  const insertRoles = (teamMembershipId: string, organizationId: string, roleIds: string[]) =>
    db.query(
      `insert into uniora_team_membership_roles (team_membership_id, role_id, organization_id)
       select ?1, value, ?2 from json_each(?3)`,
      [teamMembershipId, organizationId, JSON.stringify(roleIds)],
    );

  return {
    async add(input: AddTeamMemberInput) {
      const valid = assertValidAddTeamMember(input);
      return db.atomic(async () => {
        const team = await db.query<{ status: string }>(`select status from uniora_teams where id = ?1 and organization_id = ?2`, [input.teamId, input.organizationId]);
        if (!team.rows[0]) throw new TeamError(`Team not found: ${input.teamId}`, "team_not_found");
        const member = await db.query(`select 1 from uniora_memberships where id = ?1 and organization_id = ?2`, [input.membershipId, input.organizationId]);
        if (member.rows.length === 0) {
          throw new TeamError(`Membership "${input.membershipId}" does not exist in this organization.`, "team_member_unknown");
        }
        if (team.rows[0].status !== "active") throw new TeamError("An archived team accepts no new members; restore it first.", "team_archived");
        await assertRoles(input.organizationId, valid.roleIds);
        const existing = await db.query<TeamMembershipRow>(
          `select ${COLUMNS} from uniora_team_memberships tm where tm.team_id = ?1 and tm.membership_id = ?2`,
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
              `update uniora_team_memberships
               set status = ?3, responsibility = ?4, updated_at = ?5, invited_by_provider = ?6, invited_by_subject = ?7,
                   joined_at = case when ?3 = 'active' then coalesce(joined_at, ?5) else joined_at end, version = version + 1
               where id = ?1 and organization_id = ?2`,
              [previous.id, input.organizationId, valid.status, valid.responsibility, valid.now, input.invitedBy?.provider ?? null, input.invitedBy?.subject ?? null],
            );
            await insertRoles(previous.id, input.organizationId, valid.roleIds);
            return (await byId(input.organizationId, previous.id))!;
          }
          await db.query(
            `insert into uniora_team_memberships
               (id, organization_id, team_id, membership_id, status, responsibility, created_at, updated_at, joined_at, invited_by_provider, invited_by_subject)
             values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?8, ?9, ?10)`,
            [input.id, input.organizationId, input.teamId, input.membershipId, valid.status, valid.responsibility, valid.now, valid.status === "active" ? valid.now : null, input.invitedBy?.provider ?? null, input.invitedBy?.subject ?? null],
          );
          await insertRoles(input.id, input.organizationId, valid.roleIds);
          return (await byId(input.organizationId, input.id))!;
        } catch (error) {
          if (isUniqueViolation(error)) throw new TeamError(`A team membership with id "${input.id}" already exists.`, "team_membership_exists");
          if (isForeignKeyViolation(error)) throw new TeamError("The team, the member or one of the roles does not exist.", "team_role_invalid");
          throw error;
        }
      });
    },

    findById: byId,

    async find(organizationId, teamId, membershipId) {
      const result = await db.query<TeamMembershipRow>(
        `select ${COLUMNS} from uniora_team_memberships tm where tm.organization_id = ?1 and tm.team_id = ?2 and tm.membership_id = ?3`,
        [organizationId, teamId, membershipId],
      );
      return result.rows[0] ? toTeamMembership(result.rows[0]) : null;
    },

    async search(options: SearchTeamMembersOptions) {
      const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
      const filter = where(options);
      const result = await db.query<TeamMembershipRow>(
        `select ${COLUMNS} from uniora_team_memberships tm where ${filter.sql} and (?8 is null or tm.id > ?8) order by tm.id limit ?9`,
        [...filter.params, options.after ?? null, limit],
      );
      return result.rows.map(toTeamMembership);
    },

    async count(options) {
      const filter = where(options);
      const result = await db.query<{ n: number }>(`select count(*) as n from uniora_team_memberships tm where ${filter.sql}`, filter.params);
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
        const now = new Date();
        await db.query(
          `update uniora_team_memberships
           set status = ?3, updated_at = ?4, joined_at = case when ?3 = 'active' then coalesce(joined_at, ?4) else joined_at end,
               status_changed_at = ?4, status_changed_by_provider = ?5, status_changed_by_subject = ?6, status_reason = ?7, version = version + 1
           where id = ?1 and organization_id = ?2`,
          [id, organizationId, status, now, input.actor.provider, input.actor.subject, reason ?? null],
        );
        // Removing someone drops the roles they held in the team.
        if (status === "removed") await db.query(`delete from uniora_team_membership_roles where team_membership_id = ?1`, [id]);
        return (await byId(organizationId, id))!;
      });
    },

    async setResponsibility(organizationId, id, responsibility, options?: TeamMemberChangeOptions) {
      assertTeamResponsibility(responsibility);
      return mutate(organizationId, id, options?.expectedVersion, async (current) => {
        if (current.responsibility === responsibility) return current;
        await db.query(
          `update uniora_team_memberships set responsibility = ?3, updated_at = ?4, version = version + 1 where id = ?1 and organization_id = ?2`,
          [id, organizationId, responsibility, new Date()],
        );
        return (await byId(organizationId, id))!;
      });
    },

    async assignRole(organizationId, id, roleId, options?: TeamMemberChangeOptions) {
      return mutate(organizationId, id, options?.expectedVersion, async (current) => {
        await assertRoles(organizationId, [roleId]);
        if (current.roleIds.includes(roleId)) return current;
        try {
          await insertRoles(id, organizationId, [roleId]);
        } catch (error) {
          if (isForeignKeyViolation(error)) throw new TeamError("The role was removed meanwhile.", "team_role_invalid");
          throw error;
        }
        await db.query(`update uniora_team_memberships set updated_at = ?3, version = version + 1 where id = ?1 and organization_id = ?2`, [id, organizationId, new Date()]);
        return (await byId(organizationId, id))!;
      });
    },

    async unassignRole(organizationId, id, roleId, options?: TeamMemberChangeOptions) {
      return mutate(organizationId, id, options?.expectedVersion, async (current) => {
        if (!current.roleIds.includes(roleId)) return current;
        await db.query(`delete from uniora_team_membership_roles where team_membership_id = ?1 and role_id = ?2`, [id, roleId]);
        await db.query(`update uniora_team_memberships set updated_at = ?3, version = version + 1 where id = ?1 and organization_id = ?2`, [id, organizationId, new Date()]);
        return (await byId(organizationId, id))!;
      });
    },
  };
}
