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
import type { SqliteExecutor } from "../executor.js";
import { jsonList, parseList } from "../json.js";
import { isUniqueViolation } from "../sqlite-errors.js";

interface ClientRow {
  id: string;
  name: string;
  scopes: string;
  all_organizations: number;
  organization_ids: string;
  status: ApiClientStatus;
  created_at: string;
  created_by_provider: string;
  created_by_subject: string;
  updated_at: string;
  version: number;
}
const CLIENT_COLUMNS =
  "id, name, scopes, all_organizations, organization_ids, status, created_at, created_by_provider, created_by_subject, updated_at, version";
const toClient = (row: ClientRow): ApiClient => ({
  id: row.id,
  name: row.name,
  scopes: parseList(row.scopes).sort() as ApiScope[],
  organizations: row.all_organizations === 1 ? "*" : parseList(row.organization_ids).sort(),
  status: row.status,
  createdAt: new Date(row.created_at),
  createdBy: { provider: row.created_by_provider, subject: row.created_by_subject },
  updatedAt: new Date(row.updated_at),
  version: row.version,
});

const assertVersion = (current: { version: number }, expected: number | undefined): void => {
  if (expected !== undefined && expected !== current.version) {
    throw new ApiCredentialError("The API client changed since it was read.", "api_version_conflict");
  }
};

