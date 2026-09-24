"use client";

import type { ReactNode } from "react";
import { useCan } from "./hooks.js";

export interface CanProps {
  permission: string;
  children: ReactNode;
  /** Rendered instead of `children` when the permission is denied. Defaults to nothing. */
  fallback?: ReactNode;
}

/**
 * Renders `children` only when `permission` is granted in the current
 * `AuthorizationSnapshot`, `fallback` otherwise (nothing by default).
 * UX only — hiding this element is not a security control
 * (docs/PROYECT.md §7; uniora-security-engineering skill INV-010, "No
 * Security Through UI"). The server must independently authorize the
 * real operation behind it.
 */
export function Can({ permission, children, fallback = null }: CanProps) {
  return useCan(permission) ? <>{children}</> : <>{fallback}</>;
}
