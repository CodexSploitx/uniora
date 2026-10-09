import "server-only";
import { existsSync } from "node:fs";
import { Pool } from "pg";
import type { Database as SqliteDatabase } from "better-sqlite3";
import type { PlatformStorage, UnioraStorage } from "@uniora/core";
import { createPostgresPlatformStorage, createPostgresStorage } from "@uniora/postgres";
import { createSqlitePlatformStorage, createSqliteStorage, hasUnioraSchema, openSqliteDatabase, sqlitePathFromUrl } from "@uniora/sqlite";
import { getStudioEnv } from "@/lib/env";

const globalForStudio = globalThis as unknown as {
  __unioraStudioPool?: Pool;
  __unioraStudioSqlite?: SqliteDatabase;
  __unioraStudioStorage?: UnioraStorage;
  __unioraStudioPlatform?: PlatformStorage;
};

function getPool(): Pool {
  if (!globalForStudio.__unioraStudioPool) {
    globalForStudio.__unioraStudioPool = new Pool({ connectionString: getStudioEnv().databaseUrl, max: 5 });
  }
  return globalForStudio.__unioraStudioPool;
}

/**
 * The SQLite connection, opened on first use. It never creates the file (Studio
 * must not conjure an empty database just because it was opened before `uniora
 * migrate` ran) and never changes its journal mode. In `--read-only` mode the
 * connection itself is read-only, so even a bug in an action couldn't write.
 */
function getSqlite(): SqliteDatabase {
  if (!globalForStudio.__unioraStudioSqlite) {
    const env = getStudioEnv();
    globalForStudio.__unioraStudioSqlite = openSqliteDatabase(sqlitePathFromUrl(env.databaseUrl), {
      fileMustExist: true,
      readonly: env.readOnly,
    });
  }
  return globalForStudio.__unioraStudioSqlite;
}

export function getStorage(): UnioraStorage {
  if (!globalForStudio.__unioraStudioStorage) {
    globalForStudio.__unioraStudioStorage =
      getStudioEnv().databaseProvider === "sqlite" ? createSqliteStorage(getSqlite()) : createPostgresStorage(getPool());
  }
  return globalForStudio.__unioraStudioStorage;
}

/** The platform scope's own storage (separate tables). Studio only reads it: platform changes need platform actors. */
export function getPlatformStorage(): PlatformStorage {
  if (!globalForStudio.__unioraStudioPlatform) {
    globalForStudio.__unioraStudioPlatform =
      getStudioEnv().databaseProvider === "sqlite" ? createSqlitePlatformStorage(getSqlite()) : createPostgresPlatformStorage(getPool());
  }
  return globalForStudio.__unioraStudioPlatform;
}

/**
 * Whether UNIORA's tables exist yet — Studio's "run `npx uniora migrate`
 * first" gate. Read-only for both engines: a missing SQLite file simply answers
 * `false` (it is never created here).
 */
export async function databaseSchemaExists(): Promise<boolean> {
  const env = getStudioEnv();
  if (env.databaseProvider === "sqlite") {
    if (!existsSync(sqlitePathFromUrl(env.databaseUrl))) return false;
    return hasUnioraSchema(getSqlite());
  }
  const result = await getPool().query("select 1 from information_schema.schemata where schema_name = 'uniora'");
  return (result.rowCount ?? 0) > 0;
}
