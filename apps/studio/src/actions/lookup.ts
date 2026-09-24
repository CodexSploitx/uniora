"use server";

import type { RoleRef } from "@/lib/types";
import { lookupMemberRoles, searchOrgRoles } from "@/lib/queries";

/**
 * Read-only typeaheads for the role picker and the member-roles popover.
 * Server Actions are reachable endpoints, so every argument is validated like
 * any other untrusted value, the session is re-checked inside the query, and
 * results are capped.
 */
const validId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 128;
const optionalText = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

export async function lookupRoles(args: { organizationId: string; query?: string; notHeldBy?: string }): Promise<RoleRef[]> {
  if (!validId(args?.organizationId)) return [];
  const notHeldBy = validId(args.notHeldBy) ? args.notHeldBy : undefined;
  return searchOrgRoles(args.organizationId, optionalText(args.query), notHeldBy);
}

export async function lookupHeldRoles(args: {
  organizationId: string;
  membershipId: string;
  query?: string;
}): Promise<{ roles: RoleRef[]; total: number }> {
  if (!validId(args?.organizationId) || !validId(args.membershipId)) return { roles: [], total: 0 };
  return lookupMemberRoles(args.organizationId, args.membershipId, optionalText(args.query));
}
