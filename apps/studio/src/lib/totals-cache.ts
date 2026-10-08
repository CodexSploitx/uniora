import "server-only";

/**
 * Totals of whole tables ("members in the database") are the one number a large database cannot answer in a few
 * milliseconds: counting five million rows is hundreds of milliseconds even with the best index. They change slowly, so
 * Studio keeps each for a short time and refreshes it in the background: a request is answered from the last value (stale
 * values are at most `ttlMs` old), only the very first one waits, and concurrent requests share one query. Studio's own
 * writes clear the cache, so what the operator just did shows at once.
 */
interface Entry {
  value?: unknown;
  /** When the value was loaded; absent until the first load finishes. */
  at?: number;
  loading?: Promise<unknown>;
}

const globalForCache = globalThis as unknown as { __unioraStudioTotals?: Map<string, Entry> };
const entries = (globalForCache.__unioraStudioTotals ??= new Map<string, Entry>());

export async function cachedTotal<T>(key: string, ttlMs: number, load: () => Promise<T>, now: () => number = Date.now): Promise<T> {
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

  if (current.at === undefined) return (await refresh()) as T;
  if (now() - current.at >= ttlMs) refresh().catch(() => undefined);
  return current.value as T;
}

/** Forgets every cached total (called after Studio writes something). */
export function clearCachedTotals(): void {
  entries.clear();
}
