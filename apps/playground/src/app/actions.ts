"use server";

import { assertCan, AuthorizationDeniedError } from "@uniora/next";
import { getDemoAuthorization, type DemoRoleKey } from "@/lib/demo-storage";

export interface SimulateActionResult {
  granted: boolean;
  permission: string;
}

/**
 * Demonstrates `@uniora/next`'s `assertCan` guard for a Server Action
 * (docs/PROYECT.md §25). This is the real server-side re-check behind the
 * client's `<Can>` gate in `permission-check.tsx` — proof that hiding the
 * button on the client is UX only, never the actual security boundary
 * (uniora-security-engineering INV-010): calling this action directly for
 * a role that lacks `permission` is denied here too, independently.
 */
export async function simulateProtectedAction(role: DemoRoleKey, permission: string): Promise<SimulateActionResult> {
  const { engine, identity, organizationId } = await getDemoAuthorization(role);

  try {
    await assertCan(engine, { identity, organizationId, permission });
    return { granted: true, permission };
  } catch (error) {
    if (error instanceof AuthorizationDeniedError) return { granted: false, permission };
    throw error;
  }
}
