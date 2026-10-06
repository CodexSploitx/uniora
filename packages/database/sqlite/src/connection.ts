import { createRequire } from "node:module";
import { isAbsolute, resolve } from "node:path";
import type { Database } from "better-sqlite3";

const URL_PREFIX = "sqlite:";

/** A `sqlite:` URL (or path) UNIORA can't turn into exactly one database file. */
export class SqliteUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SqliteUrlError";
  }
}

/**
 * The database file a `sqlite:` URL points to, as an absolute path.
 *
 * Accepted forms (same spirit as a Postgres connection string, so the CLI's
 * `database.url` and Studio's launch environment work for both providers):
 *   - `sqlite:./data/app.db`     relative to `cwd` (the project directory)
 *   - `sqlite:/var/lib/app.db`   absolute
 *   - `sqlite:///var/lib/app.db` absolute, URL style (`sqlite:///C:/x/app.db` on Windows)
 *
 * Refused on purpose, because each would silently NOT be the file the person
 * meant: an empty path, `:memory:` (a database that evaporates when the
 * command exits — `migrate` would "succeed" into nothing), a `sqlite://host/…`
 * authority, and `?query`/`#fragment` suffixes (they'd become part of the
 * filename).
 */
export function sqlitePathFromUrl(url: string, cwd: string = process.cwd()): string {
  if (!url.startsWith(URL_PREFIX)) {
    throw new SqliteUrlError(`Una URL de SQLite debe empezar por "sqlite:" (p. ej. sqlite:./uniora.db).`);
  }

  let path = url.slice(URL_PREFIX.length);
  if (path.startsWith("//")) {
    path = path.slice(2);
    if (path.length > 0 && !path.startsWith("/")) {
      throw new SqliteUrlError(
        `La URL de SQLite no admite un host ("sqlite://${path.split("/")[0]}/…"). Usa "sqlite:///ruta/absoluta.db" o "sqlite:./relativa.db".`,
      );
    }
    // `sqlite:///C:/data/app.db` → `C:/data/app.db`
    if (/^\/[A-Za-z]:[\\/]/.test(path)) path = path.slice(1);
  }

  if (path === "" || /[\\/]$/.test(path)) {
    throw new SqliteUrlError("La URL de SQLite no indica ningún archivo (termina en un directorio o está vacía).");
  }
  if (path === ":memory:" || path.startsWith("file::memory:")) {
    throw new SqliteUrlError(
      'Una base SQLite en memoria no sirve aquí: desaparece al terminar el comando. Indica un archivo (p. ej. "sqlite:./uniora.db").',
    );
  }
  if (/[?#]/.test(path)) {
    throw new SqliteUrlError('La URL de SQLite no admite "?" ni "#": serían parte del nombre del archivo.');
  }

  return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}

export interface OpenSqliteOptions {
  /**
   * Fail instead of creating the file when it doesn't exist. Read-only
   * commands (`check`, `doctor`, `migrate --status`) must never leave a stray
   * empty database behind just because they looked.
   */
  readonly fileMustExist?: boolean;
  /** Open read-only: even a bug can't write. Incompatible with `wal`. */
  readonly readonly?: boolean;
  /**
   * Switch the file to `journal_mode = WAL` (readers don't block the writer, a
   * crash can't leave a half-written page). It is PERSISTENT in the file, so it
   * is opt-in: opening a database must not silently change one you didn't
   * create — only the code that owns the file (`uniora migrate`) asks for it.
   */
  readonly wal?: boolean;
}

const require = createRequire(import.meta.url);

/**
 * Opens a database file, loading `better-sqlite3` only now (it is a native
 * module: importing `@uniora/sqlite` alone — e.g. from the CLI while talking to
 * Postgres — never touches it). Synchronous, like the driver itself.
 *
 * Foreign keys and the busy timeout are NOT set here: `createSqliteStorage`
 * enforces foreign keys on every connection it is given, and better-sqlite3
 * already waits 5 s on a locked file.
 */
export function openSqliteDatabase(path: string, options: OpenSqliteOptions = {}): Database {
  if (options.wal === true && options.readonly === true) {
    throw new Error("openSqliteDatabase: `wal` needs a writable connection (it conflicts with `readonly`).");
  }

  let Driver: typeof import("better-sqlite3");
  try {
    Driver = require("better-sqlite3") as typeof import("better-sqlite3");
  } catch (error) {
    throw new Error(
      `No se pudo cargar better-sqlite3 (${error instanceof Error ? error.message : String(error)}). ` +
        "Instálalo junto a @uniora/sqlite: npm install better-sqlite3.",
    );
  }

  const db = new Driver(path, { fileMustExist: options.fileMustExist === true, readonly: options.readonly === true });
  if (options.wal === true) {
    try {
      db.pragma("journal_mode = WAL");
    } catch (error) {
      db.close();
      throw error;
    }
  }
  return db;
}

/** Whether UNIORA's tables exist (Studio's "run `uniora migrate` first" gate). Read-only, never creates anything. */
export function hasUnioraSchema(db: Database): boolean {
  return db.prepare("select 1 from sqlite_master where type = 'table' and name = 'uniora_organizations'").get() !== undefined;
}
