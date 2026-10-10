import { randomUUID } from "node:crypto";
import type { Identity } from "../identity/types.js";
import { ApiCredentialError } from "./errors.js";
import { generateApiKey, randomBase62 } from "./key.js";
import { assertApiId, assertApiIdentity } from "./repository.js";
import type { ApiCredentialStorage, ApiCredentialTransaction, SearchApiClientsOptions } from "./repository.js";
import type { ApiScope } from "./scopes.js";
import type { ApiClient, ApiKey } from "./types.js";

export interface ApiCredentialServiceOptions {
  storage: ApiCredentialStorage;
  /** The clock, for tests. */
  now?: () => Date;
}

/** An API client with its keys, as a management screen shows it. */
export interface ApiClientWithKeys extends ApiClient {
  keys: ApiKey[];
}

export interface CreatedApiKey {
  readonly key: ApiKey;
  /**
   * The whole key. THE ONLY TIME IT EXISTS in a readable form: it is not stored (only its SHA-256 is), cannot be recovered
   * and must be shown to the operator once. Never log it and never put it in an audit entry.
   */
  readonly token: string;
}

/**
 * Creates and manages API clients and their keys, and audits every change with the operator who made it.
 *
 * This is for operators (Studio, the CLI), never for the API server itself: the server only READS credentials, and no API
 * route can create or change one, because a key that can mint keys is a privilege-escalation path.
 */
export interface ApiCredentialService {
  createClient(input: { actor: Identity; name: string; scopes: ApiScope[]; organizations: "*" | string[]; id?: string }): Promise<ApiClient>;
  updateClient(input: {
    actor: Identity;
    clientId: string;
    name?: string;
    scopes?: ApiScope[];
    organizations?: "*" | string[];
    expectedVersion?: number;
  }): Promise<ApiClient>;
  /** Every key of the client stops working at once; enabling it makes the still-valid ones work again. */
  disableClient(input: { actor: Identity; clientId: string; expectedVersion?: number }): Promise<ApiClient>;
  enableClient(input: { actor: Identity; clientId: string; expectedVersion?: number }): Promise<ApiClient>;
  /** A new key for the client (at most two active at once, so a key can be rotated with no downtime). */
  createKey(input: { actor: Identity; clientId: string; expiresAt?: Date }): Promise<CreatedApiKey>;
  /** Idempotent. Takes effect on the next request. */
  revokeKey(input: { actor: Identity; keyId: string }): Promise<ApiKey>;

  getClient(clientId: string): Promise<ApiClientWithKeys | null>;
  listClients(options?: SearchApiClientsOptions): Promise<ApiClientWithKeys[]>;
  countClients(options?: Pick<SearchApiClientsOptions, "status">): Promise<number>;
}

