import { createMemoryStorage } from "../storage/memory.js";
import type { AuditLogRepository } from "../audit-log/repository.js";
import { ApiCredentialError } from "./errors.js";
import {
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
} from "./repository.js";
import type {
  ApiClientRepository,
  ApiCredentialStorage,
  ApiCredentialTransaction,
  ApiKeyRepository,
  SearchApiClientsOptions,
} from "./repository.js";
import { isApiKeyActive } from "./types.js";
import type { ApiClient, ApiKey, ApiKeyRecord } from "./types.js";

const clone = <T>(value: T): T => structuredClone(value);
/** The stored shape: `ApiClient` with its bookkeeping fields writable. */
type StoredClient = { -readonly [K in keyof ApiClient]: ApiClient[K] };
const byId = <T extends { id: string }>(a: T, b: T): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const publicKey = ({ secretHash: _secretHash, ...key }: ApiKeyRecord): ApiKey => clone(key);

export interface MemoryApiCredentialStorageOptions {
  /** Where audit entries go. Pass `storage.auditLogs` of the `UnioraStorage` you use so both share one trail. */
  auditLogs?: AuditLogRepository;
}

/** In-memory `ApiCredentialStorage` for tests and prototypes. It enforces the same rules as the database backends. */
export function createMemoryApiCredentialStorage(options: MemoryApiCredentialStorageOptions = {}): ApiCredentialStorage {
  const auditLogs = options.auditLogs ?? createMemoryStorage().auditLogs;
  const clients = new Map<string, StoredClient>();
  const keys = new Map<string, ApiKeyRecord>();

  const apiClients: ApiClientRepository = {
    async create(input) {
      const valid = assertValidCreateApiClient(input);
      if (clients.has(input.id)) throw new ApiCredentialError(`An API client with id "${input.id}" already exists.`, "api_client_exists");
      const normalized = normalizeApiClientName(valid.name);
      if ([...clients.values()].some((client) => normalizeApiClientName(client.name) === normalized)) {
        throw new ApiCredentialError(`An API client named "${valid.name}" already exists.`, "api_client_exists");
      }
      const now = new Date();
      const client: StoredClient = {
        id: input.id,
        name: valid.name,
        scopes: valid.scopes,
        organizations: valid.organizations,
        status: "active",
        createdAt: now,
        createdBy: { ...input.createdBy },
        updatedAt: now,
        version: 1,
      };
      clients.set(client.id, client);
      return clone(client);
    },

    async update(id, input) {
      const valid = assertValidUpdateApiClient(input);
      const client = clients.get(id);
      if (!client) throw new ApiCredentialError(`API client not found: ${id}`, "api_client_not_found");
      if (input.expectedVersion !== undefined && input.expectedVersion !== client.version) {
        throw new ApiCredentialError("The API client changed since it was read.", "api_version_conflict");
      }
      if (valid.name !== undefined) {
        const normalized = normalizeApiClientName(valid.name);
        if ([...clients.values()].some((other) => other.id !== id && normalizeApiClientName(other.name) === normalized)) {
          throw new ApiCredentialError(`An API client named "${valid.name}" already exists.`, "api_client_exists");
        }
        client.name = valid.name;
      }
      if (valid.scopes !== undefined) client.scopes = valid.scopes;
      if (valid.organizations !== undefined) client.organizations = valid.organizations;
      client.updatedAt = new Date();
      client.version += 1;
      return clone(client);
    },

    async setStatus(id, status, input = {}) {
      assertApiClientStatus(status);
      assertApiVersion(input.expectedVersion);
      const client = clients.get(id);
      if (!client) throw new ApiCredentialError(`API client not found: ${id}`, "api_client_not_found");
      if (input.expectedVersion !== undefined && input.expectedVersion !== client.version) {
        throw new ApiCredentialError("The API client changed since it was read.", "api_version_conflict");
      }
      if (client.status !== status) {
        client.status = status;
        client.updatedAt = new Date();
        client.version += 1;
      }
      return clone(client);
    },

    async findById(id) {
      const client = clients.get(id);
      return client ? clone(client) : null;
    },

    async search(searchOptions: SearchApiClientsOptions = {}) {
      return [...clients.values()]
        .filter((client) => (searchOptions.status === undefined || client.status === searchOptions.status) && (searchOptions.after === undefined || client.id > searchOptions.after))
        .sort(byId)
        .slice(0, clampApiPage(searchOptions.limit))
        .map(clone);
    },

    async count(countOptions = {}) {
      return [...clients.values()].filter((client) => countOptions.status === undefined || client.status === countOptions.status).length;
    },
  };

  const apiKeys: ApiKeyRepository = {
    async create(input) {
      assertValidCreateApiKey(input);
      if (!clients.has(input.clientId)) throw new ApiCredentialError(`API client not found: ${input.clientId}`, "api_client_not_found");
      if (keys.has(input.id)) throw new ApiCredentialError(`An API key with id "${input.id}" already exists.`, "api_key_invalid");
      const active = [...keys.values()].filter((key) => key.clientId === input.clientId && isApiKeyActive(key, input.now)).length;
      if (active >= MAX_ACTIVE_API_KEYS_PER_CLIENT) {
        throw new ApiCredentialError(
          `A client can have at most ${MAX_ACTIVE_API_KEYS_PER_CLIENT} active keys: revoke one first.`,
          "api_key_limit",
        );
      }
      const record: ApiKeyRecord = {
        id: input.id,
        clientId: input.clientId,
        hint: input.hint,
        createdAt: input.now,
        createdBy: { ...input.createdBy },
        ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
        secretHash: input.secretHash,
      };
      keys.set(record.id, record);
      return publicKey(record);
    },

    async revoke(id, input) {
      assertApiIdentity(input.by, "revoker");
      const record = keys.get(id);
      if (!record) throw new ApiCredentialError(`API key not found: ${id}`, "api_key_not_found");
      if (record.revokedAt === undefined) {
        keys.set(id, { ...record, revokedAt: input.at, revokedBy: { ...input.by } });
      }
      return publicKey(keys.get(id)!);
    },

    async findRecordById(id) {
      const record = keys.get(id);
      return record ? clone(record) : null;
    },

    async findById(id) {
      const record = keys.get(id);
      return record ? publicKey(record) : null;
    },

    async listByClient(clientId) {
      assertApiId(clientId, "client id");
      return [...keys.values()]
        .filter((key) => key.clientId === clientId)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? -1 : 1))
        .map(publicKey);
    },

    async listByClients(clientIds) {
      const out = new Map<string, ApiKey[]>(clientIds.map((id) => [id, []]));
      for (const id of clientIds) out.set(id, await apiKeys.listByClient(id));
      return out;
    },

    async touch(id, at, minIntervalMs) {
      const record = keys.get(id);
      if (!record) return;
      if (record.lastUsedAt === undefined || at.getTime() - record.lastUsedAt.getTime() >= minIntervalMs) {
        keys.set(id, { ...record, lastUsedAt: at });
      }
    },
  };

  // Single-threaded between awaits only; a chain serialises transactions so check-then-write sequences cannot interleave,
  // like the lock of the database backends.
  let queue: Promise<unknown> = Promise.resolve();
  const scope: ApiCredentialTransaction = { apiClients, apiKeys, auditLogs };

  return {
    ...scope,
    transaction<T>(callback: (tx: ApiCredentialTransaction) => Promise<T>): Promise<T> {
      const run = queue.then(async () => {
        const before = { clients: structuredClone([...clients.entries()]), keys: structuredClone([...keys.entries()]) };
        try {
          return await callback(scope);
        } catch (error) {
          // Like a database rollback: nothing the callback wrote survives a failure.
          clients.clear();
          for (const [key, value] of before.clients) clients.set(key, value);
          keys.clear();
          for (const [key, value] of before.keys) keys.set(key, value);
          throw error;
        }
      });
      queue = run.catch(() => undefined);
      return run;
    },
  };
}
