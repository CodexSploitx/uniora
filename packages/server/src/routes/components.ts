import type { Schema } from "../schema.js";
import { IdentityInput, IdentityOutput } from "./common.js";
import { InvitationOut } from "./invitations.js";
import { PolicyOut, PolicyRevisionOut } from "./policies.js";
import { MemberOut, OrganizationOut, RoleOut, RoleVersionedOut, TeamMembershipOut, TeamOut } from "./schemas.js";

/** The shapes the OpenAPI document names once and refers to everywhere (by identity: the same object the routes use). */
export const COMPONENT_SCHEMAS: ReadonlyMap<Schema, string> = new Map<Schema, string>([
  [IdentityOutput, "Identity"],
  [IdentityInput, "IdentityInput"],
  [OrganizationOut, "Organization"],
  [MemberOut, "Member"],
  [RoleOut, "RoleSummary"],
  [RoleVersionedOut, "Role"],
  [TeamOut, "Team"],
  [TeamMembershipOut, "TeamMembership"],
  [PolicyOut, "Policy"],
  [PolicyRevisionOut, "PolicyRevision"],
  [InvitationOut, "Invitation"],
]);
