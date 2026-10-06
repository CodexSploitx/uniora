import type { UnioraDatabaseConfig } from "../config/types.js";
import { createPostgresDriver } from "./postgres.js";
import { createSqliteDriver } from "./sqlite.js";
import type { DatabaseDriver, DatabaseIntent } from "./types.js";

/** El driver de la base que indica `database.provider`. `cwd` resuelve las rutas relativas de SQLite. */
export async function openDriver(
  database: UnioraDatabaseConfig,
  cwd: string,
  intent: DatabaseIntent,
): Promise<DatabaseDriver> {
  switch (database.provider) {
    case "postgresql":
      return createPostgresDriver(database.url);
    case "sqlite":
      return createSqliteDriver(database.url, cwd, intent);
  }
}
