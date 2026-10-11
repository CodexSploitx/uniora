/**
 * The examples of the API reference, as a story that runs against a real server. Each step names an operation, the input a caller
 * would pass (path, query and body flattened, exactly as `@uniora/client` takes them), who it speaks for when it is a delegated
 * call, and the status it must answer. The runner executes the steps in order; the reference shows what the server REALLY
 * answered, so an example cannot go stale: if the API changes, this fails or the generated document differs.
 */
export interface Context {
  /** The body of the last answer of an operation. */
  last(operation: string): any;
  /** The body of the answer to a step that was marked `save: name` (for ids the server made up). */
  saved(name: string): any;
}

export interface Step {
  readonly operation: string;
  /** What the example shows, in a few words. */
  readonly title: string;
  readonly input?: Record<string, unknown> | ((context: Context) => Record<string, unknown>);
  /** The end user a delegated call speaks for, asserted. */
  readonly actor?: string;
  /** The end user a call speaks for, proven by a token from the identity provider (the runner signs one). */
  readonly verifiedAs?: string;
  /** Claims added to that token (`auth_time`, `amr`...). */
  readonly tokenClaims?: Record<string, unknown>;
  readonly ifMatch?: (context: Context) => number;
  readonly idempotencyKey?: string;
  /** Which key makes the call. Default: the one with every scope. */
  readonly as?: "anonymous";
  readonly expect: number;
  /** Keep this answer under a name, for later steps (`context.saved(name)`). */
  readonly save?: string;
  /** Shown in the reference. */
  readonly primary?: boolean;
}

const ORG = "org_acme";
const ana = { subject: "ana" };

const step = (operation: string, title: string, input: Step["input"], expect = 200, extra: Partial<Step> = {}): Step => ({ operation, title, input, expect, ...extra });
const as = (actor: string) => ({ actor });
const verified = (verifiedAs: string, tokenClaims?: Record<string, unknown>) => ({ verifiedAs, ...(tokenClaims ? { tokenClaims } : {}) });

