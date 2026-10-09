import "server-only";

/**
 * Totals of whole tables ("members in the database") are the one number a large database cannot answer in a few
 * milliseconds: counting five million rows is hundreds of milliseconds even with the best index. They change slowly, so
 * Studio keeps each for a short time and refreshes it in the background: a request is answered from the last value (stale
 * values are at most `ttlMs` old) and concurrent requests share one query. The very first request does not wait for the
 * exact number either when the caller gives a cheap `fallback` (a capped count): it answers with that and the exact value
 * is ready for the next one. Studio's own writes expire every value (the stale one is still served while it reloads).
 */
interface Entry {
  value?: unknown;
  /** When the value was loaded; absent until the first load finishes. */
  at?: number;
  loading?: Promise<unknown>;
}

const globalForCache = globalThis as unknown as { __unioraStudioTotals?: Map<string, Entry> };
const entries = (globalForCache.__unioraStudioTotals ??= new Map<string, Entry>());

export async function cachedTotal<T>(
  key: string,
  ttlMs: number,
  load: () => Promise<T>,
  options: { fallback?: () => Promise<T>; now?: () => number } = {},
): Promise<T> {
  const now = options.now ?? Date.now;
  let entry = entries.get(key);
  if (!entry) entries.set(key, (entry = {}));
  const current = entry;

  const refresh = (): Promise<unknown> => {
    current.loading ??= load()
      .then((value) => {
        current.value = value;
        current.at = now();
        return value;
      })
      .finally(() => {
        current.loading = undefined;
      });
    return current.loading;
  };

  if (current.at === undefined) {
    if (!options.fallback) return (await refresh()) as T;
    refresh().catch(() => undefined);
    return options.fallback();
  }
  if (now() - current.at >= ttlMs) refresh().catch(() => undefined);
  return current.value as T;
}

/** Expires every cached total (called after Studio writes something): the old value is served once more while the new one loads. */
export function clearCachedTotals(): void {
  for (const [key, entry] of entries) {
    if (entry.at === undefined && !entry.loading) entries.delete(key);
    else entry.at = Number.NEGATIVE_INFINITY;
  }
}
