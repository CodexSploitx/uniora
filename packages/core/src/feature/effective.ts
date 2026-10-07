import { FeatureError } from "./repository.js";
import type { EffectiveFeature, Feature, FeatureDefinition } from "./types.js";

/** The deepest parent chain a feature may have. Keeps resolution (and the SQL helpers) bounded. */
export const MAX_FEATURE_DEPTH = 8;

/** `key` followed by its ancestors, nearest first. Stops at an unknown parent or after `MAX_FEATURE_DEPTH + 1` keys. */
export function featureChain(definitions: ReadonlyMap<string, FeatureDefinition>, key: string): string[] {
  const chain: string[] = [];
  let current: string | undefined = key;
  while (current !== undefined && chain.length <= MAX_FEATURE_DEPTH && definitions.has(current) && !chain.includes(current)) {
    chain.push(current);
    current = definitions.get(current)!.parentKey;
  }
  return chain;
}

/**
 * Resolves every feature of the catalog for ONE organization from its definitions and overrides — the
 * single definition of "effective" that the in-memory backend uses directly and the SQL backends use
 * for every per-organization read, so the rule (own state, then parents) cannot drift between them.
 *
 * Own state: the override if there is one, else `defaultEnabled`. A feature is effectively on only
 * when its own state AND every ancestor's own state are on. An unknown parent is treated as off
 * (fail-closed), like any unknown feature.
 */
export function resolveEffectiveFeatures(
  definitions: readonly FeatureDefinition[],
  overrides: readonly Feature[],
): EffectiveFeature[] {
  const byKey = new Map(definitions.map((definition) => [definition.key, definition]));
  const overrideByKey = new Map(overrides.map((row) => [row.key, row]));

  const ownState = (definition: FeatureDefinition): boolean => overrideByKey.get(definition.key)?.enabled ?? definition.defaultEnabled;

  return definitions.map((definition): EffectiveFeature => {
    const row = overrideByKey.get(definition.key);
    const own = ownState(definition);
    const base = {
      key: definition.key,
      defaultEnabled: definition.defaultEnabled,
      ...(definition.parentKey !== undefined ? { parentKey: definition.parentKey } : {}),
      ...(row
        ? { override: { enabled: row.enabled, updatedAt: row.updatedAt, updatedBy: row.updatedBy, reason: row.reason } }
        : {}),
    };

    if (!own) return { ...base, enabled: false, reason: row ? "disabled" : "default" };

    let blockedBy: string | undefined;
    let parentKey = definition.parentKey;
    for (let depth = 0; parentKey !== undefined; depth++) {
      const parent = byKey.get(parentKey);
      // An unknown parent or an over-deep/cyclic chain blocks: fail closed.
      if (!parent || depth >= MAX_FEATURE_DEPTH) {
        blockedBy = parentKey;
        break;
      }
      if (!ownState(parent)) {
        blockedBy = parent.key;
        break;
      }
      parentKey = parent.parentKey;
    }
    if (blockedBy !== undefined) return { ...base, enabled: false, reason: "parent_disabled", blockedBy };
    return { ...base, enabled: true, reason: row ? "enabled" : "default" };
  });
}

/**
 * Keys that must carry an explicit "on" override for `key` to be effectively on — those in its chain whose default
 * is off — and all chain keys (any explicit "off" among them blocks it). Feeds the cross-organization SQL.
 */
export function featureRequirements(
  definitions: ReadonlyMap<string, FeatureDefinition>,
  key: string,
): { chain: string[]; requiredOn: string[]; complete: boolean } {
  const chain = featureChain(definitions, key);
  const last = definitions.get(chain[chain.length - 1] ?? "");
  // `complete` is false when the chain ended on an unknown parent / too-deep chain: nothing is effectively on.
  const complete = chain.length > 0 && chain.length <= MAX_FEATURE_DEPTH + 1 && (last?.parentKey === undefined);
  return { chain, requiredOn: chain.filter((k) => !definitions.get(k)!.defaultEnabled), complete };
}

/**
 * Checks that `key` may be registered with `parentKey` given the current catalog: the parent exists, is not the
 * feature itself, does not close a cycle, and the resulting tree stays within `MAX_FEATURE_DEPTH` levels in total
 * (counting the features hanging under `key`). Throws `FeatureError` (`feature_parent_invalid`).
 */
export function assertValidFeatureParent(
  definitions: ReadonlyMap<string, FeatureDefinition>,
  key: string,
  parentKey: string | undefined,
): void {
  if (parentKey === undefined) return;
  if (parentKey === key) throw new FeatureError(`Feature "${key}" cannot be its own parent.`, "feature_parent_invalid");
  if (!definitions.has(parentKey)) {
    throw new FeatureError(`Parent feature "${parentKey}" is not registered. Register it first.`, "feature_parent_invalid");
  }
  const parentChain = featureChain(definitions, parentKey);
  if (parentChain.includes(key)) {
    throw new FeatureError(`Making "${parentKey}" the parent of "${key}" would create a cycle.`, "feature_parent_invalid");
  }
  const height = (current: string, seen: Set<string>): number => {
    let deepest = 0;
    for (const child of definitions.values()) {
      if (child.parentKey === current && !seen.has(child.key)) deepest = Math.max(deepest, 1 + height(child.key, new Set([...seen, child.key])));
    }
    return deepest;
  };
  if (parentChain.length + 1 + height(key, new Set([key])) > MAX_FEATURE_DEPTH) {
    throw new FeatureError(`Features can be nested at most ${MAX_FEATURE_DEPTH} levels deep.`, "feature_parent_invalid");
  }
}
