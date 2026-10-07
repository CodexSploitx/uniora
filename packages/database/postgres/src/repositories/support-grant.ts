import type { CreateSupportGrantInput, Identity, SearchSupportGrantsOptions, SupportGrant, SupportGrantRepository } from "@uniora/core";
import { SupportGrantError, assertValidSupportGrant } from "@uniora/core";
import type { Queryable } from "../queryable.js";
import { isForeignKeyViolation, isUniqueViolation } from "../pg-errors.js";

interface GrantRow {
  id: string;
  organization_id: string;
  operator_provider: string;
  operator_subject: string;
  granted_by_provider: string;
  granted_by_subject: string;
  reason: string;
  permissions: string[];
  created_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  revoked_by_provider: string | null;
  revoked_by_subject: string | null;
}

const COLUMNS =
  "id, organization_id, operator_provider, operator_subject, granted_by_provider, granted_by_subject, reason, permissions, created_at, expires_at, revoked_at, revoked_by_provider, revoked_by_subject";

function toGrant(row: GrantRow): SupportGrant {
  return {
    id: row.id,
    organizationId: row.organization_id,
    operator: { provider: row.operator_provider, subject: row.operator_subject },
    grantedBy: { provider: row.granted_by_provider, subject: row.granted_by_subject },
    reason: row.reason,
    permissions: [...row.permissions].sort(),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at ?? undefined,
    revokedBy:
      row.revoked_by_provider !== null && row.revoked_by_subject !== null
        ? { provider: row.revoked_by_provider, subject: row.revoked_by_subject }
        : undefined,
  };
}

export function createSupportGrantRepository(db: Queryable): SupportGrantRepository {
  /** `where` for a search or a count; params start at `$1`. */
  function filterOf(options: Omit<SearchSupportGrantsOptions, "limit" | "after">, now: Date): { sql: string; params: unknown[] } {
    const params: unknown[] = [options.organizationId ?? null, options.operator?.provider ?? null, options.operator?.subject ?? null, options.status ?? null, now];
    return {
      sql: `($1::text is null or organization_id = $1)
        and ($2::text is null or (operator_provider = $2 and operator_subject = $3))
        and ($4::text is null
             or ($4 = 'revoked' and revoked_at is not null)
             or ($4 = 'active' and revoked_at is null and expires_at > $5)
             or ($4 = 'expired' and revoked_at is null and expires_at <= $5))`,
      params,
    };
  }

  const byId = async (id: string): Promise<SupportGrant | null> => {
    const result = await db.query<GrantRow>(`select ${COLUMNS} from uniora.support_grants where id = $1`, [id]);
    const row = result.rows[0];
    return row ? toGrant(row) : null;
  };

  return {
    async create(input: CreateSupportGrantInput) {
      const { reason, permissions, now } = assertValidSupportGrant(input);
      const known = await db.query<{ n: string }>(`select count(*) as n from uniora.permissions where key = any($1::text[])`, [permissions]);
      if (Number(known.rows[0]!.n) !== permissions.length) {
        throw new SupportGrantError("Every permission of a grant must be registered.", "support_grant_permission_invalid");
      }
      try {
        const result = await db.query<GrantRow>(
          `insert into uniora.support_grants
             (id, organization_id, operator_provider, operator_subject, granted_by_provider, granted_by_subject, reason, permissions, created_at, expires_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8::text[], $9, $10) returning ${COLUMNS}`,
          [input.id, input.organizationId, input.operator.provider, input.operator.subject, input.grantedBy.provider, input.grantedBy.subject, reason, permissions, now, input.expiresAt],
        );
        return toGrant(result.rows[0]!);
      } catch (error) {
        if (isUniqueViolation(error)) throw new SupportGrantError(`A grant with id "${input.id}" already exists.`, "support_grant_exists");
        if (isForeignKeyViolation(error)) {
          throw new SupportGrantError(`Organization "${input.organizationId}" does not exist.`, "support_grant_organization_unknown");
        }
        throw error;
      }
    },

    async revoke(id: string, input: { by: Identity; now?: Date }) {
      await db.query(
        `update uniora.support_grants set revoked_at = $2, revoked_by_provider = $3, revoked_by_subject = $4
         where id = $1 and revoked_at is null`,
        [id, input.now ?? new Date(), input.by.provider, input.by.subject],
      );
      return byId(id);
    },

    findById: byId,

    async search(options: SearchSupportGrantsOptions = {}) {
      const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
      const { sql, params } = filterOf(options, options.now ?? new Date());
      const result = await db.query<GrantRow>(
        `select ${COLUMNS} from uniora.support_grants where ${sql} and ($6::text is null or id > $6) order by id limit $7`,
        [...params, options.after ?? null, limit],
      );
      return result.rows.map(toGrant);
    },

    async count(options = {}) {
      const { sql, params } = filterOf(options, options.now ?? new Date());
      const result = await db.query<{ n: string }>(`select count(*) as n from uniora.support_grants where ${sql}`, params);
      return Number(result.rows[0]!.n);
    },

    async activePermissions(organizationId: string, identities: Identity[], now = new Date()) {
      if (identities.length === 0) return [];
      const result = await db.query<{ key: string }>(
        `select distinct unnest(g.permissions) as key
         from uniora.support_grants g
         join unnest($2::text[], $3::text[]) as i (provider, subject)
           on i.provider = g.operator_provider and i.subject = g.operator_subject
         where g.organization_id = $1 and g.revoked_at is null and g.expires_at > $4
         order by key`,
        [organizationId, identities.map((identity) => identity.provider), identities.map((identity) => identity.subject), now],
      );
      return result.rows.map((row) => row.key);
    },
  };
}
