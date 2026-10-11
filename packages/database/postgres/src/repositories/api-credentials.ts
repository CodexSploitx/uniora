import type { Pool } from "pg";
import type {
  ApiClient,
  ApiClientRepository,
  ApiClientStatus,
  ApiKey,
  ApiKeyRecord,
  ApiKeyRepository,
  ApiScope,
  CreateApiClientInput,
  CreateApiKeyInput,
  SearchApiClientsOptions,
  UpdateApiClientInput,
} from "@uniora/core";
import {
  ApiCredentialError,
  MAX_ACTIVE_API_KEYS_PER_CLIENT,
  assertApiClientStatus,
  assertApiId,
  assertApiIdentity,
  assertApiVersion,
  assertValidCreateApiClient,
  assertValidCreateApiKey,
  assertValidUpdateApiClient,
  clampApiPage,
  normalizeApiClientName,
} from "@uniora/core";
import type { Queryable } from "../queryable.js";
import { isUniqueViolation } from "../pg-errors.js";

const S = "uniora_api";

/**
 * Runs `work` on a single connection inside a transaction. Inside `storage.transaction()` the repositories are already bound
 * to the caller's client and join it; at the top level (a pool) each write opens its own short transaction, so the row lock
 * it takes is held for the whole check-then-write and not released after one statement.
 */
function transactional(db: Queryable, pool: Pool | undefined) {
  return async function run<T>(work: (q: Queryable) => Promise<T>): Promise<T> {
    if (!pool) return work(db);
    const client = await pool.connect();
    try {
      await client.query("begin");
      const result = await work(client);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  };
}

interface ClientRow {
  id: string;
  name: string;
  scopes: string[];
  all_organizations: boolean;
  organization_ids: string[];
  status: ApiClientStatus;
  created_at: Date;
  created_by_provider: string;
  created_by_subject: string;
  updated_at: Date;
  version: number;
}
const CLIENT_COLUMNS =
  "id, name, scopes, all_organizations, organization_ids, status, created_at, created_by_provider, created_by_subject, updated_at, version";
const toClient = (row: ClientRow): ApiClient => ({
  id: row.id,
  name: row.name,
  scopes: [...row.scopes].sort() as ApiScope[],
  organizations: row.all_organizations ? "*" : [...row.organization_ids].sort(),
  status: row.status,
  createdAt: row.created_at,
  createdBy: { provider: row.created_by_provider, subject: row.created_by_subject },
  updatedAt: row.updated_at,
  version: row.version,
});

const assertVersion = (current: { version: number }, expected: number | undefined): void => {
  if (expected !== undefined && expected !== current.version) {
    throw new ApiCredentialError("The API client changed since it was read.", "api_version_conflict");
  }
};

export function createApiClientRepository(db: Queryable, pool?: Pool): ApiClientRepository {
  const run = transactional(db, pool);
  const lockById = async (q: Queryable, id: string): Promise<ClientRow> => {
    const result = await q.query<ClientRow>(`select ${CLIENT_COLUMNS} from ${S}.clients where id = $1 for update`, [id]);
    const row = result.rows[0];
    if (!row) throw new ApiCredentialError(`API client not found: ${id}`, "api_client_not_found");
    return row;
  };

  return {
    async create(input: CreateApiClientInput) {
      const valid = assertValidCreateApiClient(input);
      try {
        const result = await db.query<ClientRow>(
          `insert into ${S}.clients (id, name, name_normalized, scopes, all_organizations, organization_ids, created_by_provider, created_by_subject)
           values ($1, $2, $3, $4::text[], $5, $6::text[], $7, $8) returning ${CLIENT_COLUMNS}`,
          [
            input.id,
            valid.name,
            normalizeApiClientName(valid.name),
            valid.scopes,
            valid.organizations === "*",
            valid.organizations === "*" ? [] : valid.organizations,
            input.createdBy.provider,
            input.createdBy.subject,
          ],
        );
        return toClient(result.rows[0]!);
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ApiCredentialError("An API client with that id or name already exists.", "api_client_exists");
        }
        throw error;
      }
    },

    async update(id: string, input: UpdateApiClientInput) {
      const valid = assertValidUpdateApiClient(input);
      assertApiId(id, "client id");
      return run(async (q) => {
        const current = await lockById(q, id);
        assertVersion(current, input.expectedVersion);
        try {
          const result = await q.query<ClientRow>(
            `update ${S}.clients set
               name = coalesce($2, name),
               name_normalized = coalesce($3, name_normalized),
               scopes = coalesce($4::text[], scopes),
               all_organizations = case when $5::boolean then $6::boolean else all_organizations end,
               organization_ids = case when $5::boolean then $7::text[] else organization_ids end,
               updated_at = date_trunc('milliseconds', now()), version = version + 1
             where id = $1 returning ${CLIENT_COLUMNS}`,
            [
              id,
              valid.name ?? null,
              valid.name !== undefined ? normalizeApiClientName(valid.name) : null,
              valid.scopes ?? null,
              valid.organizations !== undefined,
              valid.organizations === "*",
              valid.organizations === undefined || valid.organizations === "*" ? [] : valid.organizations,
            ],
          );
          return toClient(result.rows[0]!);
        } catch (error) {
          if (isUniqueViolation(error)) throw new ApiCredentialError("An API client with that name already exists.", "api_client_exists");
          throw error;
        }
      });
    },

    async setStatus(id: string, status: ApiClientStatus, input: { expectedVersion?: number } = {}) {
      assertApiClientStatus(status);
      assertApiVersion(input.expectedVersion);
      assertApiId(id, "client id");
      return run(async (q) => {
        const current = await lockById(q, id);
        assertVersion(current, input.expectedVersion);
        if (current.status === status) return toClient(current);
        const result = await q.query<ClientRow>(
          `update ${S}.clients set status = $2, updated_at = date_trunc('milliseconds', now()), version = version + 1
           where id = $1 returning ${CLIENT_COLUMNS}`,
          [id, status],
        );
        return toClient(result.rows[0]!);
      });
    },

    async findById(id: string) {
      const result = await db.query<ClientRow>(`select ${CLIENT_COLUMNS} from ${S}.clients where id = $1`, [id]);
      return result.rows[0] ? toClient(result.rows[0]) : null;
    },

    async search(options: SearchApiClientsOptions = {}) {
      const result = await db.query<ClientRow>(
        `select ${CLIENT_COLUMNS} from ${S}.clients
         where ($1::text is null or status = $1) and ($2::text is null or id > $2)
         order by id limit $3`,
        [options.status ?? null, options.after ?? null, clampApiPage(options.limit)],
      );
      return result.rows.map(toClient);
    },

    async count(options: Pick<SearchApiClientsOptions, "status"> = {}) {
      const result = await db.query<{ n: string }>(`select count(*)::text as n from ${S}.clients where ($1::text is null or status = $1)`, [options.status ?? null]);
      return Number(result.rows[0]!.n);
    },
  };
}

