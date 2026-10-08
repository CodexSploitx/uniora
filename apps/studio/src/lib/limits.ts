/**
 * How far Studio counts. Totals next to a list are "at least this many" past the cap, so a table of millions of rows
 * costs one page of work, never a full count. Everything is paged with keyset cursors; nothing loads "all of" anything.
 */
export const TOTAL_CAP = 10_000;

/**
 * Translator parameters for a total: the number picks the plural. A count that stopped at the cap reads "10,000+"; an exact
 * total above it (the cached whole-table totals) is shown in full, with thousands separators.
 */
export function capParams(count: number): { count: number; countLabel: string } {
  return { count, countLabel: count === TOTAL_CAP ? `${TOTAL_CAP.toLocaleString("en-US")}+` : count.toLocaleString("en-US") };
}
