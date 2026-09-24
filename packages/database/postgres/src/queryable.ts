import type { QueryResult, QueryResultRow } from "pg";

/**
 * The subset of the `pg` API repositories need. Implemented by both
 * `Pool` and `PoolClient`, so the same repository code runs whether it
 * is bound to the pool or to a client inside a transaction.
 */
export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]): Promise<QueryResult<R>>;
}
