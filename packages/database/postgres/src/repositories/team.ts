import type {
  ArchiveTeamInput,
  CreateTeamInput,
  RestoreTeamInput,
  SearchTeamsOptions,
  TeamPlacementFacts,
  Team,
  TeamData,
  TeamRepository,
  TeamAuthorization,
  TeamStatus,
  UpdateTeamInput,
} from "@uniora/core";
import { TeamError, assertExpectedVersion, assertPathSourceTeams, assertTeamPlacement, assertTeamAuthorization, assertValidCreateTeam, assertValidUpdateTeam, sameTeamData, sanitizeTeamReason } from "@uniora/core";
import type { Queryable } from "../queryable.js";
import { isForeignKeyViolation, isUniqueViolation, violatedConstraint } from "../pg-errors.js";
import { toLikePattern } from "../pg-like.js";

interface TeamRow {
  id: string;
  organization_id: string;
  slug: string;
  name: string;
  status: TeamStatus;
  external_id: string | null;
  parent_id: string | null;
  metadata: TeamData;
  settings: TeamData;
  created_at: Date;
  updated_at: Date;
  archived_at: Date | null;
  archived_by_provider: string | null;
  archived_by_subject: string | null;
  archive_reason: string | null;
  version: number;
}

export const TEAM_COLUMNS =
  "id, organization_id, slug, name, status, external_id, parent_id, metadata, settings, created_at, updated_at, archived_at, archived_by_provider, archived_by_subject, archive_reason, version";

function toTeam(row: TeamRow): Team {
  return {
    id: row.id,
    organizationId: row.organization_id,
    slug: row.slug,
    name: row.name,
    status: row.status,
    ...(row.external_id !== null ? { externalId: row.external_id } : {}),
    ...(row.parent_id !== null ? { parentId: row.parent_id } : {}),
    metadata: row.metadata,
    settings: row.settings,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.archived_at !== null && row.archived_by_provider !== null && row.archived_by_subject !== null
      ? {
          archived: {
            at: row.archived_at,
            by: { provider: row.archived_by_provider, subject: row.archived_by_subject },
            ...(row.archive_reason !== null ? { reason: row.archive_reason } : {}),
          },
        }
      : {}),
    version: row.version,
  };
}

/** Maps the constraint a write hit to the stable team error. Rethrows anything it doesn't recognise. */
function translateWriteError(error: unknown, context: { id?: string; slug?: string; externalId?: string | null; organizationId?: string }): never {
  const constraint = violatedConstraint(error);
  if (isUniqueViolation(error)) {
    if (constraint === "teams_pkey") throw new TeamError(`A team with id "${context.id}" already exists.`, "team_exists");
    if (constraint === "teams_organization_id_slug_key") {
      throw new TeamError(`A team with slug "${context.slug}" already exists in this organization.`, "team_slug_taken");
    }
    if (constraint === "teams_external_id_idx") {
      throw new TeamError(`A team with external id "${context.externalId}" already exists in this organization.`, "team_external_id_taken");
    }
  }
  if (isForeignKeyViolation(error)) {
    if (constraint === "teams_parent_fk") throw new TeamError("The parent team does not exist in this organization.", "team_parent_invalid");
    throw new TeamError(`Organization "${context.organizationId}" does not exist.`, "team_organization_unknown");
  }
  throw error;
}

