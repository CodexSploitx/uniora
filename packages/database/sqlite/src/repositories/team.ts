import type {
  ArchiveTeamInput,
  CreateTeamInput,
  RestoreTeamInput,
  SearchTeamsOptions,
  Team,
  TeamAuthorization,
  TeamRepository,
  TeamStatus,
  UpdateTeamInput,
} from "@uniora/core";
import { TeamError, assertExpectedVersion, assertTeamAuthorization, assertValidCreateTeam, assertValidUpdateTeam, sameTeamData, sanitizeTeamReason } from "@uniora/core";
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
  "id, organization_id, slug, name, status, external_id, metadata, settings, created_at, updated_at, archived_at, archived_by_provider, archived_by_subject, archive_reason, version";

function toTeam(row: TeamRow): Team {
  return {
    id: row.id,
    organizationId: row.organization_id,
    slug: row.slug,
    name: row.name,
    status: row.status,
    ...(row.external_id !== null ? { externalId: row.external_id } : {}),
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
    async create(input: CreateTeamInput) {
      assertTeamAuthorization(input.authorization, { organizationId: input.organizationId, operation: "team.create" });
      const valid = assertValidCreateTeam(input);
      try {
        await db.query(
          `insert into uniora_teams (id, organization_id, slug, name, external_id, metadata, settings, created_at, updated_at)
           values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)`,
          [input.id, input.organizationId, valid.slug, valid.name, valid.externalId ?? null, JSON.stringify(valid.metadata), JSON.stringify(valid.settings), valid.now],
        );
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
         order by id limit ?6`,
        [options.organizationId, options.status ?? null, query ? toLikePattern(query) : null, options.externalId ?? null, options.after ?? null, limit],
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
           and (?4 is null or external_id = ?4)`,
        [options.organizationId, options.status ?? null, query ? toLikePattern(query) : null, options.externalId ?? null],
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
        const metadata = change.metadata ?? current.metadata;
        const settings = change.settings ?? current.settings;
        if (
          name === current.name &&
          slug === current.slug &&
          externalId === (current.externalId ?? null) &&
          sameTeamData(metadata, current.metadata) &&
          sameTeamData(settings, current.settings)
        ) {
          return current;
        }
        try {
          await db.query(
            `update uniora_teams set name = ?3, slug = ?4, external_id = ?5, metadata = ?6, settings = ?7, updated_at = ?8, version = version + 1
             where id = ?1 and organization_id = ?2`,
            [id, organizationId, name, slug, externalId, JSON.stringify(metadata), JSON.stringify(settings), new Date()],
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
        await db.query(`delete from uniora_teams where id = ?1 and organization_id = ?2`, [id, organizationId]);
      });
    },
  };
}