export function createApiClientRepository(db: SqliteExecutor): ApiClientRepository {
  const byId = async (id: string): Promise<ClientRow | undefined> =>
    (await db.query<ClientRow>(`select ${CLIENT_COLUMNS} from uniora_api_clients where id = ?1`, [id])).rows[0];

  return {
    async create(input: CreateApiClientInput) {
      const valid = assertValidCreateApiClient(input);
      const now = new Date();
      try {
        const result = await db.query<ClientRow>(
          `insert into uniora_api_clients
             (id, name, name_normalized, scopes, all_organizations, organization_ids, created_at, created_by_provider, created_by_subject, updated_at)
           values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?7) returning ${CLIENT_COLUMNS}`,
          [
            input.id,
            valid.name,
            normalizeApiClientName(valid.name),
            jsonList(valid.scopes),
            valid.organizations === "*",
            jsonList(valid.organizations === "*" ? [] : valid.organizations),
            now,
            input.createdBy.provider,
            input.createdBy.subject,
          ],
        );
        return toClient(result.rows[0]!);
      } catch (error) {
        if (isUniqueViolation(error)) throw new ApiCredentialError("An API client with that id or name already exists.", "api_client_exists");
        throw error;
      }
    },

    async update(id: string, input: UpdateApiClientInput) {
      const valid = assertValidUpdateApiClient(input);
      assertApiId(id, "client id");
      return db.atomic(async () => {
        const current = await byId(id);
        if (!current) throw new ApiCredentialError(`API client not found: ${id}`, "api_client_not_found");
        assertVersion(current, input.expectedVersion);
        try {
          const result = await db.query<ClientRow>(
            `update uniora_api_clients set
               name = coalesce(?2, name),
               name_normalized = coalesce(?3, name_normalized),
               scopes = coalesce(?4, scopes),
               all_organizations = case when ?5 then ?6 else all_organizations end,
               organization_ids = case when ?5 then ?7 else organization_ids end,
               updated_at = ?8, version = version + 1
             where id = ?1 returning ${CLIENT_COLUMNS}`,
            [
              id,
              valid.name ?? null,
              valid.name !== undefined ? normalizeApiClientName(valid.name) : null,
              valid.scopes !== undefined ? jsonList(valid.scopes) : null,
              valid.organizations !== undefined,
              valid.organizations === "*",
              jsonList(valid.organizations === undefined || valid.organizations === "*" ? [] : valid.organizations),
              new Date(),
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
      return db.atomic(async () => {
        const current = await byId(id);
        if (!current) throw new ApiCredentialError(`API client not found: ${id}`, "api_client_not_found");
        assertVersion(current, input.expectedVersion);
        if (current.status === status) return toClient(current);
        const result = await db.query<ClientRow>(
          `update uniora_api_clients set status = ?2, updated_at = ?3, version = version + 1 where id = ?1 returning ${CLIENT_COLUMNS}`,
          [id, status, new Date()],
        );
        return toClient(result.rows[0]!);
      });
    },

    async findById(id: string) {
      const row = await byId(id);
      return row ? toClient(row) : null;
    },

    async search(options: SearchApiClientsOptions = {}) {
      const result = await db.query<ClientRow>(
        `select ${CLIENT_COLUMNS} from uniora_api_clients
         where (?1 is null or status = ?1) and (?2 is null or id > ?2)
         order by id limit ?3`,
        [options.status ?? null, options.after ?? null, clampApiPage(options.limit)],
      );
      return result.rows.map(toClient);
    },

    async count(options: Pick<SearchApiClientsOptions, "status"> = {}) {
      const result = await db.query<{ n: number }>(`select count(*) as n from uniora_api_clients where (?1 is null or status = ?1)`, [options.status ?? null]);
      return Number(result.rows[0]!.n);
    },
  };
}

interface KeyRow {
  id: string;
  client_id: string;
  secret_hash: string;
  hint: string;
  created_at: string;
  created_by_provider: string;
  created_by_subject: string;
  expires_at: string | null;
  revoked_at: string | null;
  revoked_by_provider: string | null;
  revoked_by_subject: string | null;
  last_used_at: string | null;
}
const KEY_COLUMNS =
  "id, client_id, secret_hash, hint, created_at, created_by_provider, created_by_subject, expires_at, revoked_at, revoked_by_provider, revoked_by_subject, last_used_at";
const toKey = (row: KeyRow): ApiKey => ({
  id: row.id,
  clientId: row.client_id,
  hint: row.hint,
  createdAt: new Date(row.created_at),
  createdBy: { provider: row.created_by_provider, subject: row.created_by_subject },
  ...(row.expires_at ? { expiresAt: new Date(row.expires_at) } : {}),
  ...(row.revoked_at && row.revoked_by_provider !== null && row.revoked_by_subject !== null
    ? { revokedAt: new Date(row.revoked_at), revokedBy: { provider: row.revoked_by_provider, subject: row.revoked_by_subject } }
    : {}),
  ...(row.last_used_at ? { lastUsedAt: new Date(row.last_used_at) } : {}),
});
const toRecord = (row: KeyRow): ApiKeyRecord => ({ ...toKey(row), secretHash: row.secret_hash });

export function createApiKeyRepository(db: SqliteExecutor): ApiKeyRepository {
  return {
    async create(input: CreateApiKeyInput) {
      assertValidCreateApiKey(input);
      // ISO strings compare chronologically, which is what `expires_at > ?` below relies on.
      return db.atomic(async () => {
        const client = await db.query(`select 1 from uniora_api_clients where id = ?1`, [input.clientId]);
        if (client.rowCount === 0) throw new ApiCredentialError(`API client not found: ${input.clientId}`, "api_client_not_found");
        const active = await db.query<{ n: number }>(
          `select count(*) as n from uniora_api_keys
           where client_id = ?1 and revoked_at is null and (expires_at is null or expires_at > ?2)`,
          [input.clientId, input.now],
        );
        if (Number(active.rows[0]!.n) >= MAX_ACTIVE_API_KEYS_PER_CLIENT) {
          throw new ApiCredentialError(`A client can have at most ${MAX_ACTIVE_API_KEYS_PER_CLIENT} active keys: revoke one first.`, "api_key_limit");
        }
        try {
          const result = await db.query<KeyRow>(
            `insert into uniora_api_keys (id, client_id, secret_hash, hint, created_at, created_by_provider, created_by_subject, expires_at)
             values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) returning ${KEY_COLUMNS}`,
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
        `update uniora_api_keys set revoked_at = ?2, revoked_by_provider = ?3, revoked_by_subject = ?4
         where id = ?1 and revoked_at is null returning ${KEY_COLUMNS}`,
        [id, input.at, input.by.provider, input.by.subject],
      );
      if (updated.rows[0]) return toKey(updated.rows[0]);
      const existing = await db.query<KeyRow>(`select ${KEY_COLUMNS} from uniora_api_keys where id = ?1`, [id]);
      if (!existing.rows[0]) throw new ApiCredentialError(`API key not found: ${id}`, "api_key_not_found");
      return toKey(existing.rows[0]);
    },

    async findRecordById(id: string) {
      const result = await db.query<KeyRow>(`select ${KEY_COLUMNS} from uniora_api_keys where id = ?1`, [id]);
      return result.rows[0] ? toRecord(result.rows[0]) : null;
    },

    async findById(id: string) {
      const result = await db.query<KeyRow>(`select ${KEY_COLUMNS} from uniora_api_keys where id = ?1`, [id]);
      return result.rows[0] ? toKey(result.rows[0]) : null;
    },

    async listByClient(clientId: string) {
      assertApiId(clientId, "client id");
      const result = await db.query<KeyRow>(`select ${KEY_COLUMNS} from uniora_api_keys where client_id = ?1 order by created_at desc, id`, [clientId]);
      return result.rows.map(toKey);
    },

    async listByClients(clientIds: string[]) {
      const out = new Map<string, ApiKey[]>(clientIds.map((id) => [id, []]));
      if (clientIds.length === 0) return out;
      const result = await db.query<KeyRow>(
        `select ${KEY_COLUMNS} from uniora_api_keys where client_id in (select value from json_each(?1)) order by created_at desc, id`,
        [jsonList(clientIds)],
      );
      for (const row of result.rows) out.get(row.client_id)?.push(toKey(row));
      return out;
    },

    async touch(id: string, at: Date, minIntervalMs: number) {
      // Compared as instants, not as text: `last_used_at` and `at` are both ISO strings with milliseconds.
      await db.query(
        `update uniora_api_keys set last_used_at = ?2
         where id = ?1 and (last_used_at is null or (julianday(?2) - julianday(last_used_at)) * 86400000.0 >= ?3)`,
        [id, at, minIntervalMs],
      );
    },
  };
}
