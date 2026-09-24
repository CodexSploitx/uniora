const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";

/** Postgres error code 23505 ("unique_violation"). */
export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as { code?: unknown }).code === UNIQUE_VIOLATION;
}

/** Postgres error code 23503 ("foreign_key_violation"). */
export function isForeignKeyViolation(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as { code?: unknown }).code === FOREIGN_KEY_VIOLATION;
}

/**
 * The name of the constraint a `23505` (unique) or `23503` (foreign key)
 * violation hit (e.g. `"organizations_slug_key"`, `"features_key_fkey"`),
 * so callers can tell which of several constraints on the same table —
 * possibly of the same kind, e.g. a table with two FKs — was actually
 * violated instead of guessing from context. `undefined` when `error`
 * isn't one of these two violation types, or the driver didn't populate
 * it.
 */
export function violatedConstraint(error: unknown): string | undefined {
  if (!isUniqueViolation(error) && !isForeignKeyViolation(error)) return undefined;
  const constraint = (error as { constraint?: unknown }).constraint;
  return typeof constraint === "string" ? constraint : undefined;
}
