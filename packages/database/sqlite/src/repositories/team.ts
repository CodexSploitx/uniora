import type {
  ArchiveTeamInput,
  CreateTeamInput,
  RestoreTeamInput,
  SearchTeamsOptions,
  TeamPlacementFacts,
  Team,
  TeamAuthorization,
  TeamRepository,
  TeamStatus,
  UpdateTeamInput,
} from "@uniora/core";
import { TeamError, assertExpectedVersion, assertTeamPlacement, assertTeamAuthorization, assertValidCreateTeam, assertValidUpdateTeam, sameTeamData, sanitizeTeamReason } from "@uniora/core";
import type { SqliteExecutor } from "../executor.js";
import { isForeignKeyViolation, isUniqueViolation, violatedExactly } from "../sqlite-errors.js";
import { toLikePattern } from "../like.js";

interface TeamRow {
  id: string;
  organization_id: string;
  slug: string;
  name: string;
  status: TeamStatus;
  external_id: string | null;
  parent_id: string | null;
  metadata: string;
  settings: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
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
    metadata: JSON.parse(row.metadata) as Team["metadata"],
    settings: JSON.parse(row.settings) as Team["settings"],
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    ...(row.archived_at !== null && row.archived_by_provider !== null && row.archived_by_subject !== null
      ? {
          archived: {
            at: new Date(row.archived_at),
            by: { provider: row.archived_by_provider, subject: row.archived_by_subject },
            ...(row.archive_reason !== null ? { reason: row.archive_reason } : {}),
          },
        }
      : {}),
    version: row.version,
  };
}

function translateWriteError(error: unknown, context: { id?: string; slug?: string; externalId?: string | null; organizationId?: string }): never {
  if (isUniqueViolation(error)) {
    if (violatedExactly(error, ["uniora_teams.id"]) || violatedExactly(error, ["uniora_teams.id", "uniora_teams.organization_id"])) throw new TeamError(`A team with id "${context.id}" already exists.`, "team_exists");
    if (violatedExactly(error, ["uniora_teams.organization_id", "uniora_teams.slug"])) {
      throw new TeamError(`A team with slug "${context.slug}" already exists in this organization.`, "team_slug_taken");
    }
    if (violatedExactly(error, ["uniora_teams.organization_id", "uniora_teams.external_id"])) {
      throw new TeamError(`A team with external id "${context.externalId}" already exists in this organization.`, "team_external_id_taken");
    }
  }
  if (error instanceof Error && /team parent must belong to the same organization/.test(error.message)) {
    throw new TeamError("The parent team does not exist in this organization.", "team_parent_invalid");
  }
  if (isForeignKeyViolation(error)) {
    throw new TeamError(`Organization "${context.organizationId}" does not exist.`, "team_organization_unknown");
  }
  throw error;
}

