import { PermissionError } from "./repository.js";
import type { Permission } from "./types.js";

/** The most permissions one permission may imply directly. */
export const MAX_IMPLIED_PERMISSIONS = 20;
/** The longest chain of implications (`a` implies `b` implies `c` is 3 levels). Keeps resolution, and the SQL, bounded. */
export const MAX_IMPLICATION_DEPTH = 8;
export const MAX_PERMISSION_GROUP_LENGTH = 100;

/** Trims the group; empty means none (`permission_group_invalid` when it is too long or not text). */
export function sanitizePermissionGroup(group: string | undefined): string | undefined {
  if (group === undefined) return undefined;
  if (typeof group !== "string") throw new PermissionError("The permission group must be text.", "permission_group_invalid");
  const trimmed = group.trim().replace(/\s+/g, " ");
  if (trimmed === "") return undefined;
  if (trimmed.length > MAX_PERMISSION_GROUP_LENGTH) {
    throw new PermissionError(`The permission group cannot exceed ${MAX_PERMISSION_GROUP_LENGTH} characters.`, "permission_group_invalid");
  }
  return trimmed;
}

/** Deduplicated, sorted implication list (`permission_implication_invalid` for non-text or too many). */
export function sanitizeImplies(implies: string[] | undefined): string[] {
  if (implies === undefined) return [];
  if (!Array.isArray(implies) || implies.some((key) => typeof key !== "string")) {
    throw new PermissionError("`implies` must be a list of permission keys.", "permission_implication_invalid");
  }
  const unique = [...new Set(implies)].sort();
  if (unique.length > MAX_IMPLIED_PERMISSIONS) {
    throw new PermissionError(`A permission can imply at most ${MAX_IMPLIED_PERMISSIONS} others.`, "permission_implication_invalid");
  }
  return unique;
}

/**
 * Checks that registering `key` with `implies` keeps the catalog sound: every implied key is registered, none is `key`
 * itself, no cycle is closed, and no chain gets longer than `MAX_IMPLICATION_DEPTH`. `graph` maps each registered key
 * to the keys it implies today (the entry for `key` itself is ignored: it is being replaced).
 */
export function assertValidImplications(graph: ReadonlyMap<string, readonly string[]>, key: string, implies: readonly string[]): void {
  for (const implied of implies) {
    if (implied === key) throw new PermissionError(`Permission "${key}" cannot imply itself.`, "permission_implication_invalid");
    if (!graph.has(implied)) {
      throw new PermissionError(`Permission "${implied}" is not registered. Register it before the permissions that imply it.`, "permission_implication_invalid");
    }
  }
  const next = (current: string): readonly string[] => (current === key ? implies : (graph.get(current) ?? []));
  // Cycle: `key` must not be reachable from what it implies.
  const seen = new Set<string>();
  const stack = [...implies];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === key) throw new PermissionError(`Registering "${key}" with these implications would create a cycle.`, "permission_implication_invalid");
    if (seen.has(current)) continue;
    seen.add(current);
    stack.push(...next(current));
  }
  // Depth: the longest chain through `key` (what implies it, `key`, what it implies) stays within the limit.
  const down = (current: string, visiting: Set<string>): number => {
    let deepest = 0;
    for (const child of next(current)) if (!visiting.has(child)) deepest = Math.max(deepest, 1 + down(child, new Set([...visiting, child])));
    return deepest;
  };
  const up = (current: string, visiting: Set<string>): number => {
    let deepest = 0;
    for (const [parent, children] of graph) {
      if (parent !== key && children.includes(current) && !visiting.has(parent)) {
        deepest = Math.max(deepest, 1 + up(parent, new Set([...visiting, parent])));
      }
    }
    return deepest;
  };
  if (up(key, new Set([key])) + 1 + down(key, new Set([key])) > MAX_IMPLICATION_DEPTH + 1) {
    throw new PermissionError(`Implications can be chained at most ${MAX_IMPLICATION_DEPTH} levels deep.`, "permission_implication_invalid");
  }
}

/** Everything that implies `key`, transitively (not `key`), sorted — from a graph of key -> implied keys. */
export function impliedByClosure(graph: ReadonlyMap<string, readonly string[]>, key: string): string[] {
  const found = new Set<string>();
  const stack = [key];
  while (stack.length > 0) {
    const target = stack.pop()!;
    for (const [parent, children] of graph) {
      if (children.includes(target) && parent !== key && !found.has(parent)) {
        found.add(parent);
        stack.push(parent);
      }
    }
  }
  return [...found].sort();
}

/** `keys` plus everything they imply, transitively, sorted. */
export function expandClosure(graph: ReadonlyMap<string, readonly string[]>, keys: readonly string[]): string[] {
  const found = new Set<string>(keys);
  const stack = [...keys];
  while (stack.length > 0) {
    for (const child of graph.get(stack.pop()!) ?? []) {
      if (!found.has(child)) {
        found.add(child);
        stack.push(child);
      }
    }
  }
  return [...found].sort();
}

/** Builds the key -> implied keys graph of a catalog. */
export function implicationGraph(catalog: Iterable<Pick<Permission, "key" | "implies">>): Map<string, string[]> {
  return new Map([...catalog].map((permission) => [permission.key, [...(permission.implies ?? [])]]));
}
