import { s } from "../schema.js";
import { IdentityOutput } from "./common.js";

/** The shapes the API answers with, shared by the routes that read and the routes that change. Fields not listed here never leave the server. */
export const ORG_STATUSES = ["active", "suspended", "archived"] as const;
export const MEMBER_STATUSES = ["active", "suspended", "blocked"] as const;

export const OrganizationOut = s.object({
  id: s.string({ max: 200 }),
  slug: s.string({ max: 200 }),
  name: s.string({ max: 200 }),
  status: s.enum(ORG_STATUSES, { description: "`suspended` and `archived` organizations are denied every decision." }),
  createdAt: s.date(),
  version: s.int({ min: 1, max: Number.MAX_SAFE_INTEGER }),
});

export const MemberOut = s.object({
  id: s.string({ max: 200 }),
  organizationId: s.string({ max: 200 }),
  identity: IdentityOutput,
  roleIds: s.array(s.string({ max: 200 }), { max: 1000 }),
  status: s.enum(MEMBER_STATUSES),
  createdAt: s.date(),
  updatedAt: s.date(),
  lastActiveAt: s.optional(s.date()),
  invitedBy: s.optional(IdentityOutput),
  blocked: s.optional(s.object({ at: s.date(), until: s.optional(s.date()) }, { description: "Present while the member is blocked or suspended." })),
  version: s.int({ min: 1, max: Number.MAX_SAFE_INTEGER, description: "Send it back as `If-Match` to refuse changes made from a stale copy." }),
});

export const RoleOut = s.object({
  id: s.string({ max: 200 }),
  organizationId: s.string({ max: 200 }),
  key: s.string({ max: 200 }),
  name: s.string({ max: 200 }),
  isOwnerRole: s.bool({ description: "The protected Owner role: it passes every permission check." }),
  isSystem: s.bool(),
  description: s.optional(s.string({ max: 500 })),
});

/** The role as a change answers with it: the summary plus the version to send back as `If-Match`. Its permissions are listed by `roles.permissions`. */
export const RoleVersionedOut = s.object({
  ...RoleOut.shape,
  version: s.int({ min: 1, max: Number.MAX_SAFE_INTEGER, description: "Send it back as `If-Match` to refuse changes made from a stale copy." }),
});

