import "server-only";
import { Pool } from "pg";
import type { UnioraStorage } from "@uniora/core";
import { createPostgresStorage } from "@uniora/postgres";
import { getStudioEnv } from "@/lib/env";

const globalForStudio = globalThis as unknown as {
  __unioraStudioPool?: Pool;
  __unioraStudioStorage?: UnioraStorage;
};

export function getPool(): Pool {
  if (!globalForStudio.__unioraStudioPool) {
    globalForStudio.__unioraStudioPool = new Pool({ connectionString: getStudioEnv().databaseUrl, max: 5 });
  }
  return globalForStudio.__unioraStudioPool;
}

export function getStorage(): UnioraStorage {
  if (!globalForStudio.__unioraStudioStorage) {
    globalForStudio.__unioraStudioStorage = createPostgresStorage(getPool());
  }
  return globalForStudio.__unioraStudioStorage;
}
