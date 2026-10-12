import type { Identity } from "../identity/types.js";
import { sameIdentity } from "../identity/types.js";
import type { MembershipListing, SearchMembershipsOptions } from "../membership/repository.js";
import type { UnioraStorage } from "../storage/types.js";

/** What a screen needs to show a person. UNIORA only knows `(provider, subject)`; everything here comes from the host. */
export interface IdentityProfile {
  displayName?: string;
  email?: string;
  avatarUrl?: string;
}

/**
 * Implemented by the application (e.g. against Supabase `auth.users`, Clerk, a users table): UNIORA never
 * depends on a provider, it just asks for the profiles of the identities it is about to show — one batch per page,
 * never one call per member. Identities the host doesn't know may simply be left out of the result.
 */
export interface ProfileResolver {
  resolveProfiles(identities: Identity[]): Promise<ReadonlyArray<{ identity: Identity; profile: IdentityProfile }>>;
}

/** A listed member with its resolved profile (absent when the host has none for them or the resolver failed). */
export type MemberListing = MembershipListing & { profile?: IdentityProfile };

const MAX_FIELD_LENGTH = 320;
/** Avatar URLs are often long signed links; a URL over this is dropped, not cut. */
const MAX_AVATAR_URL_LENGTH = 2048;
/** The most identities sent to the resolver in one call, whatever the page size. */
export const MAX_PROFILE_BATCH = 200;

/** Trimmed and capped; `undefined` for anything that is not a non-empty string. */
export function cleanProfileText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, MAX_FIELD_LENGTH) : undefined;
}

/** Only an `http(s)` URL, never a `javascript:` or `data:` one, and never longer than the cap (a cut URL would point elsewhere). */
export function cleanAvatarUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_AVATAR_URL_LENGTH) return undefined;
  try {
    const url = new URL(trimmed);
    return url.protocol === "https:" || url.protocol === "http:" ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Normalises whatever a resolver returned into a safe `IdentityProfile`: strings are trimmed and capped, unknown
 * fields dropped, and an avatar must be an `http(s)` URL (a `javascript:` or `data:` URL never reaches an `<img>`
 * or a link). Returns `undefined` when nothing usable is left.
 */
export function sanitizeProfile(profile: unknown): IdentityProfile | undefined {
  if (typeof profile !== "object" || profile === null) return undefined;
  const source = profile as Record<string, unknown>;
  const displayName = cleanProfileText(source.displayName);
  const email = cleanProfileText(source.email);
  const avatarUrl = cleanAvatarUrl(source.avatarUrl);
  if (displayName === undefined && email === undefined && avatarUrl === undefined) return undefined;
  return {
    ...(displayName !== undefined ? { displayName } : {}),
    ...(email !== undefined ? { email } : {}),
    ...(avatarUrl !== undefined ? { avatarUrl } : {}),
  };
}

export interface ListMembersWithProfilesOptions extends SearchMembershipsOptions {
  rolesPerMember: number;
  /** Called when the resolver throws; the listing is still returned, without profiles. Never throws itself. */
  onResolveError?: (error: unknown) => void;
}

/**
 * `memberships.searchListing` plus a `profile` per member: what is STORED (`storage.profiles`, one `findMany` for the whole
 * page) and, when a resolver is given, what it returns in ONE `resolveProfiles` call, which wins field by field (it is the live
 * source; the stored copy is what a screen without the host's provider, like Studio, can still show). A failing resolver or store
 * never breaks the members screen: the rows come back with what is left and `onResolveError` is told.
 */
export async function listMembersWithProfiles(
  storage: Pick<UnioraStorage, "memberships"> & Partial<Pick<UnioraStorage, "profiles">>,
  resolver: ProfileResolver | undefined,
  options: ListMembersWithProfilesOptions,
): Promise<MemberListing[]> {
  const { onResolveError, ...search } = options;
  const rows = await storage.memberships.searchListing(search);
  if ((!resolver && !storage.profiles) || rows.length === 0) return rows;

  const identities: Identity[] = [];
  for (const row of rows) {
    if (!identities.some((identity) => sameIdentity(identity, row.identity))) identities.push(row.identity);
  }
  const report = (error: unknown): void => {
    try {
      onResolveError?.(error);
    } catch {
      /* a failing logger never breaks the listing */
    }
  };

  const stored: Array<{ identity: Identity; profile: unknown }> = [];
  if (storage.profiles) {
    try {
      for (let start = 0; start < identities.length; start += MAX_PROFILE_BATCH) {
        for (const entry of await storage.profiles.findMany(identities.slice(start, start + MAX_PROFILE_BATCH))) stored.push({ identity: entry.identity, profile: entry });
      }
    } catch (error) {
      report(error);
    }
  }

  let resolved: ReadonlyArray<{ identity: Identity; profile: unknown }> = [];
  if (resolver) {
    try {
      const batches: Array<ReadonlyArray<{ identity: Identity; profile: IdentityProfile }>> = [];
      for (let start = 0; start < identities.length; start += MAX_PROFILE_BATCH) {
        batches.push(await resolver.resolveProfiles(identities.slice(start, start + MAX_PROFILE_BATCH)));
      }
      resolved = batches.flat();
    } catch (error) {
      report(error);
    }
  }

  return rows.map((row): MemberListing => {
    // Only a profile attached to exactly this identity counts: a resolver can't make a row show someone else.
    const fromStore = sanitizeProfile(stored.find((entry) => sameIdentity(entry.identity, row.identity))?.profile);
    const live = sanitizeProfile(resolved.find((entry) => sameIdentity(entry.identity, row.identity))?.profile);
    const profile = fromStore || live ? { ...fromStore, ...live } : undefined;
    return profile ? { ...row, profile } : row;
  });
}
