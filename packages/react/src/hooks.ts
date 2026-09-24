"use client";

import { useUnioraSnapshot } from "./context.js";

const isDev = typeof process !== "undefined" && process.env?.NODE_ENV !== "production";

function warnIfNeverRequested(kind: "permission" | "feature", key: string, map: Record<string, boolean> | undefined): void {
  if (!isDev || !map) return;
  if (!(key in map)) {
    // eslint-disable-next-line no-console -- intentional dev-only diagnostic, never runs in production
    console.warn(
      `[@uniora/react] use${kind === "permission" ? "Can" : "Feature"}("${key}") was never included when the current AuthorizationSnapshot was computed — denying by default. ` +
        `Did you forget to pass it to computeAuthorizationSnapshot()'s \`${kind === "permission" ? "permissions" : "features"}\` list?`,
    );
  }
}

/**
 * Whether `permission` is granted, per the current `AuthorizationSnapshot`.
 * Fails closed: `false` outside a `UnioraProvider`, and `false` for any
 * `permission` the snapshot never resolved (never silently "not yet
 * known" — see `computeAuthorizationSnapshot` in `@uniora/core`). This is
 * UX only; the server must independently authorize the real operation.
 */
export function useCan(permission: string): boolean {
  const snapshot = useUnioraSnapshot();
  warnIfNeverRequested("permission", permission, snapshot?.permissions);
  return snapshot?.permissions[permission] ?? false;
}

/**
 * Whether `feature` is enabled for the current organization, per the
 * current `AuthorizationSnapshot`. Same fail-closed semantics as `useCan`.
 */
export function useFeature(feature: string): boolean {
  const snapshot = useUnioraSnapshot();
  warnIfNeverRequested("feature", feature, snapshot?.features);
  return snapshot?.features[feature] ?? false;
}
