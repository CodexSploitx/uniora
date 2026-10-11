import { s } from "../schema.js";
import { IdentityOutput, id } from "./common.js";

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


const Moment = (description: string) => s.optional(s.object({ at: s.date(), by: IdentityOutput, reason: s.optional(s.string({ max: 500 })) }, { description }));
const FreeData = s.record(s.json({ maxDepth: 4, maxNodes: 500, maxString: 2000 }), { maxKeys: 100, keyPattern: /^[^\u0000-\u001f]{1,100}$/ });

export const TEAM_STATUSES = ["active", "archived"] as const;
export const TEAM_MEMBER_STATUSES = ["pending", "active", "suspended", "removed"] as const;
export const TEAM_RESPONSIBILITIES = ["owner", "manager", "member"] as const;

export const TeamOut = s.object({
  id: s.string({ max: 200 }),
  organizationId: s.string({ max: 200 }),
  slug: s.string({ max: 200 }),
  name: s.string({ max: 255 }),
  status: s.enum(TEAM_STATUSES),
  parentId: s.optional(s.string({ max: 200, description: "The team this one sits under. Organizational only: it grants and inherits nothing." })),
  externalId: s.optional(s.string({ max: 200, description: "Your own id for the team in another system." })),
  metadata: FreeData,
  settings: FreeData,
  createdAt: s.date(),
  updatedAt: s.date(),
  archived: Moment("Present while the team is archived."),
  version: s.int({ min: 1, max: Number.MAX_SAFE_INTEGER, description: "Send it back as `If-Match` to refuse changes made from a stale copy." }),
});

export const TeamMembershipOut = s.object({
  id: s.string({ max: 200 }),
  organizationId: s.string({ max: 200 }),
  teamId: s.string({ max: 200 }),
  membershipId: s.string({ max: 200, description: "The organization membership." }),
  status: s.enum(TEAM_MEMBER_STATUSES),
  responsibility: s.enum(TEAM_RESPONSIBILITIES, { description: "A label, not a permission." }),
  roleIds: s.array(s.string({ max: 200 }), { max: 100, description: "Roles of the organization that apply only inside this team." }),
  createdAt: s.date(),
  updatedAt: s.date(),
  joinedAt: s.optional(s.date()),
  invitedBy: s.optional(IdentityOutput),
  statusChange: Moment("The last status change."),
  version: s.int({ min: 1, max: Number.MAX_SAFE_INTEGER }),
});

export { FreeData };

export const ResourceInput = s.optional(
  s.object(
    {
      type: s.string({ min: 1, max: 64, description: "What kind of resource (`vehicle`, `ticket`): policies are matched on it.", example: "vehicle" }),
      id: id("The resource's id in your database.", "veh_42"),
      organizationId: id("The organization the resource belongs to, as YOUR database says. A mismatch is `cross_tenant_resource`."),
      teamIds: s.optional(s.array(id("A team the resource belongs to."), { max: 50 })),
      attributes: s.optional(
        s.record(s.json({ maxDepth: 2, maxNodes: 100, maxString: 500 }), {
          maxKeys: 50,
          keyPattern: /^[A-Za-z][A-Za-z0-9_.]{0,63}$/,
          description: "The values of the attributes the policies declare (`status`, `ownerIdentity`...).",
        }),
      ),
    },
    { description: "The thing the question is about." },
  ),
);

export const ContextInput = s.optional(
  s.record(s.json({ maxDepth: 2, maxNodes: 100, maxString: 500 }), {
    maxKeys: 20,
    keyPattern: /^[A-Za-z][A-Za-z0-9_]{0,63}$/,
    description: "Signals about the request that your server verified (`{ \"ipCountry\": \"ES\" }`). Only the ones a policy declares are used.",
  }),
);

export const SessionInput = s.optional(
  s.object(
    {
      authenticatedAt: s.optional(s.date({ description: "When the person last proved who they are (a sign-in or a step-up), NOT when the session began." })),
      startedAt: s.optional(s.date({ description: "When the session began." })),
      mfa: s.optional(s.bool({ description: "Whether a second factor was used." })),
      assuranceLevel: s.optional(s.int({ min: 0, max: 100 })),
      methods: s.optional(s.array(s.string({ min: 1, max: 64, pattern: /^[A-Za-z0-9_.:-]{1,64}$/ }), { max: 16 })),
    },
    { description: "How the person authenticated, as your server's authentication states it." },
  ),
);
