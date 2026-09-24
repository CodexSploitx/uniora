import { cache } from "react";
import { computeAuthorizationSnapshot } from "@uniora/core";
import type {
  AuthorizationEngine,
  AuthorizationSnapshot,
  ComputeAuthorizationSnapshotInput,
  FeatureRepository,
  Identity,
} from "@uniora/core";

/**
 * Binds `computeAuthorizationSnapshot` to a request-scoped `react.cache()`.
 * Inside a real React Server Components render (Next.js App Router), calling
 * the returned function with the same input from multiple Server Components
 * during the same request reuses a single result instead of recomputing it
 * once per component. Outside that context (plain Node, tests), `react.cache`
 * has no dedup effect — it just calls through — so this is glue for a
 * Next.js render, not a correctness requirement.
 */
export function createCachedAuthorizationSnapshot(
  engine: AuthorizationEngine,
  features: Pick<FeatureRepository, "isEnabled">,
): (input: ComputeAuthorizationSnapshotInput) => Promise<AuthorizationSnapshot> {
  return cache((input: ComputeAuthorizationSnapshotInput) => computeAuthorizationSnapshot(engine, features, input));
}

/**
 * Binds an identity resolver (e.g. `resolveIdentity` from `@uniora/supabase`,
 * `@uniora/clerk`, `@uniora/auth0` or `@uniora/better-auth`, already closed
 * over the request's cookies/headers) to a request-scoped `react.cache()`,
 * so multiple Server Components resolving "who is the current user" during
 * the same request share one resolution instead of re-verifying the session
 * once per component. UNIORA never resolves identity itself (docs/PROYECT.md
 * §14) — this only memoizes whatever resolver the host app already has.
 */
export function createCachedIdentity(resolveIdentity: () => Promise<Identity | null>): () => Promise<Identity | null> {
  return cache(resolveIdentity);
}
