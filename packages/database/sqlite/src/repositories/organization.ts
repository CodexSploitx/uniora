import type {
  CreateOrganizationInput,
  Organization,
  OrganizationRepository,
  OrganizationStatus,
  SearchOrganizationsOptions,
  SetOrganizationStatusInput,
  UpdateOrganizationInput,
} from "@uniora/core";
import {
  OrganizationError,
  assertAuditInput,
  assertOrganizationStatus,
  assertValidSlug,
  resolveOrganizationSlug,
  sanitizeOrganizationName,
  sanitizeStatusReason,
} from "@uniora/core";
import type { SqliteExecutor } from "../executor.js";
import { jsonList } from "../json.js";
import { toLikePattern } from "../like.js";
import { isUniqueViolation, violatedExactly } from "../sqlite-errors.js";

interface OrganizationRow {
  id: string;
  name: string;
  slug: string;
  created_at: string;
  status: OrganizationStatus;
  status_changed_at: string | null;
  status_changed_by_provider: string | null;
  status_changed_by_subject: string | null;
  status_reason: string | null;
}

const COLUMNS =
  "id, name, slug, created_at, status, status_changed_at, status_changed_by_provider, status_changed_by_subject, status_reason";

function toOrganization(row: OrganizationRow): Organization {
  const changed =
    row.status_changed_at !== null && row.status_changed_by_provider !== null && row.status_changed_by_subject !== null;
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    createdAt: new Date(row.created_at),
    status: row.status,
    ...(changed
      ? {
          statusChange: {
            at: new Date(row.status_changed_at!),
            by: { provider: row.status_changed_by_provider!, subject: row.status_changed_by_subject! },
            ...(row.status_reason !== null ? { reason: row.status_reason } : {}),
          },
        }
      : {}),
  };
}

/** `null` when no status filter was given; otherwise the validated list as JSON for `json_each`. */
function statusFilter(status: OrganizationStatus | OrganizationStatus[] | undefined): string | null {
  return status === undefined ? null : jsonList((Array.isArray(status) ? status : [status]).map(assertOrganizationStatus));
}

export function createOrganizationRepository(db: SqliteExecutor): OrganizationRepository {
  return {
    async create(input: CreateOrganizationInput) {
      const name = sanitizeOrganizationName(input.name);
      const slug = resolveOrganizationSlug(name, input.slug);

      try {
        const result = await db.query<OrganizationRow>(
          `insert into uniora_organizations (id, name, slug) values (?1, ?2, ?3) returning ${COLUMNS}`,
          [input.id, name, slug],
        );
        return toOrganization(result.rows[0]!);
      } catch (error) {
        if (isUniqueViolation(error)) {
          if (violatedExactly(error, ["uniora_organizations.id"])) {
            throw new OrganizationError(`An organization with id "${input.id}" already exists.`);
          }
          throw new OrganizationError(
            input.slug !== undefined
              ? `An organization with slug "${slug}" already exists.`
              : `Could not derive a unique slug from this organization name — "${slug}" is already taken. Pass an explicit \`slug\`.`,
          );
        }
        throw error;
      }
    },

    async findById(id: string) {
      const result = await db.query<OrganizationRow>(
        `select ${COLUMNS} from uniora_organizations where id = ?1`,
        [id],
      );
      return result.rows[0] ? toOrganization(result.rows[0]) : null;
    },

    async rename(id: string, name: string) {
      const sanitized = sanitizeOrganizationName(name);
      const result = await db.query<OrganizationRow>(
        `update uniora_organizations set name = ?2 where id = ?1 returning ${COLUMNS}`,
        [id, sanitized],
      );
      return result.rows[0] ? toOrganization(result.rows[0]) : null;
    },

    async update(id: string, input: UpdateOrganizationInput) {
      if (input.name === undefined && input.slug === undefined) {
        throw new OrganizationError("Pass a name and/or a slug to update.", "organization_update_empty");
      }
      const name = input.name === undefined ? null : sanitizeOrganizationName(input.name);
      const slug = input.slug === undefined ? null : assertValidSlug(input.slug);
      try {
        const result = await db.query<OrganizationRow>(
          `update uniora_organizations set name = coalesce(?2, name), slug = coalesce(?3, slug)
           where id = ?1 returning ${COLUMNS}`,
          [id, name, slug],
        );
        return result.rows[0] ? toOrganization(result.rows[0]) : null;
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new OrganizationError(`An organization with slug "${slug}" already exists.`, "organization_slug_taken");
        }
        throw error;
      }
    },

    async setStatus(id: string, input: SetOrganizationStatusInput) {
      const status = assertOrganizationStatus(input.status);
      const reason = sanitizeStatusReason(input.reason);
      assertAuditInput({ actor: input.actor, action: "organization.status_changed" });
      // One statement: the row only changes when the status does, so a repeat never rewrites who/when/why.
      const changed = await db.query<OrganizationRow>(
        `update uniora_organizations
         set status = ?2, status_changed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
             status_changed_by_provider = ?3, status_changed_by_subject = ?4, status_reason = ?5
         where id = ?1 and status <> ?2
         returning ${COLUMNS}`,
        [id, status, input.actor.provider, input.actor.subject, reason ?? null],
      );
      if (changed.rows[0]) return toOrganization(changed.rows[0]);
      const current = await db.query<OrganizationRow>(`select ${COLUMNS} from uniora_organizations where id = ?1`, [id]);
      return current.rows[0] ? toOrganization(current.rows[0]) : null;
    },

    async findByIds(ids: string[]) {
      if (ids.length === 0) return [];
      const result = await db.query<OrganizationRow>(
        `select ${COLUMNS} from uniora_organizations where id in (select value from json_each(?1))`,
        [jsonList(ids)],
      );
      return result.rows.map(toOrganization);
    },

    async list() {
      const result = await db.query<OrganizationRow>(
        `select ${COLUMNS} from uniora_organizations order by created_at asc, id asc`,
      );
      return result.rows.map(toOrganization);
    },

    async search(options?: SearchOrganizationsOptions) {
      const query = options?.query?.trim();
      const pattern = query ? toLikePattern(query) : null;
      const after = options?.after;
      const result = await db.query<OrganizationRow>(
        `select ${COLUMNS}
         from uniora_organizations
         where (?1 is null or uniora_ilike(name, ?1) or uniora_ilike(slug, ?1))
           and (?2 is null or (created_at, id) > (?2, ?3))
           and (?5 is null or status in (select value from json_each(?5)))
         order by created_at asc, id asc
         limit coalesce(?4, -1)`,
        [pattern, after?.createdAt ?? null, after?.id ?? null, options?.limit ?? null, statusFilter(options?.status)],
      );
      return result.rows.map(toOrganization);
    },

    async count(options?: { query?: string; status?: OrganizationStatus | OrganizationStatus[] }) {
      const query = options?.query?.trim();
      const pattern = query ? toLikePattern(query) : null;
      const result = await db.query<{ count: number }>(
        `select count(*) as count
         from uniora_organizations
         where (?1 is null or uniora_ilike(name, ?1) or uniora_ilike(slug, ?1))
           and (?2 is null or status in (select value from json_each(?2)))`,
        [pattern, statusFilter(options?.status)],
      );
      return Number(result.rows[0]!.count);
    },
  };
}
