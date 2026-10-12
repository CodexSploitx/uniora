import type { Identity } from "../identity/types.js";
import { MAX_PROFILE_BATCH } from "./profiles.js";
import type { IdentityProfileRepository, StoredIdentityProfile } from "./repository.js";
import { normalizeProfileInput } from "./repository.js";

const key = (identity: Identity): string => JSON.stringify([identity.provider, identity.subject]);
const clone = (profile: StoredIdentityProfile): StoredIdentityProfile => ({ ...profile, identity: { ...profile.identity }, updatedAt: new Date(profile.updatedAt) });

/** In-memory `IdentityProfileRepository` (tests and the memory storage). Same rules as the SQL ones: absent keeps, `null` clears. */
export function createMemoryProfileRepository(): IdentityProfileRepository {
  const profiles = new Map<string, StoredIdentityProfile>();
  return {
    async upsert(identity, input) {
      const change = normalizeProfileInput(input);
      const current = profiles.get(key(identity));
      if (Object.keys(change).length === 0) return current ? clone(current) : null;
      const merged = { displayName: current?.displayName, email: current?.email, avatarUrl: current?.avatarUrl };
      for (const field of ["displayName", "email", "avatarUrl"] as const) {
        if (field in change) merged[field] = change[field] ?? undefined;
      }
      if (merged.displayName === undefined && merged.email === undefined && merged.avatarUrl === undefined) {
        profiles.delete(key(identity));
        return null;
      }
      const stored: StoredIdentityProfile = {
        identity: { provider: identity.provider, subject: identity.subject },
        ...(merged.displayName !== undefined ? { displayName: merged.displayName } : {}),
        ...(merged.email !== undefined ? { email: merged.email } : {}),
        ...(merged.avatarUrl !== undefined ? { avatarUrl: merged.avatarUrl } : {}),
        updatedAt: new Date(),
      };
      profiles.set(key(identity), stored);
      return clone(stored);
    },
    async findMany(identities) {
      const found: StoredIdentityProfile[] = [];
      for (const identity of identities.slice(0, MAX_PROFILE_BATCH)) {
        const profile = profiles.get(key(identity));
        if (profile && !found.some((entry) => key(entry.identity) === key(identity))) found.push(clone(profile));
      }
      return found;
    },
    async search({ query, limit }) {
      const text = query.trim().toLowerCase();
      if (!text) return [];
      const cap = Math.min(Math.max(Math.trunc(limit ?? MAX_PROFILE_BATCH), 0), MAX_PROFILE_BATCH);
      return [...profiles.values()]
        .filter((profile) => (profile.displayName?.toLowerCase().includes(text) ?? false) || (profile.email?.toLowerCase().includes(text) ?? false))
        .sort((a, b) => (key(a.identity) < key(b.identity) ? -1 : key(a.identity) > key(b.identity) ? 1 : 0))
        .slice(0, cap)
        .map(clone);
    },
    async delete(identity) {
      return profiles.delete(key(identity));
    },
  };
}
