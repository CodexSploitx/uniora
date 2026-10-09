/**
 * How far Studio counts. A total next to a list is "more than N" past its cap, so a table of millions of rows costs one
 * page of work, never a full count. A count asks for `cap + 1` rows: seeing the extra one is what says "more than N".
 * Everything is paged with keyset cursors; nothing loads "all of" anything.
 */
export const TOTAL_CAP = 10_000;
/** Counts that must test every row against a search or a status (one row fetch each) stop sooner. */
export const FILTERED_CAP = 1_000;

/** The `limit` to pass to a repository count for an unfiltered (index-only) or a filtered one. */
export const countLimit = (filtered = false): number => (filtered ? FILTERED_CAP : TOTAL_CAP) + 1;

/**
 * Translator parameters for a total: the number picks the plural. A count that hit its cap reads "10,000+" / "1,000+"
 * (formatted for the viewer's language by the translator); an exact total, even millions, is shown in full.
 */
export function capParams(count: number): { count: number; capped?: number } {
  if (count === TOTAL_CAP + 1) return { count, capped: TOTAL_CAP };
  if (count === FILTERED_CAP + 1) return { count, capped: FILTERED_CAP };
  return { count };
}

/** A total as text for a tile or badge: "10,000+" at a cap, otherwise the full number with the language's separators. */
export function capLabel(count: number, locale: string): string {
  const { capped } = capParams(count);
  return capped !== undefined ? `${capped.toLocaleString(locale)}+` : count.toLocaleString(locale);
}
