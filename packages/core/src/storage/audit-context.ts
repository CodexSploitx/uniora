import { plainRepo } from "../access/guard.js";
import type { AnyRepo } from "../access/guard.js";
import type { UnioraStorage, UnioraTransaction } from "./types.js";

/**
 * Stamps every audit entry written through `storage` (directly or inside a transaction) with `metadata.via = via`, in the same
 * transaction as the change, so it lives inside the hash chain like the rest of the entry.
 *
 * It is for a layer that acts on behalf of someone else and must say so in a way the person it speaks for cannot touch: the API
 * server records `{ apiClientId, keyId, requestId }` here, so an entry whose `actor` is an end user also says which API client
 * relayed it. `via` is reserved: whatever an operation put under that key is replaced, never merged, so nothing that comes
 * from a request can forge it.
 */
export function createAuditContextStorage(storage: UnioraStorage, via: Readonly<Record<string, unknown>>): UnioraStorage {
  const stamped = Object.freeze({ ...via });

  function stampScope<T extends UnioraStorage | UnioraTransaction>(scope: T): T {
    const logs = plainRepo(scope.auditLogs as unknown as AnyRepo);
    const record = scope.auditLogs.record.bind(scope.auditLogs);
    logs.record = ((input: Parameters<typeof record>[0]) => record({ ...input, metadata: { ...input.metadata, via: stamped } })) as AnyRepo[string];
    return { ...plainRepo(scope as unknown as AnyRepo), auditLogs: logs } as unknown as T;
  }

  return {
    ...stampScope(storage),
    transaction: <T>(callback: (tx: UnioraTransaction) => Promise<T>) => storage.transaction((tx) => callback(stampScope(tx))),
  } as UnioraStorage;
}
