/** Escapes ILIKE wildcards (`%`, `_`) and the escape character itself so a search term is matched literally. */
export function toLikePattern(query: string): string {
  return `%${query.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}