interface KeyRow {
  id: string;
  client_id: string;
  secret_hash: string;
  hint: string;
  created_at: Date;
  created_by_provider: string;
  created_by_subject: string;
  expires_at: Date | null;
  revoked_at: Date | null;
  revoked_by_provider: string | null;
  revoked_by_subject: string | null;
  last_used_at: Date | null;
}
const KEY_COLUMNS =
  "id, client_id, secret_hash, hint, created_at, created_by_provider, created_by_subject, expires_at, revoked_at, revoked_by_provider, revoked_by_subject, last_used_at";
const toKey = (row: KeyRow): ApiKey => ({
  id: row.id,
  clientId: row.client_id,
  hint: row.hint,
  createdAt: row.created_at,
  createdBy: { provider: row.created_by_provider, subject: row.created_by_subject },
  ...(row.expires_at ? { expiresAt: row.expires_at } : {}),
  ...(row.revoked_at && row.revoked_by_provider !== null && row.revoked_by_subject !== null
    ? { revokedAt: row.revoked_at, revokedBy: { provider: row.revoked_by_provider, subject: row.revoked_by_subject } }
    : {}),
  ...(row.last_used_at ? { lastUsedAt: row.last_used_at } : {}),
});
const toRecord = (row: KeyRow): ApiKeyRecord => ({ ...toKey(row), secretHash: row.secret_hash });

