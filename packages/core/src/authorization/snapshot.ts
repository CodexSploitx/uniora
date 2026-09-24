import type { Identity } from "../identity/types.js";
import type { FeatureRepository } from "../feature/repository.js";
import type { AuthorizationEngine } from "./engine.js";

export interface ComputeAuthorizationSnapshotInput {
  identity: Identity;
  organizationId: string;
  /** Permission keys to resolve. Omit or leave empty if the caller only needs features. */
  permissions?: string[];
  /** Feature keys to resolve. Omit or leave empty if the caller only needs permissions. */
  features?: string[];
}

/**
 * A plain, JSON-serializable snapshot of a bounded set of authorization
 * decisions for one identity in one organization — safe to send to client
 * UI (e.g. `@uniora/react`'s `UnioraProvider`).
 */
export interface AuthorizationSnapshot {
  organizationId: string;
  permissions: Record<string, boolean>;
  features: Record<string, boolean>;
}

/**
 * Resolves `input.permissions`/`input.features` against the real
 * `AuthorizationEngine`/`FeatureRepository` into a snapshot a host app can
 * serialize and send to client-side UI. This is the only supported way to
 * get authorization data into the browser — the snapshot is always
 * computed here, server-side, against real data; a client never computes
 * or requests one directly (docs/PROYECT.md §7 "Server Authority";
 * uniora-security-engineering skill §1.3 "Server Is the Security
 * Boundary", INV-010 "No Security Through UI"). `@uniora/react`'s
 * `<Can>`/`<Feature>` are UX only — they hide/show elements based on this
 * snapshot, they never decide authorization themselves. Every sensitive
 * server operation must still independently authorize the request.
 *
 * Deliberately bounded: the caller must list exactly which
 * `permissions`/`features` the view being rendered needs — this is not
 * "give me everything this identity can do" (which is not even
 * well-defined for an Owner-role membership, since the Owner bypass
 * grants every permission without enumerating a fixed set, see
 * `RoleRepository.createOwnerRole`). Every entry reuses `engine.can()`
 * unchanged (including the Owner bypass, since `can()` already answers
 * correctly for any key), so there is no second authorization
 * implementation to drift out of sync with the real one.
 *
 * A permission/feature key omitted from `input.permissions`/`input.features`
 * is simply absent from the resulting snapshot — a consumer that reads a
 * key it never asked for here must treat it as denied (fail-closed), never
 * as "not yet decided". `@uniora/react`'s `useCan`/`useFeature` do exactly
 * that.
 */
export async function computeAuthorizationSnapshot(
  engine: AuthorizationEngine,
  features: Pick<FeatureRepository, "isEnabled">,
  input: ComputeAuthorizationSnapshotInput,
): Promise<AuthorizationSnapshot> {
  const permissionEntries = await Promise.all(
    (input.permissions ?? []).map(async (permission) => {
      const allowed = await engine.can({
        identity: input.identity,
        organizationId: input.organizationId,
        permission,
      });
      return [permission, allowed] as const;
    }),
  );

  const featureEntries = await Promise.all(
    (input.features ?? []).map(async (key) => {
      const enabled = await features.isEnabled(input.organizationId, key);
      return [key, enabled] as const;
    }),
  );

  return {
    organizationId: input.organizationId,
    permissions: Object.fromEntries(permissionEntries),
    features: Object.fromEntries(featureEntries),
  };
}
