import type { Identity } from "../identity/types.js";
import type { IdentityProfile } from "./profiles.js";
import { cleanProfileText, cleanAvatarUrl } from "./profiles.js";

/**
 * What a host reports about a person. A field left out (`undefined`) is KEPT as stored; `null` clears it. So a sync that only
 * knows the e-mail (e.g. a session token with no name claim) never wipes the name a previous sync stored.
 */
export interface IdentityProfileInput {
  displayName?: string | null;
  email?: string | null;
  avatarUrl?: string | null;
}

/** A stored profile with the moment it was last written. */
export interface StoredIdentityProfile extends IdentityProfile {
  readonly identity: Identity;
  readonly updatedAt: Date;
}

/**
 * The name, e-mail and avatar URL of the people UNIORA lists, stored next to the memberships so a screen (Studio, an admin
 * page) can show a person and not just an id. The host fills it from its auth provider (the adapters' `toProfile`); UNIORA never
 * calls the provider itself.
 *
 * Keyed by `(provider, subject)` and global (not per organization): it is the same person in every organization they belong to.
 * It is display data only: it never takes part in an authorization decision, and `avatarUrl` is just a URL, never an object.
 * Writing it is NOT audited (it is a sync that can run on every sign-in, not a decision about access).
 */
export interface IdentityProfileRepository {
  /**
   * Stores what is given for `identity`, keeping the fields that were left out. Values are trimmed and capped, an avatar must be
   * an `http(s)` URL (anything else is dropped), and when nothing usable is left and there is no stored row, nothing is written.
   * Resolves the profile as stored afterwards, or `null` when there is none.
   */
  upsert(identity: Identity, profile: IdentityProfileInput): Promise<StoredIdentityProfile | null>;
  /** The stored profiles of these identities (at most `MAX_PROFILE_BATCH`); identities with none are simply absent. */
  findMany(identities: readonly Identity[]): Promise<StoredIdentityProfile[]>;
  /**
   * The profiles whose name or e-mail contains `query` (case-insensitive, matched literally), at most `limit` (default and maximum
   * `MAX_PROFILE_BATCH`), in a stable order. A query shorter than one character matches nothing. Feed the identities to
   * `memberships.searchListing({ query, orIdentities })` to find a person by name or e-mail.
   */
  search(options: { query: string; limit?: number }): Promise<StoredIdentityProfile[]>;
  /** Removes the stored profile; `false` when there was none. */
  delete(identity: Identity): Promise<boolean>;
}

/** What an `upsert` input becomes: the fields to set (a string) or clear (`null`); a field absent from the result is kept. */
export type NormalizedProfileInput = { displayName?: string | null; email?: string | null; avatarUrl?: string | null };

/**
 * Applies the one set of rules every storage shares to an `upsert` input: trimmed, capped text, an `http(s)` avatar, `null`
 * to clear, and an unusable value (empty, not a string, a `javascript:` URL) treated as absent rather than as a clear.
 */
export function normalizeProfileInput(input: unknown): NormalizedProfileInput {
  const source = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  const out: NormalizedProfileInput = {};
  if (source.displayName === null) out.displayName = null;
  else {
    const value = cleanProfileText(source.displayName);
    if (value !== undefined) out.displayName = value;
  }
  if (source.email === null) out.email = null;
  else {
    const value = cleanProfileText(source.email);
    if (value !== undefined) out.email = value;
  }
  if (source.avatarUrl === null) out.avatarUrl = null;
  else {
    const value = cleanAvatarUrl(source.avatarUrl);
    if (value !== undefined) out.avatarUrl = value;
  }
  return out;
}