export function createApiCredentialService(options: ApiCredentialServiceOptions): ApiCredentialService {
  const { storage } = options;
  const now = options.now ?? (() => new Date());

  async function audit(
    tx: ApiCredentialTransaction,
    actor: Identity,
    action: string,
    target: { type: string; id: string },
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await tx.auditLogs.record({ id: randomUUID(), actor, action, target, metadata });
  }

  const organizationsMeta = (organizations: "*" | string[]) => (organizations === "*" ? { organizations: "*" } : { organizationCount: organizations.length });

  async function withKeys(clients: ApiClient[]): Promise<ApiClientWithKeys[]> {
    if (clients.length === 0) return [];
    const keys = await storage.apiKeys.listByClients(clients.map((client) => client.id));
    return clients.map((client) => ({ ...client, keys: keys.get(client.id) ?? [] }));
  }

  return {
    async createClient(input) {
      assertApiIdentity(input.actor, "actor");
      const id = input.id ?? `apc_${randomBase62(16)}`;
      return storage.transaction(async (tx) => {
        const client = await tx.apiClients.create({
          id,
          name: input.name,
          scopes: input.scopes,
          organizations: input.organizations,
          createdBy: input.actor,
        });
        await audit(tx, input.actor, "api_client.created", { type: "api_client", id: client.id }, {
          name: client.name,
          scopes: client.scopes,
          ...organizationsMeta(client.organizations),
        });
        return client;
      });
    },

    async updateClient(input) {
      assertApiIdentity(input.actor, "actor");
      assertApiId(input.clientId, "client id");
      return storage.transaction(async (tx) => {
        const client = await tx.apiClients.update(input.clientId, {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.scopes !== undefined ? { scopes: input.scopes } : {}),
          ...(input.organizations !== undefined ? { organizations: input.organizations } : {}),
          ...(input.expectedVersion !== undefined ? { expectedVersion: input.expectedVersion } : {}),
        });
        await audit(tx, input.actor, "api_client.updated", { type: "api_client", id: client.id }, {
          changed: [input.name !== undefined && "name", input.scopes !== undefined && "scopes", input.organizations !== undefined && "organizations"].filter(Boolean),
          ...(input.scopes !== undefined ? { scopes: client.scopes } : {}),
          ...(input.organizations !== undefined ? organizationsMeta(client.organizations) : {}),
          version: client.version,
        });
        return client;
      });
    },

    async disableClient(input) {
      return setStatus(input, "disabled");
    },

    async enableClient(input) {
      return setStatus(input, "active");
    },

    async createKey(input) {
      assertApiIdentity(input.actor, "actor");
      assertApiId(input.clientId, "client id");
      const at = now();
      const generated = generateApiKey();
      const key = await storage.transaction(async (tx) => {
        const client = await tx.apiClients.findById(input.clientId);
        if (!client) throw new ApiCredentialError(`API client not found: ${input.clientId}`, "api_client_not_found");
        if (client.status !== "active") throw new ApiCredentialError("A disabled client cannot get new keys: enable it first.", "api_client_disabled");
        const created = await tx.apiKeys.create({
          id: generated.id,
          clientId: client.id,
          secretHash: generated.secretHash,
          hint: generated.hint,
          createdBy: input.actor,
          ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
          now: at,
        });
        await audit(tx, input.actor, "api_key.created", { type: "api_key", id: created.id }, {
          clientId: client.id,
          hint: created.hint,
          ...(created.expiresAt ? { expiresAt: created.expiresAt.toISOString() } : {}),
        });
        return created;
      });
      return { key, token: generated.token };
    },

    async revokeKey(input) {
      assertApiIdentity(input.actor, "actor");
      assertApiId(input.keyId, "key id");
      return storage.transaction(async (tx) => {
        const before = await tx.apiKeys.findById(input.keyId);
        const key = await tx.apiKeys.revoke(input.keyId, { by: input.actor, at: now() });
        // A repeated revoke changes nothing, so it leaves no second entry.
        if (before && before.revokedAt === undefined) {
          await audit(tx, input.actor, "api_key.revoked", { type: "api_key", id: key.id }, { clientId: key.clientId, hint: key.hint });
        }
        return key;
      });
    },

    async getClient(clientId) {
      const client = await storage.apiClients.findById(clientId);
      return client ? (await withKeys([client]))[0]! : null;
    },

    async listClients(searchOptions) {
      return withKeys(await storage.apiClients.search(searchOptions));
    },

    countClients: (countOptions) => storage.apiClients.count(countOptions),
  };

  async function setStatus(
    input: { actor: Identity; clientId: string; expectedVersion?: number },
    status: "active" | "disabled",
  ): Promise<ApiClient> {
    assertApiIdentity(input.actor, "actor");
    assertApiId(input.clientId, "client id");
    return storage.transaction(async (tx) => {
      const before = await tx.apiClients.findById(input.clientId);
      const client = await tx.apiClients.setStatus(input.clientId, status, input.expectedVersion !== undefined ? { expectedVersion: input.expectedVersion } : {});
      if (before && before.status !== status) {
        await audit(tx, input.actor, status === "disabled" ? "api_client.disabled" : "api_client.enabled", { type: "api_client", id: client.id }, { name: client.name });
      }
      return client;
    });
  }
}
