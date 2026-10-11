import { bearerToken, hashApiKeySecret, parseApiKey, verifyApiKeySecret } from "./key.js";
import type { ApiCredentialStorage } from "./repository.js";
import { isApiKeyActive } from "./types.js";
import type { ApiPrincipal } from "./types.js";

/** `lastUsedAt` is refreshed at most this often per key, so authenticating does not write on every request. */
export const API_KEY_TOUCH_INTERVAL_MS = 5 * 60 * 1000;

export interface AuthenticateApiKeyOptions {
  now?: Date;
  /** Default: five minutes. */
  touchIntervalMs?: number;
}

// Compared against when the key id is unknown, so an unknown id costs the same as a wrong secret.
const DECOY_HASH = hashApiKeySecret("uniora decoy secret: never matches a real key");

/**
 * Who a request is, from its `Authorization: Bearer <key>` header, or `null`.
 *
 * `null` is deliberately one answer for every reason (no header, malformed, wrong checksum, unknown id, wrong secret, revoked,
 * expired, client disabled): the caller learns nothing about which, and the server must answer all of them with the same
 * `401`. A storage failure is NOT `null`: it throws, so an outage is never mistaken for "not authenticated" nor, worse, for
 * "authenticated". The check is done in constant time with respect to the secret, and it needs no cache, so a revoked key
 * stops working on the very next request.
 */
export async function authenticateApiKey(
  storage: Pick<ApiCredentialStorage, "apiClients" | "apiKeys">,
  authorizationHeader: unknown,
  options: AuthenticateApiKeyOptions = {},
): Promise<ApiPrincipal | null> {
  const parsed = parseApiKey(bearerToken(authorizationHeader));
  if (!parsed) return null;

  const at = options.now ?? new Date();
  const record = await storage.apiKeys.findRecordById(parsed.id);
  const secretMatches = verifyApiKeySecret(parsed.secret, record?.secretHash ?? DECOY_HASH);
  if (!record || !secretMatches || !isApiKeyActive(record, at)) return null;

  const client = await storage.apiClients.findById(record.clientId);
  if (!client || client.status !== "active") return null;

  const interval = options.touchIntervalMs ?? API_KEY_TOUCH_INTERVAL_MS;
  if (record.lastUsedAt === undefined || at.getTime() - record.lastUsedAt.getTime() >= interval) {
    // Bookkeeping must never decide the answer: a failed write here does not fail an otherwise valid request.
    await storage.apiKeys.touch(record.id, at, interval).catch(() => undefined);
  }

  const { secretHash: _secretHash, ...key } = record;
  return { client, key };
}

/** Whether a client may touch an organization: `"*"`, or the organization is in its list. */
export function clientMayAccessOrganization(client: { organizations: "*" | readonly string[] }, organizationId: string): boolean {
  return client.organizations === "*" || client.organizations.includes(organizationId);
}