export function createTeamRepository(db: SqliteExecutor): TeamRepository {
  const byId = async (organizationId: string, id: string): Promise<Team | null> => {
    const result = await db.query<TeamRow>(`select ${TEAM_COLUMNS} from uniora_teams where id = ?1 and organization_id = ?2`, [id, organizationId]);
    return result.rows[0] ? toTeam(result.rows[0]) : null;
  };

  const TREE_DEPTH_GUARD = 64;

  /** What the placement rules need to know, read with recursive queries over the organization's own rows. */
  async function placementFacts(organizationId: string, selfId: string | null, parentId: string): Promise<TeamPlacementFacts> {
    const parent = await db.query<{ status: TeamStatus }>(`select status from uniora_teams where id = ?1 and organization_id = ?2`, [parentId, organizationId]);
    if (!parent.rows[0]) return { selfId, parentId, parent: null, loop: false, subtreeHeight: 0 };
    const up = await db.query<{ id: string }>(
      `with recursive up(id, parent_id, depth) as (
         select id, parent_id, 1 from uniora_teams where id = ?1 and organization_id = ?2
         union all
         select t.id, t.parent_id, up.depth + 1 from uniora_teams t join up on t.id = up.parent_id
         where t.organization_id = ?2 and up.depth < ${TREE_DEPTH_GUARD}
       ) select id from up`,
      [parentId, organizationId],
    );
    let subtreeHeight = 0;
    if (selfId !== null) {
      const down = await db.query<{ height: number | null }>(
        `with recursive down(id, depth) as (
           select id, 1 from uniora_teams where parent_id = ?1 and organization_id = ?2
           union all
           select t.id, down.depth + 1 from uniora_teams t join down on t.parent_id = down.id
           where t.organization_id = ?2 and down.depth < ${TREE_DEPTH_GUARD}
         ) select max(depth) as height from down`,
        [selfId, organizationId],
      );
      subtreeHeight = Number(down.rows[0]?.height ?? 0);
    }
    return {
      selfId,
      parentId,
      parent: { status: parent.rows[0].status, depth: up.rows.length },
      loop: selfId !== null && up.rows.some((row) => row.id === selfId),
      subtreeHeight,
    };
  }

  /** Read, check the version, change: all inside one writer turn, so nobody can get in between. */
  function mutate(organizationId: string, id: string, expectedVersion: number | undefined, step: (current: Team) => Promise<Team>): Promise<Team> {
    const expected = assertExpectedVersion(expectedVersion);
    return db.atomic(async () => {
      const current = await byId(organizationId, id);
      if (!current) throw new TeamError(`Team not found: ${id}`, "team_not_found");
      if (expected !== undefined && expected !== current.version) {
        throw new TeamError(`The team changed (version ${current.version}, expected ${expected}).`, "team_version_conflict");
      }
      return step(current);
    });
  }

  return {
    async ancestors(organizationId: string, id: string) {
      if (!(await byId(organizationId, id))) throw new TeamError(`Team not found: ${id}`, "team_not_found");
      const result = await db.query<TeamRow & { depth: number }>(
        `with recursive up(id, depth) as (
           select parent_id, 1 from uniora_teams where id = ?1 and organization_id = ?2 and parent_id is not null
           union all
           select t.parent_id, up.depth + 1 from uniora_teams t join up on t.id = up.id
           where t.organization_id = ?2 and t.parent_id is not null and up.depth < ${TREE_DEPTH_GUARD}
         ) select ${TEAM_COLUMNS.split(", ").map((c) => `t.${c}`).join(", ")}, up.depth as depth
           from up join uniora_teams t on t.id = up.id and t.organization_id = ?2 order by up.depth desc`,
        [id, organizationId],
      );
      return result.rows.map(toTeam);
    },

    async descendants(organizationId: string, id: string) {
      if (!(await byId(organizationId, id))) throw new TeamError(`Team not found: ${id}`, "team_not_found");
      const result = await db.query<TeamRow>(
        `with recursive down(id, depth) as (
           select id, 1 from uniora_teams where parent_id = ?1 and organization_id = ?2
           union all
           select t.id, down.depth + 1 from uniora_teams t join down on t.parent_id = down.id
           where t.organization_id = ?2 and down.depth < ${TREE_DEPTH_GUARD}
         ) select ${TEAM_COLUMNS.split(", ").map((c) => `t.${c}`).join(", ")} from down join uniora_teams t on t.id = down.id order by t.id`,
        [id, organizationId],
      );
      return result.rows.map(toTeam);
    },

    async create(input: CreateTeamInput) {
      assertTeamAuthorization(input.authorization, { organizationId: input.organizationId, operation: "team.create" });
      const valid = assertValidCreateTeam(input);
      try {
        await db.atomic(async () => {
          if (valid.parentId !== undefined) assertTeamPlacement(await placementFacts(input.organizationId, null, valid.parentId));
          await db.query(
            `insert into uniora_teams (id, organization_id, slug, name, external_id, parent_id, metadata, settings, created_at, updated_at)
             values (?1, ?2, ?3, ?4, ?5, ?9, ?6, ?7, ?8, ?8)`,
            [input.id, input.organizationId, valid.slug, valid.name, valid.externalId ?? null, JSON.stringify(valid.metadata), JSON.stringify(valid.settings), valid.now, valid.parentId ?? null],
          );
        });
      } catch (error) {
        return translateWriteError(error, { id: input.id, slug: valid.slug, externalId: valid.externalId, organizationId: input.organizationId });
      }
      return (await byId(input.organizationId, input.id))!;
    },

    findById: byId,

    async findBySlug(organizationId, slug) {
      const result = await db.query<TeamRow>(`select ${TEAM_COLUMNS} from uniora_teams where organization_id = ?1 and slug = ?2`, [organizationId, slug]);
      return result.rows[0] ? toTeam(result.rows[0]) : null;
    },

    async findByExternalId(organizationId, externalId) {
      const result = await db.query<TeamRow>(`select ${TEAM_COLUMNS} from uniora_teams where organization_id = ?1 and external_id = ?2`, [organizationId, externalId]);
      return result.rows[0] ? toTeam(result.rows[0]) : null;
    },

    async search(options: SearchTeamsOptions) {
      const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
      const query = options.query?.trim();
      const result = await db.query<TeamRow>(
        `select ${TEAM_COLUMNS} from uniora_teams
         where organization_id = ?1
           and (?2 is null or status = ?2)
           and (?3 is null or uniora_ilike(name, ?3) or uniora_ilike(slug, ?3))
           and (?4 is null or external_id = ?4)
           and (?5 is null or id > ?5)
           and (?7 = 0 or parent_id is ?8)
         order by id limit ?6`,
        [
          options.organizationId,
          options.status ?? null,
          query ? toLikePattern(query) : null,
          options.externalId ?? null,
          options.after ?? null,
          limit,
          options.parentId !== undefined ? 1 : 0,
          options.parentId ?? null,
        ],
      );
      return result.rows.map(toTeam);
    },

    async count(options) {
      const query = options.query?.trim();
      const result = await db.query<{ n: number }>(
        `select count(*) as n from uniora_teams
         where organization_id = ?1
           and (?2 is null or status = ?2)
           and (?3 is null or uniora_ilike(name, ?3) or uniora_ilike(slug, ?3))
           and (?4 is null or external_id = ?4)
           and (?5 = 0 or parent_id is ?6)`,
        [options.organizationId, options.status ?? null, query ? toLikePattern(query) : null, options.externalId ?? null, options.parentId !== undefined ? 1 : 0, options.parentId ?? null],
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
            assertTeamPlacement(await placementFacts(organizationId, id, parentId));
          }
          await db.query(
            `update uniora_teams set name = ?3, slug = ?4, external_id = ?5, metadata = ?6, settings = ?7, parent_id = ?9, updated_at = ?8, version = version + 1
             where id = ?1 and organization_id = ?2`,
            [id, organizationId, name, slug, externalId, JSON.stringify(metadata), JSON.stringify(settings), new Date(), parentId],
          );
        } catch (error) {
          return translateWriteError(error, { id, slug, externalId, organizationId });
        }
        return (await byId(organizationId, id))!;
      });
    },

    async archive(organizationId: string, id: string, input: ArchiveTeamInput) {
      assertTeamAuthorization(input.authorization, { organizationId, operation: "team.archive", actor: input.actor });
      const reason = sanitizeTeamReason(input.reason);
      return mutate(organizationId, id, input.expectedVersion, async (current) => {
        if (current.status === "archived") return current;
        const active = await db.query(`select 1 from uniora_teams where parent_id = ?1 and organization_id = ?2 and status = 'active' limit 1`, [id, organizationId]);
        if (active.rows.length > 0) throw new TeamError("This team still has active sub-teams; archive or move them first.", "team_has_children");
        const now = new Date();
        await db.query(
          `update uniora_teams
           set status = 'archived', archived_at = ?3, archived_by_provider = ?4, archived_by_subject = ?5, archive_reason = ?6, updated_at = ?3, version = version + 1
           where id = ?1 and organization_id = ?2`,
          [id, organizationId, now, input.actor.provider, input.actor.subject, reason ?? null],
        );
        return (await byId(organizationId, id))!;
      });
    },

    async restore(organizationId: string, id: string, input: RestoreTeamInput) {
      assertTeamAuthorization(input.authorization, { organizationId, operation: "team.restore", actor: input.actor });
      return mutate(organizationId, id, input.expectedVersion, async (current) => {
        if (current.status === "active") return current;
        if (current.parentId !== undefined) {
          const parent = await byId(organizationId, current.parentId);
          if (parent?.status !== "active") throw new TeamError("The parent team is archived; restore it first.", "team_parent_invalid");
        }
        await db.query(
          `update uniora_teams
           set status = 'active', archived_at = null, archived_by_provider = null, archived_by_subject = null, archive_reason = null, updated_at = ?3, version = version + 1
           where id = ?1 and organization_id = ?2`,
          [id, organizationId, new Date()],
        );
        return (await byId(organizationId, id))!;
      });
    },

    async delete(organizationId: string, id: string, input: { authorization: TeamAuthorization }) {
      assertTeamAuthorization(input?.authorization, { organizationId, operation: "team.delete" });
      await db.atomic(async () => {
        const team = await byId(organizationId, id);
        if (!team) throw new TeamError(`Team not found: ${id}`, "team_not_found");
        if (team.status !== "archived") throw new TeamError("Only an archived team can be deleted; archive it first.", "team_not_archived");
        const child = await db.query(`select 1 from uniora_teams where parent_id = ?1 and organization_id = ?2 limit 1`, [id, organizationId]);
        if (child.rows.length > 0) throw new TeamError("This team still has sub-teams; move or delete them first.", "team_has_children");
        await db.query(`delete from uniora_teams where id = ?1 and organization_id = ?2`, [id, organizationId]);
      });
    },
  };
}
