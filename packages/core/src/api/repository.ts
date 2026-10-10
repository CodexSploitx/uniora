import type { Identity } from "../identity/types.js";
import type { AuditLogRepository } from "../audit-log/repository.js";
import { ApiCredentialError } from "./errors.js";
import { isApiScope, type ApiScope } from "./scopes.js";
import type { ApiClient, ApiClientStatus, ApiKey, ApiKeyRecord } from "./types.js";
import { API_CLIENT_STATUSES } from "./types.js";

export { ApiCredentialError } from "./errors.js";
export type { ApiCredentialErrorCode } from "./errors.js";

export const MAX_API_CLIENT_NAME_LENGTH = 100;
export const MAX_API_CLIENT_ORGANIZATIONS = 500;
export const MAX_API_ORGANIZATION_ID_LENGTH = 200;
/** Two, so a key can be rotated with no downtime: create the new one, deploy it, revoke the old one. */
export const MAX_ACTIVE_API_KEYS_PER_CLIENT = 2;
/** A key may expire, but not in the far future: a "temporary" key that outlives the project is not temporary. */
export const MAX_API_KEY_LIFETIME_MS = 5 * 365 * 24 * 60 * 60 * 1000;

export interface CreateApiClientInput {
  id: string;
  name: string;
  scopes: ApiScope[];
  organizations: "*" | string[];
  createdBy: Identity;
}

export interface UpdateApiClientInput {
  name?: string;
  scopes?: ApiScope[];
  organizations?: "*" | string[];
  expectedVersion?: number;
}

export interface SearchApiClientsOptions {
  status?: ApiClientStatus;
  limit?: number;
  /** Keyset cursor: the `id` of the last client of the previous page; results are ordered by `id`. */
  after?: string;
}

export interface ApiClientRepository {
  /** `api_client_exists` when the id or the name (case-insensitive) is taken. */
  create(input: CreateApiClientInput): Promise<ApiClient>;
  /** `api_client_not_found`; `api_version_conflict` when `expectedVersion` is stale. */
  update(id: string, input: UpdateApiClientInput): Promise<ApiClient>;
  setStatus(id: string, status: ApiClientStatus, input?: { expectedVersion?: number }): Promise<ApiClient>;
  findById(id: string): Promise<ApiClient | null>;
  search(options?: SearchApiClientsOptions): Promise<ApiClient[]>;
  count(options?: Pick<SearchApiClientsOptions, "status">): Promise<number>;
}

export interface CreateApiKeyInput {
  /** The public id inside the key. */
  id: string;
  clientId: string;
  /** SHA-256 of the secret. */
  secretHash: string;
  hint: string;
  createdBy: Identity;
  expiresAt?: Date;
  /** The moment of creation; also the moment the active-key cap is evaluated at. */
  now: Date;
}

export interface ApiKeyRepository {
  /**
   * `api_client_not_found` for an unknown client; `api_key_limit` when the client already has two active keys. The cap is
   * decided atomically with the insert, so two concurrent creations cannot both slip under it.
   */
  create(input: CreateApiKeyInput): Promise<ApiKey>;
  /** Idempotent: a key that is already revoked is returned as it is. `api_key_not_found` for an unknown id. */
  revoke(id: string, input: { by: Identity; at: Date }): Promise<ApiKey>;
  /** The key with its digest, FOR AUTHENTICATION ONLY. */
  findRecordById(id: string): Promise<ApiKeyRecord | null>;
  findById(id: string): Promise<ApiKey | null>;
  /** Every key of the client, newest first. */
  listByClient(clientId: string): Promise<ApiKey[]>;
  /** Many clients at once, so a list page costs one query: key lists by client id. */
  listByClients(clientIds: string[]): Promise<Map<string, ApiKey[]>>;
  /** Sets `lastUsedAt` unless it was already set within `minIntervalMs` before `at`. Never throws for a missing key. */
  touch(id: string, at: Date, minIntervalMs: number): Promise<void>;
}

/**
 * The storage of API credentials. It is a SEPARATE object from `UnioraStorage` on purpose, like the platform's: code that
 * serves organizations never holds it, the databases keep its tables apart (own schema in Postgres) and you can give it its
 * own credentials. In a transaction it also exposes the audit log, so a change and its audit entry commit together.
 */
export interface ApiCredentialTransaction {
  apiClients: ApiClientRepository;
  apiKeys: ApiKeyRepository;
  auditLogs: AuditLogRepository;
}

export interface ApiCredentialStorage extends ApiCredentialTransaction {
  transaction<T>(callback: (tx: ApiCredentialTransaction) => Promise<T>): Promise<T>;
}

// ---------------------------------------------------------------------------------------------------------------------
// Validation shared by every backend, so the memory, SQLite and Postgres storages refuse exactly the same things.

export function assertApiIdentity(identity: unknown, what: string): asserts identity is Identity {
  const value = identity as Partial<Identity> | null;
  if (
    !value ||
    typeof value.provider !== "string" ||
    typeof value.subject !== "string" ||
    value.provider.trim() === "" ||
    value.subject.trim() === "" ||
    value.provider.length > 200 ||
    value.subject.length > 500
  ) {
    throw new ApiCredentialError(`The ${what} must have a provider and a subject.`, "api_invalid");
  }
}

