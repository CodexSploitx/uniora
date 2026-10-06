import type { CreateSupportGrantInput, Identity, SearchSupportGrantsOptions, SupportGrant, SupportGrantRepository } from "@uniora/core";
import { SupportGrantError, assertValidSupportGrant } from "@uniora/core";
import type { SqliteExecutor } from "../executor.js";
import { jsonList, parseList } from "../json.js";
import { isForeignKeyViolation, isUniqueViolation } from "../sqlite-errors.js";

interface GrantRow {
  id: string;
  organization_id: string;
  operator_provider: string;
  operator_subject: string;
  granted_by_provider: string;
  granted_by_subject: string;
  reason: string;
  permissions: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
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
    permissions: parseList(row.permissions).sort(),
    createdAt: new Date(row.created_at),
    expiresAt: new Date(row.expires_at),
    revokedAt: row.revoked_at === null ? undefined : new Date(row.revoked_at),
    revokedBy:
      row.revoked_by_provider !== null && row.revoked_by_subject !== null
        ? { provider: row.revoked_by_provider, subject: row.revoked_by_subject }
        : undefined,
  };
}

export function createSupportGrantRepository(db: SqliteExecutor): SupportGrantRepository {
  function filterOf(options: Omit<SearchSupportGrantsOptions, "limit" | "after">, now: Date): { sql: string; params: unknown[] } {
    return {
      sql: `(?1 is null or organization_id = ?1)
        and (?2 is null or (operator_provider = ?2 and operator_subject = ?3))
        and (?4 is null
             or (?4 = 'revoked' and revoked_at is not null)
             or (?4 = 'active' and revoked_at is null and expires_at > ?5)
             or (?4 = 'expired' and revoked_at is null and expires_at <= ?5))`,
      params: [options.organizationId ?? null, options.operator?.provider ?? null, options.operator?.subject ?? null, options.status ?? null, now],
    };
  }

  const byId = async (id: string): Promise<SupportGrant | null> => {
    const result = await db.query<GrantRow>(`select ${COLUMNS} from uniora_support_grants where id = ?1`, [id]);
    const row = result.rows[0];
    return row ? toGrant(row) : null;
  };

  return {
    async create(input: CreateSupportGrantInput) {
      const { reason, permissions, now } = assertValidSupportGrant(input);
      const known = await db.query<{ n: number }>(
        `select count(*) as n from uniora_permissions where key in (select value from json_each(?1))`,
        [jsonList(permissions)],
      );
      if (Number(known.rows[0]!.n) !== permissions.length) {
        throw new SupportGrantError("Every permission of a grant must be registered.", "support_grant_permission_invalid");
      }
      try {
        await db.query(
          `insert into uniora_support_grants
             (id, organization_id, operator_provider, operator_subject, granted_by_provider, granted_by_subject, reason, permissions, created_at, expires_at)
           values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
          [input.id, input.organizationId, input.operator.provider, input.operator.subject, input.grantedBy.provider, input.grantedBy.subject, reason, jsonList(permissions), now, input.expiresAt],
        );
      } catch (error) {
        if (isUniqueViolation(error)) throw new SupportGrantError(`A grant with id "${input.id}" already exists.`, "support_grant_exists");
        if (isForeignKeyViolation(error)) {
          throw new SupportGrantError(`Organization "${input.organizationId}" does not exist.`, "support_grant_organization_unknown");
        }
        throw error;
      }
      const created = await byId(input.id);
      if (!created) throw new Error("uniora_support_grants insert did not persist");
      return created;
    },

    async revoke(id: string, input: { by: Identity; now?: Date }) {
      return db.atomic(async () => {
        await db.query(
          `update uniora_support_grants set revoked_at = ?2, revoked_by_provider = ?3, revoked_by_subject = ?4
           where id = ?1 and revoked_at is null`,
          [id, input.now ?? new Date(), input.by.provider, input.by.subject],
        );
        return byId(id);
      });
    },

    findById: byId,

    async search(options: SearchSupportGrantsOptions = {}) {
      const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
      const { sql, params } = filterOf(options, options.now ?? new Date());
      const result = await db.query<GrantRow>(
        `select ${COLUMNS} from uniora_support_grants where ${sql} and (?6 is null or id > ?6) order by id limit ?7`,
        [...params, options.after ?? null, limit],
      );
      return result.rows.map(toGrant);
    },

    async count(options = {}) {
      const { sql, params } = filterOf(options, options.now ?? new Date());
      const result = await db.query<{ n: number }>(`select count(*) as n from uniora_support_grants where ${sql}`, params);
      return Number(result.rows[0]!.n);
    },

    async activePermissions(organizationId: string, identities: Identity[], now = new Date()) {
      const keys = new Set<string>();
      for (const identity of identities) {
        const result = await db.query<{ permissions: string }>(
          `select permissions from uniora_support_grants
           where organization_id = ?1 and operator_provider = ?2 and operator_subject = ?3 and revoked_at is null and expires_at > ?4`,
          [organizationId, identity.provider, identity.subject, now],
        );
        for (const row of result.rows) for (const key of parseList(row.permissions)) keys.add(key);
      }
      return [...keys].sort();
    },
  };
}
