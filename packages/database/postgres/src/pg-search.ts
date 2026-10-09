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

/** Rows of the ordered walk tried before asking the trigram index (a few ms of `ilike`). */
const WALK_WINDOW = 10_000;

const WALK_FIRST_PAGE =
  "select id from (select id, provider, subject from uniora.memberships where ($2::text is null or organization_id = $2) and ($3::text is null or id > $3) order by id limit " +
  WALK_WINDOW +
  ") w where (provider ilike $1 or subject ilike $1) order by id limit $4";

const WALK_COUNT =
  "select count(*)::int as count from (select 1 from (select provider, subject from uniora.memberships where ($2::text is null or organization_id = $2) order by id limit " +
  WALK_WINDOW +
  ") w where (provider ilike $1 or subject ilike $1) limit $3) c";

/** The planner's estimate of how many memberships match `text` (one cheap `explain`, nothing is read). */
async function expectedMatches(db: Queryable, text: string): Promise<number> {
  const result = await db.query<{ "QUERY PLAN": { Plan: { "Plan Rows": number } }[] }>(
    "explain (format json) select 1 from uniora.memberships where (provider ilike $1 or subject ilike $1)",
    [toLikePattern(text)],
  );
  return Number(result.rows[0]?.["QUERY PLAN"]?.[0]?.Plan?.["Plan Rows"] ?? 0);
}

/** Where a page starts and how long it is — lets a common term be answered by walking the first rows in order. */
export interface PageHint {
  after?: string;
  limit: number;
}

/**
 * How many of the first `WALK_WINDOW` memberships (in id order) match, up to `cap`. Reaching the cap answers a capped
 * count outright; falling short says nothing about the rest of the table, so the caller carries on with its normal query.
 */
export async function walkCount(db: Queryable, query: string | undefined, organizationId: string | undefined, cap: number): Promise<number> {
  const text = query?.trim();
  if (!text || text.length < MIN_INDEXED_LENGTH) return 0;
  const result = await db.query<{ count: number }>(WALK_COUNT, [toLikePattern(text), organizationId ?? null, cap]);
  return Number(result.rows[0]?.count ?? 0);
}

/**
 * Ids that can match a "contains" search, or `null` when looking them up first does not help.
 *
 * `... where name ilike '%x%' order by id limit 26` makes PostgreSQL choose between walking the primary key and filtering,
 * or using the trigram index and sorting. It guesses from statistics, and for a term that is rare in a huge table it picks
 * the walk (seconds on five million rows). Asking the index first, unordered and capped, has no such ambiguity: a rare term
 * returns its few ids at once, and the page query then fetches exactly those. A term with more than `MAX_CANDIDATES` matches
 * is common enough that the ordered scan finds its first page almost immediately, so that case returns `null` and the
 * caller runs its ordinary query. Either way the caller keeps the exact `ilike` predicate, so what matches does not change.
 *
 * A term that is common (a few percent of a table) makes the trigram probe itself the slow part: it must read every match
 * before it can say "too many". So, for memberships and when the caller filters on nothing else (`page` given), the first
 * `WALK_WINDOW` rows in id order are tried first: if they already hold a full page of matches, those ARE the first matches
 * overall (the window is a prefix of the ordering), and they are returned as the candidates without touching the index.
 */
export async function searchCandidates(
  db: Queryable,
  table: keyof typeof PROBES,
  query: string | undefined,
  organizationId?: string,
  page?: PageHint,
): Promise<string[] | null> {
  const text = query?.trim();
  if (!text || text.length < MIN_INDEXED_LENGTH) return null;
  if (table === "memberships" && page && page.limit > 0) {
    const walked = await db.query<{ id: string }>(WALK_FIRST_PAGE, [toLikePattern(text), organizationId ?? null, page.after ?? null, page.limit]);
    if (walked.rows.length >= page.limit) return walked.rows.map((row) => row.id);
  }
  // The planner already knows (from the trigram statistics) when a term matches a large share of the table. Reading every
  // match just to say "too many" is the expensive part of such a search, so a term it expects to be common skips the probe.
  if (table === "memberships" && !organizationId && (await expectedMatches(db, text)) > MAX_CANDIDATES) return null;
  const result = await db.query<{ id: string }>(`${PROBES[table]} ${MAX_CANDIDATES + 1}`, [
    toLikePattern(text),
    ...(table === "organizations" ? [] : [organizationId ?? null]),
  ]);
  return result.rows.length > MAX_CANDIDATES ? null : result.rows.map((row) => row.id);
}