export function assertApiId(id: unknown, what: string): asserts id is string {
  if (typeof id !== "string" || id.trim() === "" || id.length > 200) {
    throw new ApiCredentialError(`The ${what} must be a non-empty string of at most 200 characters.`, "api_invalid");
  }
}

export function sanitizeApiClientName(name: unknown): string {
  if (typeof name !== "string") throw new ApiCredentialError("The client name must be a string.", "api_client_invalid");
  const trimmed = name.trim().replace(/\s+/g, " ");
  // eslint-disable-next-line no-control-regex
  if (trimmed === "" || trimmed.length > MAX_API_CLIENT_NAME_LENGTH || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new ApiCredentialError(
      `The client name must be 1 to ${MAX_API_CLIENT_NAME_LENGTH} characters, without control characters.`,
      "api_client_invalid",
    );
  }
  return trimmed;
}

/** What two names are compared by: case-insensitive and ignoring surrounding and repeated whitespace. */
export function normalizeApiClientName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

export function sanitizeApiScopes(scopes: unknown): ApiScope[] {
  if (!Array.isArray(scopes) || scopes.length === 0) {
    throw new ApiCredentialError("A client needs at least one scope.", "api_scope_invalid");
  }
  const seen = new Set<ApiScope>();
  for (const scope of scopes) {
    if (!isApiScope(scope)) throw new ApiCredentialError(`Unknown scope "${String(scope)}".`, "api_scope_invalid");
    seen.add(scope);
  }
  return [...seen].sort();
}

export function sanitizeApiOrganizations(value: unknown): "*" | string[] {
  if (value === "*") return "*";
  if (!Array.isArray(value) || value.length === 0) {
    throw new ApiCredentialError('Give "*" (every organization) or a non-empty list of organization ids.', "api_organizations_invalid");
  }
  if (value.length > MAX_API_CLIENT_ORGANIZATIONS) {
    throw new ApiCredentialError(`At most ${MAX_API_CLIENT_ORGANIZATIONS} organizations per client; use "*" for all.`, "api_organizations_invalid");
  }
  const seen = new Set<string>();
  for (const id of value) {
    if (typeof id !== "string" || id === "*" || id.trim() === "" || id.length > MAX_API_ORGANIZATION_ID_LENGTH) {
      throw new ApiCredentialError("Each organization id must be a non-empty string of at most 200 characters.", "api_organizations_invalid");
    }
    seen.add(id);
  }
  return [...seen].sort();
}

export function assertApiClientStatus(status: unknown): asserts status is ApiClientStatus {
  if (!(API_CLIENT_STATUSES as readonly unknown[]).includes(status)) {
    throw new ApiCredentialError(`The status must be one of ${API_CLIENT_STATUSES.join(", ")}.`, "api_client_invalid");
  }
}

export function assertApiVersion(version: unknown): asserts version is number | undefined {
  if (version !== undefined && (!Number.isInteger(version) || (version as number) < 1)) {
    throw new ApiCredentialError("expectedVersion must be a positive integer.", "api_invalid");
  }
}

export function assertValidCreateApiClient(input: CreateApiClientInput): { name: string; scopes: ApiScope[]; organizations: "*" | string[] } {
  assertApiId(input.id, "client id");
  assertApiIdentity(input.createdBy, "creator");
  return {
    name: sanitizeApiClientName(input.name),
    scopes: sanitizeApiScopes(input.scopes),
    organizations: sanitizeApiOrganizations(input.organizations),
  };
}

export function assertValidUpdateApiClient(input: UpdateApiClientInput): {
  name?: string;
  scopes?: ApiScope[];
  organizations?: "*" | string[];
} {
  assertApiVersion(input.expectedVersion);
  const out: { name?: string; scopes?: ApiScope[]; organizations?: "*" | string[] } = {};
  if (input.name !== undefined) out.name = sanitizeApiClientName(input.name);
  if (input.scopes !== undefined) out.scopes = sanitizeApiScopes(input.scopes);
  if (input.organizations !== undefined) out.organizations = sanitizeApiOrganizations(input.organizations);
  if (Object.keys(out).length === 0) throw new ApiCredentialError("Nothing to update: give a name, scopes or organizations.", "api_client_invalid");
  return out;
}

export function assertValidCreateApiKey(input: CreateApiKeyInput): void {
  assertApiId(input.id, "key id");
  assertApiId(input.clientId, "client id");
  assertApiIdentity(input.createdBy, "creator");
  if (!/^[0-9a-f]{64}$/.test(input.secretHash)) throw new ApiCredentialError("The secret hash must be a SHA-256 hex digest.", "api_key_invalid");
  if (typeof input.hint !== "string" || input.hint.length !== 4) throw new ApiCredentialError("The hint must be four characters.", "api_key_invalid");
  if (input.expiresAt !== undefined) {
    const lifetime = input.expiresAt.getTime() - input.now.getTime();
    if (!(lifetime > 0)) throw new ApiCredentialError("The expiry must be in the future.", "api_key_invalid");
    if (lifetime > MAX_API_KEY_LIFETIME_MS) throw new ApiCredentialError("A key may not live more than five years.", "api_key_invalid");
  }
}

export function clampApiPage(limit: number | undefined): number {
  return Math.min(Math.max(Math.trunc(limit ?? 50), 1), 200);
}