export function createApiKeyRepository(db: Queryable, pool?: Pool): ApiKeyRepository {
  const run = transactional(db, pool);

  return {
    async create(input: CreateApiKeyInput) {
      assertValidCreateApiKey(input);
      return run(async (q) => {
        // The lock on the client row serialises key creation for this client; every statement after it sees what the
        // previous holder committed, so the count below cannot be stale.
        const locked = await q.query(`select 1 from ${S}.clients where id = $1 for update`, [input.clientId]);
        if (locked.rows.length === 0) throw new ApiCredentialError(`API client not found: ${input.clientId}`, "api_client_not_found");
        const active = await q.query<{ n: string }>(
          `select count(*)::text as n from ${S}.keys
           where client_id = $1 and revoked_at is null and (expires_at is null or expires_at > $2)`,
          [input.clientId, input.now],
        );
        if (Number(active.rows[0]!.n) >= MAX_ACTIVE_API_KEYS_PER_CLIENT) {
          throw new ApiCredentialError(`A client can have at most ${MAX_ACTIVE_API_KEYS_PER_CLIENT} active keys: revoke one first.`, "api_key_limit");
        }
        try {
          const result = await q.query<KeyRow>(
            `insert into ${S}.keys (id, client_id, secret_hash, hint, created_at, created_by_provider, created_by_subject, expires_at)
             values ($1, $2, $3, $4, $5, $6, $7, $8) returning ${KEY_COLUMNS}`,
            [input.id, input.clientId, input.secretHash, input.hint, input.now, input.createdBy.provider, input.createdBy.subject, input.expiresAt ?? null],
          );
          return toKey(result.rows[0]!);
        } catch (error) {
          if (isUniqueViolation(error)) throw new ApiCredentialError(`An API key with id "${input.id}" already exists.`, "api_key_invalid");
          throw error;
        }
      });
    },

    async revoke(id: string, input: { by: { provider: string; subject: string }; at: Date }) {
      assertApiIdentity(input.by, "revoker");
      const updated = await db.query<KeyRow>(
        `update ${S}.keys set revoked_at = $2, revoked_by_provider = $3, revoked_by_subject = $4
         where id = $1 and revoked_at is null returning ${KEY_COLUMNS}`,
        [id, input.at, input.by.provider, input.by.subject],
      );
      if (updated.rows[0]) return toKey(updated.rows[0]);
      const existing = await db.query<KeyRow>(`select ${KEY_COLUMNS} from ${S}.keys where id = $1`, [id]);
      if (!existing.rows[0]) throw new ApiCredentialError(`API key not found: ${id}`, "api_key_not_found");
      return toKey(existing.rows[0]);
    },

    async findRecordById(id: string) {
      const result = await db.query<KeyRow>(`select ${KEY_COLUMNS} from ${S}.keys where id = $1`, [id]);
      return result.rows[0] ? toRecord(result.rows[0]) : null;
    },

    async findById(id: string) {
      const result = await db.query<KeyRow>(`select ${KEY_COLUMNS} from ${S}.keys where id = $1`, [id]);
      return result.rows[0] ? toKey(result.rows[0]) : null;
    },

    async listByClient(clientId: string) {
      assertApiId(clientId, "client id");
      const result = await db.query<KeyRow>(`select ${KEY_COLUMNS} from ${S}.keys where client_id = $1 order by created_at desc, id`, [clientId]);
      return result.rows.map(toKey);
    },

    async listByClients(clientIds: string[]) {
      const out = new Map<string, ApiKey[]>(clientIds.map((id) => [id, []]));
      if (clientIds.length === 0) return out;
      const result = await db.query<KeyRow>(
        `select ${KEY_COLUMNS} from ${S}.keys where client_id = any($1::text[]) order by created_at desc, id`,
        [clientIds],
      );
      for (const row of result.rows) out.get(row.client_id)?.push(toKey(row));
      return out;
    },

    async touch(id: string, at: Date, minIntervalMs: number) {
      await db.query(
        `update ${S}.keys set last_used_at = $2
         where id = $1 and (last_used_at is null or last_used_at <= $2::timestamptz - ($3::double precision * interval '1 millisecond'))`,
        [id, at, minIntervalMs],
      );
    },
  };
}
