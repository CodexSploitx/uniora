import type { Identity } from "../identity/types.js";
import type { ApiScope } from "./scopes.js";

export const API_CLIENT_STATUSES = ["active", "disabled"] as const;
export type ApiClientStatus = (typeof API_CLIENT_STATUSES)[number];

/**
 * A machine principal that calls the UNIORA API: "billing-backend", "signup-worker". It owns what it may call (`scopes`) and
 * which organizations it may touch (`organizations`): `"*"` for all, or an explicit list. The list is the main defence against
 * one customer's key reaching another's data, so a key is never "global" by accident.
 */
export interface ApiClient {
  readonly id: string;
  /** Unique, case-insensitively. */
  name: string;
  scopes: ApiScope[];
  organizations: "*" | string[];
  status: ApiClientStatus;
  readonly createdAt: Date;
  readonly createdBy: Identity;
  readonly updatedAt: Date;
  /** Starts at 1 and goes up on every change; pass it back as `expectedVersion` to refuse edits made from a stale copy. */
  readonly version: number;
}

/**
 * What can be shown about a key. The secret is shown ONCE, when the key is created, and is not stored: only its SHA-256 is
 * kept, and that never leaves the storage.
 */
export interface ApiKey {
  /** The public part of the key, safe to log and display; it is also embedded in the key itself. */
  readonly id: string;
  readonly clientId: string;
  /** The last four characters of the secret, to tell keys apart in a list. */
  readonly hint: string;
  readonly createdAt: Date;
  readonly createdBy: Identity;
  readonly expiresAt?: Date;
  readonly revokedAt?: Date;
  readonly revokedBy?: Identity;
  /** Approximate: it is refreshed at most every few minutes to avoid a write per request. */
  readonly lastUsedAt?: Date;
}

/** A key as the storage hands it to authentication: the public view plus the digest to compare against. Never leaves the package's authentication code. */
export interface ApiKeyRecord extends ApiKey {
  readonly secretHash: string;
}

/** Who a request authenticated as. */
export interface ApiPrincipal {
  readonly client: ApiClient;
  readonly key: ApiKey;
}

export function isApiKeyActive(key: Pick<ApiKey, "revokedAt" | "expiresAt">, now: Date): boolean {
  return key.revokedAt === undefined && (key.expiresAt === undefined || key.expiresAt.getTime() > now.getTime());
}
