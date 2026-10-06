/** A list of ids/keys as ONE bound parameter, expanded in SQL with `in (select value from json_each(?n))`. */
export function jsonList(values: readonly string[]): string {
  return JSON.stringify(values);
}

/** Parses a JSON array column/aggregate produced by `json_group_array`. */
export function parseList(value: unknown): string[] {
  return typeof value === "string" ? (JSON.parse(value) as string[]) : [];
}