export const STEPS: readonly Step[] = [
  // Decisions
  step("decisions.check", "May Ana read reports?", { identity: ana, organizationId: ORG, permission: "reports.read" }),
  step("decisions.check", "A member without the permission", { identity: { subject: "bob" }, organizationId: ORG, permission: "reports.read" }),
  step("decisions.check", "A malformed question is refused, not guessed", { identity: ana, organizationId: ORG }, 400),
  step("decisions.checkBatch", "Several questions in one round trip", {
    identity: ana,
    organizationId: ORG,
    checks: [{ permission: "reports.read" }, { permission: "vehicles.delete" }],
  }),
  step("decisions.authorize", "The full decision, with a resource of the organization", {
    identity: ana,
    organizationId: ORG,
    permission: "reports.read",
    resource: { type: "report", id: "rep_42", organizationId: ORG },
  }),
  step("decisions.authorize", "A resource of ANOTHER organization is never allowed", {
    identity: ana,
    organizationId: ORG,
    permission: "reports.read",
    resource: { type: "report", id: "rep_99", organizationId: "org_globex" },
  }),
  step("decisions.snapshot", "What a screen needs, in one call", { identity: ana, organizationId: ORG, permissions: ["reports.read", "vehicles.delete"], features: ["advanced_reports"] }),

  // Reads
  step("organizations.list", "The organizations this client may reach", { limit: 10 }),
  step("organizations.get", "One organization", { organizationId: ORG }),
  step("organizations.features", "Its features, as a check sees them", { organizationId: ORG, limit: 5 }),
  step("members.list", "Its members", { organizationId: ORG, limit: 10 }),
  step("members.get", "One member", { organizationId: ORG, membershipId: "mem_ana" }),
  step("roles.list", "Its roles", { organizationId: ORG, limit: 10 }),
  step("roles.permissions", "What a role grants", { organizationId: ORG, roleId: "role_viewer" }),
  step("permissions.list", "The permissions of the deployment", { limit: 5 }),
  step("features.list", "The features of the deployment", { limit: 5 }),

  // Provisioning
  step("organizations.create", "Sign-up: an organization with its first Owner", { name: "Initech", owner: { subject: "founder-7" } }, 201, { idempotencyKey: "signup-7f3a" }),
  step("organizations.create", "The same request again answers the first result", { name: "Initech", owner: { subject: "founder-7" } }, 201, { idempotencyKey: "signup-7f3a" }),
  step("organizations.create", "The same key for a different request is refused", { name: "Initech Europe", owner: { subject: "founder-7" } }, 422, { idempotencyKey: "signup-7f3a" }),

  // Members and roles (delegated)
  step("members.assignRole", "A manager gives Bob a role", { organizationId: ORG, membershipId: "mem_bob", roleId: "role_viewer" }, 200, as("mgr")),
  step("members.assignRole", "Nobody changes their own roles", { organizationId: ORG, membershipId: "mem_mgr", roleId: "role_viewer" }, 403, as("mgr")),
  step("members.assignRole", "Someone without the permission gets a plain forbidden", { organizationId: ORG, membershipId: "mem_bob", roleId: "role_viewer" }, 403, as("ana")),
  step("members.unassignRole", "Take the role away, if the member is still at the version we saw", { organizationId: ORG, membershipId: "mem_bob", roleId: "role_viewer" }, 200, {
    ...as("mgr"),
    ifMatch: (c) => c.last("members.assignRole").version,
  }),
  step("members.block", "The same, but proving who speaks with the user's own token", { organizationId: ORG, membershipId: "mem_bob", reason: "left the company" }, 200, verified("mgr")),
  step("members.unblock", "Lift it (token of someone without the permission is refused)", { organizationId: ORG, membershipId: "mem_bob" }, 403, verified("ana")),
  step("members.unblock", "Lift it", { organizationId: ORG, membershipId: "mem_bob" }, 200, verified("mgr")),
  step("members.block", "Block a member", { organizationId: ORG, membershipId: "mem_bob", reason: "left the company" }, 200, as("mgr")),
  step("members.unblock", "Lift the block", { organizationId: ORG, membershipId: "mem_bob" }, 200, as("mgr")),
  step("members.suspend", "Suspend a member until a date", { organizationId: ORG, membershipId: "mem_bob", until: "2099-01-01T00:00:00.000Z", reason: "on leave" }, 200, as("mgr")),
  step("members.unblock", "Lift the suspension early", { organizationId: ORG, membershipId: "mem_bob" }, 200, as("mgr")),
  step("roles.create", "A new role", { organizationId: ORG, name: "Support agent", permissionKeys: ["reports.read"] }, 201, { ...as("mgr"), save: "support" }),
  step("roles.update", "Rename it", (c) => ({ organizationId: ORG, roleId: c.saved("support").id, name: "Support", description: "Answers tickets" }), 200, as("mgr")),
  step("roles.setPermissions", "Make it hold exactly these permissions", (c) => ({ organizationId: ORG, roleId: c.saved("support").id, permissionKeys: ["reports.read", "members.block"] }), 200, as("mgr")),
  step("roles.grantPermission", "Add one permission", (c) => ({ organizationId: ORG, roleId: c.saved("support").id, permissionKey: "members.remove" }), 200, as("mgr")),
  step("roles.grantPermission", "You cannot give what you do not hold", (c) => ({ organizationId: ORG, roleId: c.saved("support").id, permissionKey: "vehicles.delete" }), 403, as("mgr")),
  step("roles.revokePermission", "Take one away", (c) => ({ organizationId: ORG, roleId: c.saved("support").id, permissionKey: "members.remove" }), 200, as("mgr")),
  step("roles.clone", "Copy it", (c) => ({ organizationId: ORG, roleId: c.saved("support").id, name: "Support EU" }), 201, { ...as("mgr"), save: "supportEu" }),
  step("roles.delete", "Delete the copy", (c) => ({ organizationId: ORG, roleId: c.saved("supportEu").id }), 200, as("mgr")),

  // Teams
  step("teams.create", "A team", { organizationId: ORG, name: "Barcelona", metadata: { region: "ES" } }, 201, { ...as("mgr"), save: "bcn" }),
  step("teams.create", "A team under it", (c) => ({ organizationId: ORG, name: "Sants", parentId: c.saved("bcn").id }), 201, { ...as("mgr"), save: "sants" }),
  step("teams.create", "Another top-level team", { organizationId: ORG, name: "Madrid" }, 201, { ...as("mgr"), save: "mad" }),
  step("teams.get", "Read a team", (c) => ({ organizationId: ORG, teamId: c.saved("bcn").id })),
  step("teams.list", "List the sub-teams of a team", (c) => ({ organizationId: ORG, parentId: c.saved("bcn").id, limit: 10 })),
  step("teams.update", "Edit a team", (c) => ({ organizationId: ORG, teamId: c.saved("bcn").id, externalId: "ERP-BCN-01" }), 200, as("mgr")),
  step("teams.addMember", "Add a member", (c) => ({ organizationId: ORG, teamId: c.saved("bcn").id, membershipId: "mem_ana" }), 201, { ...as("mgr"), save: "tmAna" }),
  step("teams.addMember", "Invite a member: they must accept", (c) => ({ organizationId: ORG, teamId: c.saved("bcn").id, membershipId: "mem_bob", status: "pending" }), 201, { ...as("mgr"), save: "tmBob" }),
  step("teams.members", "List the active members of a team (the invited one is still pending)", (c) => ({ organizationId: ORG, teamId: c.saved("bcn").id, status: "active" })),
  step("teamMembers.accept", "The invited person accepts", (c) => ({ organizationId: ORG, teamMembershipId: c.saved("tmBob").id }), 200, as("bob")),
  step("teamMembers.setResponsibility", "Set who looks after the team", (c) => ({ organizationId: ORG, teamMembershipId: c.saved("tmAna").id, responsibility: "manager" }), 200, as("mgr")),
  step("teamMembers.assignRole", "A role that applies only inside the team", (c) => ({ organizationId: ORG, teamMembershipId: c.saved("tmAna").id, roleId: "role_viewer" }), 200, as("mgr")),
  step("teamMembers.unassignRole", "Take it away", (c) => ({ organizationId: ORG, teamMembershipId: c.saved("tmAna").id, roleId: "role_viewer" }), 200, as("mgr")),
  step("teamMembers.suspend", "Suspend a team membership", (c) => ({ organizationId: ORG, teamMembershipId: c.saved("tmAna").id, reason: "on leave" }), 200, as("mgr")),
  step("teamMembers.reactivate", "Lift it", (c) => ({ organizationId: ORG, teamMembershipId: c.saved("tmAna").id }), 200, as("mgr")),
  step("teamMembers.move", "Move a member to another team", (c) => ({ organizationId: ORG, membershipId: "mem_ana", fromTeamId: c.saved("bcn").id, toTeamId: c.saved("mad").id, reason: "transfer" }), 201, as("mgr")),
  step("teamMembers.remove", "Remove someone from a team", (c) => ({ organizationId: ORG, teamMembershipId: c.saved("tmBob").id, reason: "left the project" }), 200, as("mgr")),
  step("teams.leave", "The actor leaves a team", (c) => ({ organizationId: ORG, teamId: c.saved("mad").id }), 200, as("ana")),
  step("teams.archive", "Archive a team (sub-teams first)", (c) => ({ organizationId: ORG, teamId: c.saved("bcn").id, reason: "closed" }), 409, as("mgr")),
  step("teams.archive", "Archive the sub-team", (c) => ({ organizationId: ORG, teamId: c.saved("sants").id, reason: "closed" }), 200, as("mgr")),
  step("teams.restore", "Restore it", (c) => ({ organizationId: ORG, teamId: c.saved("sants").id }), 200, as("mgr")),
  step("teams.archive", "Archive it again", (c) => ({ organizationId: ORG, teamId: c.saved("sants").id }), 200, as("mgr")),
  step("teams.delete", "Delete an archived team", (c) => ({ organizationId: ORG, teamId: c.saved("sants").id }), 200, as("mgr")),

  // Policies
  step(
    "policies.create",
    "A draft policy: refuse reports while the membership is active",
    {
      organizationId: ORG,
      key: "freeze-reports",
      name: "Freeze reports",
      description: "Nobody reads reports during the audit.",
      definition: { kind: "access", effect: "deny", actions: ["reports.read"], condition: { eq: [{ ref: "subject.membershipStatus" }, { value: "active" }] } },
    },
    201,
    as("mgr"),
  ),
  step("policies.validate", "Check a definition without saving it", (c) => ({ organizationId: ORG, definition: c.last("policies.create").definition }), 200, as("mgr")),
  step("policies.validate", "A definition the policy language refuses", { organizationId: ORG, definition: { kind: "access" } }, 400, as("mgr")),
  step("policies.simulate", "What would be decided with this definition?", (c) => ({ organizationId: ORG, identity: ana, permission: "reports.read", candidate: { definition: c.last("policies.create").definition } }), 200, as("mgr")),
  step("policies.get", "Read a policy", (c) => ({ organizationId: ORG, policyId: c.last("policies.create").id }), 200, as("mgr")),
  step("policies.list", "List policies", { organizationId: ORG, limit: 10 }, 200, as("mgr")),
  step("policies.update", "Edit the draft", (c) => ({ organizationId: ORG, policyId: c.last("policies.create").id, name: "Freeze reports during the audit", note: "clearer name" }), 200, as("mgr")),
  step("policies.activate", "Put it live", (c) => ({ organizationId: ORG, policyId: c.last("policies.create").id, reason: "audit starts" }), 200, as("mgr")),
  step("decisions.authorize", "With the user's token the session comes from the token: recently signed in with a second factor", { identity: ana, organizationId: ORG, permission: "reports.read", resource: { type: "report", id: "rep_42", organizationId: ORG } }, 200, verified("ana", { auth_time: 1_700_000_000, amr: ["pwd", "mfa"] })),
  step("decisions.authorize", "From now on the policy decides", { identity: ana, organizationId: ORG, permission: "reports.read" }),
  step("policies.revisions", "The history of the definition", (c) => ({ organizationId: ORG, policyId: c.last("policies.create").id }), 200, as("mgr")),
  step("policies.disable", "Switch it off", (c) => ({ organizationId: ORG, policyId: c.last("policies.create").id }), 200, as("mgr")),
  step("policies.retire", "Retire it for good", (c) => ({ organizationId: ORG, policyId: c.last("policies.create").id, reason: "audit over" }), 200, as("mgr")),
  step(
    "policies.create",
    "Another draft",
    { organizationId: ORG, key: "scratch", name: "Scratch", definition: { kind: "access", effect: "deny", actions: ["reports.read"], condition: { eq: [{ ref: "subject.membershipStatus" }, { value: "blocked" }] } } },
    201,
    as("mgr"),
  ),
  step("policies.delete", "Delete a draft", (c) => ({ organizationId: ORG, policyId: c.last("policies.create").id }), 200, as("mgr")),

  // Invitations
  step("invitations.create", "Invite someone by e-mail", { organizationId: ORG, email: "New.Person@example.com", roleIds: ["role_viewer"] }, 201, { ...as("mgr"), idempotencyKey: "invite-new-person" }),
  step("invitations.preview", "What the accept page may show before sign-in", (c) => ({ token: String(c.last("invitations.create").acceptUrl).split("/").at(-1)! })),
  step("invitations.accept", "The person signs up and accepts", (c) => ({ token: String(c.last("invitations.create").acceptUrl).split("/").at(-1)!, identity: { subject: "newbie-1" }, verifiedEmail: "new.person@example.com" })),
  step("invitations.create", "Another invitation", { organizationId: ORG, email: "second@example.com", roleIds: ["role_viewer"] }, 201, as("mgr")),
  step("invitations.resend", "Send it again with a new link", (c) => ({ organizationId: ORG, invitationId: c.last("invitations.create").invitation.id }), 200, as("mgr")),
  step("invitations.revoke", "Revoke it", (c) => ({ organizationId: ORG, invitationId: c.last("invitations.create").invitation.id }), 200, as("mgr")),

  step("members.remove", "Remove a member from the organization", (c) => ({ organizationId: ORG, membershipId: c.last("invitations.accept").membershipId }), 200, as("mgr")),

  // The audit log, after all of it
  step("audit.list", "The newest entries of the audit log", { organizationId: ORG, limit: 4 }),

  // What every call can meet
  step("organizations.list", "A call with no key", {}, 401, { as: "anonymous" }),
];

export { ORG };
