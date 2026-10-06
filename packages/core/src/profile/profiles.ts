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
/** The most identities sent to the resolver in one call, whatever the page size. */
export const MAX_PROFILE_BATCH = 200;

function clean(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, MAX_FIELD_LENGTH) : undefined;
}

/**
 * Normalises whatever a resolver returned into a safe `IdentityProfile`: strings are trimmed and capped, unknown
 * fields dropped, and an avatar must be an `http(s)` URL (a `javascript:` or `data:` URL never reaches an `<img>`
 * or a link). Returns `undefined` when nothing usable is left.
 */
export function sanitizeProfile(profile: unknown): IdentityProfile | undefined {
  if (typeof profile !== "object" || profile === null) return undefined;
  const source = profile as Record<string, unknown>;
  const displayName = clean(source.displayName);
  const email = clean(source.email);
  let avatarUrl = clean(source.avatarUrl);
  if (avatarUrl !== undefined) {
    try {
      const url = new URL(avatarUrl);
      if (url.protocol !== "https:" && url.protocol !== "http:") avatarUrl = undefined;
    } catch {
      avatarUrl = undefined;
    }
  }
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
 * `memberships.searchListing` plus a `profile` per member, resolved in ONE `resolveProfiles` call for the
 * whole page. A failing or slow-to-fail resolver never breaks the members screen: the rows come back without
 * profiles and `onResolveError` is told. Without a resolver this is just `searchListing`.
 */
export async function listMembersWithProfiles(
  storage: Pick<UnioraStorage, "memberships">,
  resolver: ProfileResolver | undefined,
  options: ListMembersWithProfilesOptions,
): Promise<MemberListing[]> {
  const { onResolveError, ...search } = options;
  const rows = await storage.memberships.searchListing(search);
  if (!resolver || rows.length === 0) return rows;

  const identities: Identity[] = [];
  for (const row of rows) {
    if (!identities.some((identity) => sameIdentity(identity, row.identity))) identities.push(row.identity);
  }

  let resolved: ReadonlyArray<{ identity: Identity; profile: unknown }> = [];
  try {
    const batches: Array<ReadonlyArray<{ identity: Identity; profile: IdentityProfile }>> = [];
    for (let start = 0; start < identities.length; start += MAX_PROFILE_BATCH) {
      batches.push(await resolver.resolveProfiles(identities.slice(start, start + MAX_PROFILE_BATCH)));
    }
    resolved = batches.flat();
  } catch (error) {
    try {
      onResolveError?.(error);
    } catch {
      /* a failing logger never breaks the listing */
    }
    return rows;
  }

  return rows.map((row): MemberListing => {
    // Only a profile the resolver attached to exactly this identity counts: a resolver can't make a row show someone else.
    const match = resolved.find((entry) => sameIdentity(entry.identity, row.identity));
    const profile = sanitizeProfile(match?.profile);
    return profile ? { ...row, profile } : row;
  });
}