export function createTeamRepository(db: Queryable): TeamRepository {
  const byId = async (organizationId: string, id: string): Promise<Team | null> => {
    const result = await db.query<TeamRow>(`select ${TEAM_COLUMNS} from uniora.teams where id = $1 and organization_id = $2`, [id, organizationId]);
    return result.rows[0] ? toTeam(result.rows[0]) : null;
  };

  const requireTeam = async (organizationId: string, id: string): Promise<Team> => {
    const team = await byId(organizationId, id);
    if (!team) throw new TeamError(`Team not found: ${id}`, "team_not_found");
    return team;
  };

  function assertVersion(team: Team, expected: number | undefined): void {
    if (expected !== undefined && expected !== team.version) {
      throw new TeamError(`The team changed (version ${team.version}, expected ${expected}).`, "team_version_conflict");
    }
  }

  /**
   * Read, decide, then write guarded by the version just read; if somebody else got in between, start over (or, when the
   * caller pinned an `expectedVersion`, report the conflict). The decision is recomputed on the fresh row each time.
   */
  async function mutate(organizationId: string, id: string, expectedVersion: number | undefined, step: (current: Team) => Promise<Team | null>): Promise<Team> {
    const expected = assertExpectedVersion(expectedVersion);
    for (let attempt = 0; attempt < 5; attempt++) {
      const current = await requireTeam(organizationId, id);
      assertVersion(current, expected);
      const next = await step(current);
      if (next !== null) return next;
      if (expected !== undefined) throw new TeamError("The team changed since it was read.", "team_version_conflict");
    }
    throw new TeamError("The team keeps changing concurrently; try again.", "team_version_conflict");
  }

  const TREE_DEPTH_GUARD = 64;

  /** Serializes every change of the tree of one organization for the rest of the transaction (a no-op outside one). */
  const lockTree = (organizationId: string) => db.query(`select pg_advisory_xact_lock(hashtext($1))`, [`uniora:team-tree:${organizationId}`]);

  /** What the placement rules need to know, read with recursive queries over the organization's own rows. */
  async function placementFacts(organizationId: string, selfId: string | null, parentId: string): Promise<TeamPlacementFacts> {
    const parent = await db.query<{ status: TeamStatus }>(`select status from uniora.teams where id = $1 and organization_id = $2`, [parentId, organizationId]);
    if (!parent.rows[0]) return { selfId, parentId, parent: null, loop: false, subtreeHeight: 0 };
    const up = await db.query<{ id: string }>(
      `with recursive up as (
         select id, parent_id, 1 as depth from uniora.teams where id = $1 and organization_id = $2
         union all
         select t.id, t.parent_id, up.depth + 1 from uniora.teams t join up on t.id = up.parent_id
         where t.organization_id = $2 and up.depth < ${TREE_DEPTH_GUARD}
       ) select id from up`,
      [parentId, organizationId],
    );
    let subtreeHeight = 0;
    if (selfId !== null) {
      const down = await db.query<{ height: number | null }>(
        `with recursive down as (
           select id, 1 as depth from uniora.teams where parent_id = $1 and organization_id = $2
           union all
           select t.id, down.depth + 1 from uniora.teams t join down on t.parent_id = down.id
           where t.organization_id = $2 and down.depth < ${TREE_DEPTH_GUARD}
         ) select max(depth)::int as height from down`,
        [selfId, organizationId],
      );
      subtreeHeight = down.rows[0]?.height ?? 0;
    }
    return {
      selfId,
      parentId,
      parent: { status: parent.rows[0].status, depth: up.rows.length },
      loop: selfId !== null && up.rows.some((row) => row.id === selfId),
      subtreeHeight,
    };
  }

  return {
    async ancestors(organizationId: string, id: string) {
      await requireTeam(organizationId, id);
      const result = await db.query<TeamRow & { depth: number }>(
        `with recursive up as (
           select ${TEAM_COLUMNS}, 1 as depth from uniora.teams
           where id = (select parent_id from uniora.teams where id = $1 and organization_id = $2) and organization_id = $2
           union all
           select ${TEAM_COLUMNS.split(", ").map((c) => `t.${c}`).join(", ")}, up.depth + 1 from uniora.teams t join up on t.id = up.parent_id
           where t.organization_id = $2 and up.depth < ${TREE_DEPTH_GUARD}
         ) select * from up order by depth desc`,
        [id, organizationId],
      );
      return result.rows.map(toTeam);
    },

    async pathIds(organizationId: string, teamIds: readonly string[], options: { limit?: number } = {}) {
      const ids = assertPathSourceTeams(teamIds);
      if (ids.length === 0) return [];
      const limit = Math.min(Math.max(Math.trunc(options.limit ?? 1000), 1), 5000);
      // The given teams that exist in THIS organization, then their parents, level by level (bounded by the depth guard).
      const result = await db.query<{ id: string }>(
        `with recursive up(id, parent_id, depth) as (
           select id, parent_id, 1 from uniora.teams where organization_id = $1 and id = any($2::text[])
           union
           select t.id, t.parent_id, up.depth + 1 from uniora.teams t join up on t.id = up.parent_id
           where t.organization_id = $1 and up.depth < ${TREE_DEPTH_GUARD}
         ) select distinct id from up order by id limit $3`,
        [organizationId, ids, limit],
      );
      return result.rows.map((row) => row.id);
    },

    async descendants(organizationId: string, id: string) {
      await requireTeam(organizationId, id);
      const result = await db.query<TeamRow>(
        `with recursive down as (
           select ${TEAM_COLUMNS}, 1 as depth from uniora.teams where parent_id = $1 and organization_id = $2
           union all
           select ${TEAM_COLUMNS.split(", ").map((c) => `t.${c}`).join(", ")}, down.depth + 1 from uniora.teams t join down on t.parent_id = down.id
           where t.organization_id = $2 and down.depth < ${TREE_DEPTH_GUARD}
         ) select ${TEAM_COLUMNS} from down order by id`,
        [id, organizationId],
      );
      return result.rows.map(toTeam);
    },

    async create(input: CreateTeamInput) {
      assertTeamAuthorization(input.authorization, { organizationId: input.organizationId, operation: "team.create" });
      const valid = assertValidCreateTeam(input);
      try {
        if (valid.parentId !== undefined) {
          await lockTree(input.organizationId);
          assertTeamPlacement(await placementFacts(input.organizationId, null, valid.parentId));
        }
        const result = await db.query<TeamRow>(
          `insert into uniora.teams (id, organization_id, slug, name, external_id, parent_id, metadata, settings, created_at, updated_at)
           values ($1, $2, $3, $4, $5, $9, $6::jsonb, $7::jsonb, $8, $8) returning ${TEAM_COLUMNS}`,
          [input.id, input.organizationId, valid.slug, valid.name, valid.externalId ?? null, JSON.stringify(valid.metadata), JSON.stringify(valid.settings), valid.now, valid.parentId ?? null],
        );
        return toTeam(result.rows[0]!);
      } catch (error) {
        return translateWriteError(error, { id: input.id, slug: valid.slug, externalId: valid.externalId, organizationId: input.organizationId });
      }
    },

    findById: byId,

    async findBySlug(organizationId, slug) {
      const result = await db.query<TeamRow>(`select ${TEAM_COLUMNS} from uniora.teams where organization_id = $1 and slug = $2`, [organizationId, slug]);
      return result.rows[0] ? toTeam(result.rows[0]) : null;
    },

    async findByExternalId(organizationId, externalId) {
      const result = await db.query<TeamRow>(`select ${TEAM_COLUMNS} from uniora.teams where organization_id = $1 and external_id = $2`, [organizationId, externalId]);
      return result.rows[0] ? toTeam(result.rows[0]) : null;
    },

    async search(options: SearchTeamsOptions) {
      const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
      const query = options.query?.trim();
      const result = await db.query<TeamRow>(
        `select ${TEAM_COLUMNS} from uniora.teams
         where organization_id = $1
           and ($2::text is null or status = $2)
           and ($3::text is null or name ilike $3 or slug ilike $3)
           and ($4::text is null or external_id = $4)
           and ($5::text is null or id > $5)
           and ($7::boolean = false or parent_id is not distinct from $8::text)
         order by id limit $6`,
        [
          options.organizationId,
          options.status ?? null,
          query ? toLikePattern(query) : null,
          options.externalId ?? null,
          options.after ?? null,
          limit,
          options.parentId !== undefined,
          options.parentId ?? null,
        ],
      );
      return result.rows.map(toTeam);
    },

    async count(options) {
      const query = options.query?.trim();
      const result = await db.query<{ n: string }>(
        `select count(*) as n from uniora.teams
         where organization_id = $1
           and ($2::text is null or status = $2)
           and ($3::text is null or name ilike $3 or slug ilike $3)
           and ($4::text is null or external_id = $4)
           and ($5::boolean = false or parent_id is not distinct from $6::text)`,
        [options.organizationId, options.status ?? null, query ? toLikePattern(query) : null, options.externalId ?? null, options.parentId !== undefined, options.parentId ?? null],
      );
      return Number(result.rows[0]!.n);
    },

    async update(organizationId: string, id: string, input: UpdateTeamInput) {
      assertTeamAuthorization(input.authorization, { organizationId, operation: "team.update" });
      const change = assertValidUpdateTeam(input);
      return mutate(organizationId, id, input.expectedVersion, async (current) => {
        if (current.status === "archived") throw new TeamError("An archived team cannot be changed; restore it first.", "team_archived");
        const name = change.name ?? current.name;
        const slug = change.slug ?? current.slug;
        const externalId = change.externalId === undefined ? (current.externalId ?? null) : change.externalId;
        const parentId = change.parentId === undefined ? (current.parentId ?? null) : change.parentId;
        const metadata = change.metadata ?? current.metadata;
        const settings = change.settings ?? current.settings;
        if (
          name === current.name &&
          slug === current.slug &&
          externalId === (current.externalId ?? null) &&
          parentId === (current.parentId ?? null) &&
          sameTeamData(metadata, current.metadata) &&
          sameTeamData(settings, current.settings)
        ) {
          return current;
        }
        try {
          if (parentId !== null && parentId !== (current.parentId ?? null)) {
            await lockTree(organizationId);
            assertTeamPlacement(await placementFacts(organizationId, id, parentId));
          }
          const result = await db.query<TeamRow>(
            `update uniora.teams
             set name = $4, slug = $5, external_id = $6, metadata = $7::jsonb, settings = $8::jsonb, parent_id = $9,
                 updated_at = date_trunc('milliseconds', now()), version = version + 1
             where id = $1 and organization_id = $2 and version = $3 and status = 'active' returning ${TEAM_COLUMNS}`,
            [id, organizationId, current.version, name, slug, externalId, JSON.stringify(metadata), JSON.stringify(settings), parentId],
          );
          return result.rows[0] ? toTeam(result.rows[0]) : null;
        } catch (error) {
          return translateWriteError(error, { id, slug, externalId, organizationId });
        }
      });
    },

    async archive(organizationId: string, id: string, input: ArchiveTeamInput) {
      assertTeamAuthorization(input.authorization, { organizationId, operation: "team.archive", actor: input.actor });
      const reason = sanitizeTeamReason(input.reason);
      return mutate(organizationId, id, input.expectedVersion, async (current) => {
        if (current.status === "archived") return current;
        await lockTree(organizationId);
        const active = await db.query(`select 1 from uniora.teams where parent_id = $1 and organization_id = $2 and status = 'active' limit 1`, [id, organizationId]);
        if (active.rows.length > 0) throw new TeamError("This team still has active sub-teams; archive or move them first.", "team_has_children");
        const result = await db.query<TeamRow>(
          `update uniora.teams
           set status = 'archived', archived_at = date_trunc('milliseconds', now()), archived_by_provider = $4, archived_by_subject = $5,
               archive_reason = $6, updated_at = date_trunc('milliseconds', now()), version = version + 1
           where id = $1 and organization_id = $2 and version = $3 and status = 'active' returning ${TEAM_COLUMNS}`,
          [id, organizationId, current.version, input.actor.provider, input.actor.subject, reason ?? null],
        );
        return result.rows[0] ? toTeam(result.rows[0]) : null;
      });
    },

    async restore(organizationId: string, id: string, input: RestoreTeamInput) {
      assertTeamAuthorization(input.authorization, { organizationId, operation: "team.restore", actor: input.actor });
      return mutate(organizationId, id, input.expectedVersion, async (current) => {
        if (current.status === "active") return current;
        if (current.parentId !== undefined) {
          await lockTree(organizationId);
          const parent = await byId(organizationId, current.parentId);
          if (parent?.status !== "active") throw new TeamError("The parent team is archived; restore it first.", "team_parent_invalid");
        }
        const result = await db.query<TeamRow>(
          `update uniora.teams
           set status = 'active', archived_at = null, archived_by_provider = null, archived_by_subject = null, archive_reason = null,
               updated_at = date_trunc('milliseconds', now()), version = version + 1
           where id = $1 and organization_id = $2 and version = $3 and status = 'archived' returning ${TEAM_COLUMNS}`,
          [id, organizationId, current.version],
        );
        return result.rows[0] ? toTeam(result.rows[0]) : null;
      });
    },

    async delete(organizationId: string, id: string, input: { authorization: TeamAuthorization }) {
      assertTeamAuthorization(input?.authorization, { organizationId, operation: "team.delete" });
      // ONE guarded statement: "only an archived team is deleted" is atomic with the delete itself.
      let result;
      try {
        result = await db.query(`delete from uniora.teams where id = $1 and organization_id = $2 and status = 'archived'`, [id, organizationId]);
      } catch (error) {
        if (isForeignKeyViolation(error) && violatedConstraint(error) === "teams_parent_fk") {
          throw new TeamError("This team still has sub-teams; move or delete them first.", "team_has_children");
        }
        throw error;
      }
      if ((result.rowCount ?? 0) > 0) return;
      const team = await requireTeam(organizationId, id);
      if (team.status !== "archived") throw new TeamError("Only an archived team can be deleted; archive it first.", "team_not_archived");
    },
  };
}
