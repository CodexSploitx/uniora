import { AsyncLocalStorage } from "node:async_hooks";
import type { Database, Statement } from "better-sqlite3";
import { unioraIlike } from "./like.js";

export interface QueryResult<R> {
  readonly rows: R[];
  /** Rows returned for a statement that returns rows, rows changed otherwise. */
  readonly rowCount: number;
}

/**
 * What every repository needs from the connection. Deliberately the same
 * shape `@uniora/postgres` uses (`query(text, params)` resolving to
 * `{ rows, rowCount }`) so the two adapters' repositories read side by side.
 */
export interface SqliteExecutor {
  query<R = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<QueryResult<R>>;
  /**
   * Runs `fn` as ONE all-or-nothing unit that no other operation on this
   * connection can interleave with. Re-entrant: inside an already-open
   * `atomic`/transaction it simply joins it. Every read-check-write
   * sequence whose correctness depends on nothing changing in between (the
   * last-Owner guard, identity linking, ...) must run in here.
   */
  atomic<T>(fn: () => Promise<T>): Promise<T>;
}

/** Minimum SQLite for `RETURNING` (3.35), window functions, row values and `ORDER BY` inside aggregates (3.44). */
const MINIMUM_SQLITE_VERSION = [3, 44, 0] as const;

function versionAtLeast(version: string, minimum: readonly number[]): boolean {
  const parts = version.split(".").map(Number);
  for (let index = 0; index < minimum.length; index++) {
    const have = parts[index] ?? 0;
    const need = minimum[index]!;
    if (have !== need) return have > need;
  }
  return true;
}

const executors = new WeakMap<Database, SqliteExecutor>();

/**
 * The executor for a connection — ONE per connection, however many storages
 * are built over it: the serialization queue below is what keeps callers from
 * interleaving statements inside each other's transaction, so two storages
 * sharing a connection must share it too.
 */
export function createExecutor(db: Database): SqliteExecutor {
  let executor = executors.get(db);
  if (!executor) {
    executor = buildExecutor(db);
    executors.set(db, executor);
  }
  return executor;
}

/**
 * Prepares a connection for UNIORA and returns an executor over it. Fails
 * loudly (instead of silently weakening a guarantee) if the connection can't
 * enforce what UNIORA relies on.
 */
function buildExecutor(db: Database): SqliteExecutor {
  const { version } = db.prepare("select sqlite_version() as version").get() as { version: string };
  if (!versionAtLeast(version, MINIMUM_SQLITE_VERSION)) {
    throw new Error(
      `@uniora/sqlite needs SQLite ${MINIMUM_SQLITE_VERSION.join(".")} or newer (this connection runs ${version}).`,
    );
  }

  // Foreign keys are OFF by default in SQLite, per connection — and the
  // organization/role/permission integrity (cascades, "feature must be
  // registered", ...) lives in them. A no-op inside a transaction, hence the
  // verification below instead of trusting the pragma blindly.
  db.pragma("foreign_keys = ON");
  if (db.pragma("foreign_keys", { simple: true }) !== 1) {
    throw new Error(
      "@uniora/sqlite could not enable `pragma foreign_keys` on this connection (is a transaction already open?). " +
        "Refusing to run without foreign-key enforcement.",
    );
  }

  db.function("uniora_ilike", { deterministic: true }, (value, pattern) => unioraIlike(value, pattern));

  const statements = new Map<string, Statement>();
  const MAX_STATEMENTS = 256;

  function prepare(sql: string): Statement {
    let statement = statements.get(sql);
    if (!statement) {
      if (statements.size >= MAX_STATEMENTS) statements.clear();
      statement = db.prepare(sql);
      statements.set(sql, statement);
    }
    return statement;
  }

  function toSqliteValue(value: unknown): unknown {
    if (value === undefined) return null;
    if (typeof value === "boolean") return value ? 1 : 0;
    if (value instanceof Date) return value.toISOString();
    return value;
  }

  // better-sqlite3 binds an ARRAY to anonymous `?` parameters only; the
  // numbered `?1`, `?2` form this package's SQL uses (a value referenced in
  // several places is bound once) is bound through an object keyed by number.
  function bind(params: readonly unknown[]): Record<string, unknown> {
    const bound: Record<string, unknown> = {};
    params.forEach((value, index) => {
      bound[index + 1] = toSqliteValue(value);
    });
    return bound;
  }

  function run<R>(sql: string, params: readonly unknown[]): QueryResult<R> {
    const statement = prepare(sql);
    const bound = bind(params);
    if (statement.reader) {
      const rows = (params.length > 0 ? statement.all(bound) : statement.all()) as R[];
      return { rows, rowCount: rows.length };
    }
    const info = params.length > 0 ? statement.run(bound) : statement.run();
    return { rows: [], rowCount: info.changes };
  }

  // One logical connection, many concurrent callers: every operation takes
  // this queue, so two `await`-separated statements of different callers can
  // never interleave inside one transaction (they would silently share it).
  let tail: Promise<unknown> = Promise.resolve();
  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = tail.then(task);
    tail = result.catch(() => undefined);
    return result;
  }

  // Marks the async call chain that currently owns the queue, so work it
  // starts (a repository calling another, a callback inside `transaction()`)
  // joins instead of waiting on itself forever. `active` is flipped off when
  // the owner finishes, so a continuation that outlives it (a forgotten,
  // un-awaited promise) falls back to waiting its turn like anyone else.
  const owner = new AsyncLocalStorage<{ active: boolean }>();
  let savepointCounter = 0;

  function exclusive<T>(task: () => Promise<T>): Promise<T> {
    if (owner.getStore()?.active) return task();
    return enqueue(async () => {
      const context = { active: true };
      try {
        return await owner.run(context, task);
      } finally {
        context.active = false;
      }
    });
  }

  return {
    query<R>(sql: string, params: readonly unknown[] = []) {
      return exclusive(async () => run<R>(sql, params));
    },

    atomic<T>(fn: () => Promise<T>) {
      return exclusive(async () => {
        // Already inside a transaction (an outer `atomic`, or the caller's
        // own `storage.transaction()`): join it, under a savepoint so that
        // THIS operation is still all-or-nothing — if it fails halfway, only
        // its own writes are undone and the caller's transaction carries on.
        if (db.inTransaction) {
          const savepoint = `uniora_sp_${++savepointCounter}`;
          db.exec(`savepoint ${savepoint}`);
          try {
            const result = await fn();
            db.exec(`release ${savepoint}`);
            return result;
          } catch (error) {
            db.exec(`rollback to ${savepoint}`);
            db.exec(`release ${savepoint}`);
            throw error;
          }
        }

        // IMMEDIATE takes SQLite's write lock up front, so the reads that
        // precede a write can't go stale under another process: the
        // writer-vs-writer serialization Postgres gets from SERIALIZABLE
        // isolation + `FOR UPDATE`, here by construction.
        db.exec("begin immediate");
        try {
          const result = await fn();
          db.exec("commit");
          return result;
        } catch (error) {
          try {
            db.exec("rollback");
          } catch {
            // The failure that matters is the original one.
          }
          throw error;
        }
      });
    },
  };
}
