import type { Queryable } from "./queryable.js";
import { toLikePattern } from "./pg-like.js";

/** Queries shorter than this have no trigrams to look up. */
const MIN_INDEXED_LENGTH = 3;
/** More candidates than this and the term is too common to narrow anything: let the ordinary ordered scan find a page. */
const MAX_CANDIDATES = 10_000;

const PROBES = {
  memberships: "select id from uniora.memberships where ($2::text is null or organization_id = $2) and (provider ilike $1 or subject ilike $1) limit",
  organizations: "select id from uniora.organizations where (name ilike $1 or slug ilike $1) limit",
  invitations: "select id from uniora.invitations where organization_id = $2 and email ilike $1 limit",
} as const;

/**
 * Ids that can match a "contains" search, or `null` when looking them up first does not help.
 *
 * `... where name ilike '%x%' order by id limit 26` makes PostgreSQL choose between walking the primary key and filtering,
 * or using the trigram index and sorting. It guesses from statistics, and for a term that is rare in a huge table it picks
 * the walk (seconds on five million rows). Asking the index first, unordered and capped, has no such ambiguity: a rare term
 * returns its few ids at once, and the page query then fetches exactly those. A term with more than `MAX_CANDIDATES` matches
 * is common enough that the ordered scan finds its first page almost immediately, so that case returns `null` and the
 * caller runs its ordinary query. Either way the caller keeps the exact `ilike` predicate, so what matches does not change.
 */
export async function searchCandidates(
  db: Queryable,
  table: keyof typeof PROBES,
  query: string | undefined,
  organizationId?: string,
): Promise<string[] | null> {
  const text = query?.trim();
  if (!text || text.length < MIN_INDEXED_LENGTH) return null;
  const result = await db.query<{ id: string }>(`${PROBES[table]} ${MAX_CANDIDATES + 1}`, [
    toLikePattern(text),
    ...(table === "organizations" ? [] : [organizationId ?? null]),
  ]);
  return result.rows.length > MAX_CANDIDATES ? null : result.rows.map((row) => row.id);
}
