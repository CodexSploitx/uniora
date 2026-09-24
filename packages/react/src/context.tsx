"use client";

import { createContext, useContext } from "react";
import type { ReactNode } from "react";
import type { AuthorizationSnapshot } from "@uniora/core";

const UnioraContext = createContext<AuthorizationSnapshot | null>(null);

export interface UnioraProviderProps {
  /**
   * A snapshot computed server-side by `computeAuthorizationSnapshot`
   * (`@uniora/core`) — never computed in the browser. See `useCan`/
   * `useFeature` for what happens when a key was never requested there.
   */
  snapshot: AuthorizationSnapshot;
  children: ReactNode;
}

/** Makes a server-computed `AuthorizationSnapshot` available to `useCan`/`useFeature`/`<Can>`/`<Feature>` in the tree below it. */
export function UnioraProvider({ snapshot, children }: UnioraProviderProps) {
  return <UnioraContext.Provider value={snapshot}>{children}</UnioraContext.Provider>;
}

/** The raw snapshot, or `null` outside a `UnioraProvider`. Prefer `useCan`/`useFeature` for a single check. */
export function useUnioraSnapshot(): AuthorizationSnapshot | null {
  return useContext(UnioraContext);
}
