/** Escapes LIKE wildcards (`%`, `_`) and the escape character itself so a search term is matched literally. */
export function toLikePattern(query: string): string {
  return `%${query.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

const MAX_CACHED_PATTERNS = 256;
const compiled = new Map<string, RegExp>();

function escapeRegExp(char: string): string {
  return char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Translates a LIKE pattern (`%`, `_`, `\` escape) to an anchored, case-insensitive, Unicode-aware RegExp. */
function likeToRegExp(pattern: string): RegExp {
  const cached = compiled.get(pattern);
  if (cached) return cached;

  const chars = Array.from(pattern);
  let source = "^";
  for (let index = 0; index < chars.length; index++) {
    const char = chars[index]!;
    if (char === "\\" && index + 1 < chars.length) {
      source += escapeRegExp(chars[++index]!);
    } else if (char === "%") {
      source += "[\\s\\S]*";
    } else if (char === "_") {
      source += "[\\s\\S]";
    } else {
      source += escapeRegExp(char);
    }
  }
  const regexp = new RegExp(`${source}$`, "iu");

  if (compiled.size >= MAX_CACHED_PATTERNS) compiled.clear();
  compiled.set(pattern, regexp);
  return regexp;
}

/**
 * Registered as the SQL function `uniora_ilike(value, pattern)`: Postgres'
 * `ILIKE` semantics. SQLite's own `LIKE` only folds ASCII case, so a search
 * for "ñu" would miss "Ñu" — this one folds Unicode too. `NULL` never matches,
 * same as `NULL ILIKE ...` being NULL (falsy) in Postgres.
 */
export function unioraIlike(value: unknown, pattern: unknown): number {
  if (typeof value !== "string" || typeof pattern !== "string") return 0;
  return likeToRegExp(pattern).test(value) ? 1 : 0;
}
