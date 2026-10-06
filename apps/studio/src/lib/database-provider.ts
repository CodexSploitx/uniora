/**
 * Which database engine Studio was launched against. Pure (no `server-only`)
 * so it can be unit-tested and reused by server components for the badge.
 */
export type DatabaseProvider = "postgresql" | "sqlite";

const LABELS: Record<DatabaseProvider, string> = { postgresql: "PostgreSQL", sqlite: "SQLite" };

/**
 * Reads `UNIORA_STUDIO_DATABASE_PROVIDER`. Absent means `postgresql`: that is
 * what every CLI released before SQLite support launched Studio for. Anything
 * else that isn't a known provider is an error — never guessed, since guessing
 * wrong would hand a SQLite path to the Postgres driver (or the reverse).
 */
export function parseDatabaseProvider(value: string | undefined): DatabaseProvider {
  if (value === undefined || value === "") return "postgresql";
  if (value === "postgresql" || value === "sqlite") return value;
  throw new Error(`Unsupported UNIORA_STUDIO_DATABASE_PROVIDER "${value}". Launch Studio with \`npx uniora studio\`.`);
}

export function databaseProviderLabel(provider: DatabaseProvider): string {
  return LABELS[provider];
}
