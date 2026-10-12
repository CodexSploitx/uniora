import type { Identity } from "../identity/types.js";
import type { UnioraStorage } from "../storage/types.js";
import type { IdentityProfile } from "./profiles.js";
import { normalizeProfileInput } from "./repository.js";

export interface ProfileSyncOptions {
  /** How long an unchanged profile is trusted before it is written again. Default: 15 minutes. A changed profile is written at once. */
  minIntervalMs?: number;
  /** Called when a write fails. The failure never reaches the caller (a profile problem must not break a sign-in); the next request retries. */
  onError?: (error: unknown) => void;
  /** The most identities remembered at once (oldest forgotten first). Default: 10,000. */
  maxEntries?: number;
  /** Clock, for tests. */
  now?: () => number;
}

/** Keeps the stored profiles of the people who use the app up to date, one call per request. See `createProfileSync`. */
export type ProfileSync = (identity: Identity, profile: IdentityProfile | null | undefined) => Promise<void>;

/**
 * The sync a host calls where it already resolves the caller (right after the adapter's `resolveIdentityWithProfile`), so a person's
 * name, e-mail and avatar are stored the first time they are seen and refreshed when they change — including people who were
 * members long before profiles existed: the first request they make after the upgrade fills theirs in, with no migration or script.
 *
 * ```ts
 * const sync = createProfileSync(storage);
 * const session = await resolveIdentityWithProfile(supabase, token);
 * if (session) await sync(session.identity, session.profile);
 * ```
 *
 * Cheap on the hot path: a profile that has not changed is not written again until `minIntervalMs` has passed (remembered in memory,
 * per process), and a failing store only calls `onError`: the returned promise never rejects. Fields the provider did not give are
 * left out of the write, so they keep what is already stored.
 */
export function createProfileSync(storage: Pick<UnioraStorage, "profiles">, options: ProfileSyncOptions = {}): ProfileSync {
  const { minIntervalMs = 15 * 60 * 1000, onError, maxEntries = 10_000, now = Date.now } = options;
  const seen = new Map<string, { fingerprint: string; at: number }>();

  return async (identity, profile) => {
    try {
      const change = normalizeProfileInput(profile);
      if (Object.keys(change).length === 0) return;
      const key = JSON.stringify([identity.provider, identity.subject]);
      const fingerprint = JSON.stringify(change);
      const at = now();
      const previous = seen.get(key);
      if (previous && previous.fingerprint === fingerprint && at - previous.at < minIntervalMs) return;

      await storage.profiles.upsert(identity, change);

      seen.delete(key);
      seen.set(key, { fingerprint, at });
      while (seen.size > maxEntries) seen.delete(seen.keys().next().value as string);
    } catch (error) {
      try {
        onError?.(error);
      } catch {
        /* a failing logger never breaks the request */
      }
    }
  };
}
