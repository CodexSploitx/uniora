import type { CreateOrganizationInput, Organization, OrganizationRepository, SearchOrganizationsOptions } from "@uniora/core";
import { OrganizationError, resolveOrganizationSlug, sanitizeOrganizationName } from "@uniora/core";
import type { Queryable } from "../queryable.js";
import { isUniqueViolation, violatedConstraint } from "../pg-errors.js";
import { toLikePattern } from "../pg-like.js";

interface OrganizationRow {
  id: string;
  name: string;
  slug: string;
  created_at: Date;
}

function toOrganization(row: OrganizationRow): Organization {
  return { id: row.id, slug: row.slug, name: row.name, createdAt: row.created_at };
}

export function createOrganizationRepository(db: Queryable): OrganizationRepository {
  return {
    async create(input: CreateOrganizationInput) {
      const name = sanitizeOrganizationName(input.name);
      const slug = resolveOrganizationSlug(name, input.slug);

      try {
        const result = await db.query<OrganizationRow>(
          `insert into uniora.organizations (id, name, slug) values ($1, $2, $3) returning id, name, slug, created_at`,
          [input.id, name, slug],
        );
        return toOrganization(result.rows[0]!);
      } catch (error) {
        if (isUniqueViolation(error)) {
          if (violatedConstraint(error) === "organizations_pkey") {
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
        `select id, name, slug, created_at from uniora.organizations where id = $1`,
        [id],
      );
      return result.rows[0] ? toOrganization(result.rows[0]) : null;
    },

    async findByIds(ids: string[]) {
      if (ids.length === 0) return [];
      const result = await db.query<OrganizationRow>(
        `select id, name, slug, created_at from uniora.organizations where id = any($1::text[])`,
        [ids],
      );
      return result.rows.map(toOrganization);
    },

    async list() {
      const result = await db.query<OrganizationRow>(
        `select id, name, slug, created_at from uniora.organizations order by created_at asc`,
      );
      return result.rows.map(toOrganization);
    },

    async search(options?: SearchOrganizationsOptions) {
      const query = options?.query?.trim();
      const pattern = query ? toLikePattern(query) : null;
      const after = options?.after;
      const result = await db.query<OrganizationRow>(
        `select id, name, slug, created_at
         from uniora.organizations
         where ($1::text is null or name ilike $1 or slug ilike $1)
           and ($2::timestamptz is null or (created_at, id) > ($2, $3))
         order by created_at asc, id asc
         limit $4`,
        [pattern, after?.createdAt ?? null, after?.id ?? null, options?.limit ?? null],
      );
      return result.rows.map(toOrganization);
    },

    async count(options?: { query?: string }) {
      const query = options?.query?.trim();
      const pattern = query ? toLikePattern(query) : null;
      const result = await db.query<{ count: string }>(
        `select count(*)::text as count
         from uniora.organizations
         where $1::text is null or name ilike $1 or slug ilike $1`,
        [pattern],
      );
      return Number(result.rows[0]!.count);
    },
  };
}
