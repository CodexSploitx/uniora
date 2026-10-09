import type { SqliteExecutor } from "./executor.js";

/** Queries shorter than this cannot use a trigram index. */
const MIN_INDEXED_LENGTH = 3;
/** Candidates beyond this make the index pointless (the term is too common to narrow anything): scan in order instead. */
const MAX_CANDIDATES = 10_000;

const available = new WeakMap<SqliteExecutor, Map<string, Promise<boolean>>>();

/** Whether `table` (a trigram index from migration 0024) exists. A database not yet migrated simply searches the slow way. */
function hasIndex(db: SqliteExecutor, table: string): Promise<boolean> {
  let known = available.get(db);
  if (!known) available.set(db, (known = new Map()));
  let answer = known.get(table);
  if (!answer) {
    answer = db
      .query("select 1 from sqlite_master where type = 'table' and name = ?1", [table])
      .then((result) => result.rows.length > 0);
    known.set(table, answer);
    void answer.then((exists) => {
      if (!exists) known!.delete(table);
    });
  }
  return answer;
}

/**
 * Row ids that can match a "contains" search, as a JSON array for `rowid in (select value from json_each(?))`, or
 * `null` when the index cannot narrow it (query shorter than three characters, not plain ASCII, no index, or so many
 * candidates that scanning in order finds a page sooner). `null` means "apply only the exact predicate", which is
 * always correct; the candidates are a prefilter, and the caller keeps re-checking each row with the exact predicate.
 *
 * ASCII only because the index folds case its own way for other scripts; the exact predicate stays the authority.
 */
export async function searchCandidates(db: SqliteExecutor, indexTable: string, query: string | undefined): Promise<string | null> {
  const text = query?.trim();
  if (!text || text.length < MIN_INDEXED_LENGTH || !/^[\x20-\x7e]+$/.test(text)) return null;
  if (!(await hasIndex(db, indexTable))) return null;
  const phrase = `"${text.replace(/"/g, '""')}"`;
  const result = await db.query<{ rowid: number }>(
    `select rowid from ${indexTable} where ${indexTable} match ?1 limit ${MAX_CANDIDATES + 1}`,
    [phrase],
  );
  if (result.rows.length > MAX_CANDIDATES) return null;
  return JSON.stringify(result.rows.map((row) => row.rowid));
}
