/**
 * better-sqlite3 surfaces constraint failures as `SqliteError`s whose `code`
 * names the *kind* (`SQLITE_CONSTRAINT_UNIQUE`, `..._PRIMARYKEY`, ...) but,
 * unlike Postgres, never the constraint's name — only the columns involved,
 * inside the message (`UNIQUE constraint failed: uniora_roles.organization_id,
 * uniora_roles.key`). Repositories tell two unique constraints on the same
 * table apart by those columns.
 */
function codeOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/** A primary-key or unique-index violation (`UNIQUE constraint failed`). */
export function isUniqueViolation(error: unknown): boolean {
  const code = codeOf(error);
  return code === "SQLITE_CONSTRAINT_UNIQUE" || code === "SQLITE_CONSTRAINT_PRIMARYKEY";
}

/** A foreign-key violation (only raised with `pragma foreign_keys = on`). */
export function isForeignKeyViolation(error: unknown): boolean {
  return codeOf(error) === "SQLITE_CONSTRAINT_FOREIGNKEY";
}

/**
 * The columns a unique violation hit, as `table.column` strings in index
 * order (e.g. `["uniora_roles.id"]` for the primary key). Empty when `error`
 * isn't a unique violation or the driver's message has an unexpected shape —
 * callers then fall through to their generic message, never a wrong one.
 */
export function violatedColumns(error: unknown): string[] {
  if (!isUniqueViolation(error)) return [];
  const message = (error as { message?: unknown }).message;
  if (typeof message !== "string") return [];
  const match = /^UNIQUE constraint failed: (.+)$/.exec(message);
  if (!match) return [];
  return match[1]!.split(",").map((column) => column.trim());
}

/** Whether a unique violation hit exactly these columns (order-insensitive). */
export function violatedExactly(error: unknown, columns: readonly string[]): boolean {
  const violated = violatedColumns(error);
  return violated.length === columns.length && columns.every((column) => violated.includes(column));
}
