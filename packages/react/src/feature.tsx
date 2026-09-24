"use client";

import type { ReactNode } from "react";
import { useFeature } from "./hooks.js";

export interface FeatureProps {
  /** The feature's `key` (`Feature.key`/`FeatureDefinition.key` in `@uniora/core`) — not its cosmetic `name`. */
  feature: string;
  children: ReactNode;
  /** Rendered instead of `children` when the feature is disabled. Defaults to nothing. */
  fallback?: ReactNode;
}

/**
 * Renders `children` only when `feature` is enabled for the current
 * organization in the current `AuthorizationSnapshot`, `fallback`
 * otherwise. Same UX-only caveat as `Can` — never a security boundary.
 */
export function Feature({ feature, children, fallback = null }: FeatureProps) {
  return useFeature(feature) ? <>{children}</> : <>{fallback}</>;
}
