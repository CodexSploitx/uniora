/**
 * The examples of the API reference, as a story that runs against a real server. Each step names an operation, the input a caller
 * would pass (path, query and body flattened, exactly as `@uniora/client` takes them), who it speaks for when it is a delegated
 * call, and the status it must answer. The runner executes the steps in order; the reference shows what the server REALLY
 * answered, so an example cannot go stale: if the API changes, this fails or the generated document differs.
 */
export interface Context {
  /** The body of the last answer of an operation. */
  last(operation: string): any;
}

export interface Step {
  readonly operation: string;
  /** What the example shows, in a few words. */
  readonly title: string;
  readonly input?: Record<string, unknown> | ((context: Context) => Record<string, unknown>);
  /** The end user a delegated call speaks for. */
  readonly actor?: string;
  readonly ifMatch?: (context: Context) => number;
  readonly idempotencyKey?: string;
  /** Which key makes the call. Default: the one with every scope. */
  readonly as?: "anonymous";
  readonly expect: number;
  /** Shown in the reference. */
  readonly primary?: boolean;
}

const ORG = "org_acme";
const ana = { subject: "ana" };

const step = (operation: string, title: string, input: Step["input"], expect = 200, extra: Partial<Step> = {}): Step => ({ operation, title, input, expect, ...extra });
const as = (actor: string) => ({ actor });

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
  step("members.block", "Block a member", { organizationId: ORG, membershipId: "mem_bob", reason: "left the company" }, 200, as("mgr")),
  step("members.unblock", "Lift the block", { organizationId: ORG, membershipId: "mem_bob" }, 200, as("mgr")),
  step("members.suspend", "Suspend a member until a date", { organizationId: ORG, membershipId: "mem_bob", until: "2099-01-01T00:00:00.000Z", reason: "on leave" }, 200, as("mgr")),
  step("members.unblock", "Lift the suspension early", { organizationId: ORG, membershipId: "mem_bob" }, 200, as("mgr")),
  step("roles.create", "A new role", { organizationId: ORG, id: "role_support", name: "Support agent", permissionKeys: ["reports.read"] }, 201, as("mgr")),
  step("roles.update", "Rename it", { organizationId: ORG, roleId: "role_support", name: "Support", description: "Answers tickets" }, 200, as("mgr")),
  step("roles.setPermissions", "Make it hold exactly these permissions", { organizationId: ORG, roleId: "role_support", permissionKeys: ["reports.read", "members.block"] }, 200, as("mgr")),
  step("roles.grantPermission", "Add one permission", { organizationId: ORG, roleId: "role_support", permissionKey: "members.remove" }, 200, as("mgr")),
  step("roles.grantPermission", "You cannot give what you do not hold", { organizationId: ORG, roleId: "role_support", permissionKey: "vehicles.delete" }, 403, as("mgr")),
  step("roles.revokePermission", "Take one away", { organizationId: ORG, roleId: "role_support", permissionKey: "members.remove" }, 200, as("mgr")),
  step("roles.clone", "Copy it", { organizationId: ORG, roleId: "role_support", id: "role_support_eu", name: "Support EU" }, 201, as("mgr")),
  step("roles.delete", "Delete the copy", { organizationId: ORG, roleId: "role_support_eu" }, 200, as("mgr")),

  // Teams
  step("teams.create", "A team", { organizationId: ORG, id: "team_bcn", name: "Barcelona", metadata: { region: "ES" } }, 201, as("mgr")),
  step("teams.create", "A team under it", { organizationId: ORG, id: "team_sants", name: "Sants", parentId: "team_bcn" }, 201, as("mgr")),
  step("teams.create", "Another top-level team", { organizationId: ORG, id: "team_mad", name: "Madrid" }, 201, as("mgr")),
  step("teams.get", "Read a team", { organizationId: ORG, teamId: "team_bcn" }),
  step("teams.list", "List the teams", { organizationId: ORG, limit: 10 }),
  step("teams.update", "Edit a team", { organizationId: ORG, teamId: "team_bcn", externalId: "ERP-BCN-01" }, 200, as("mgr")),
  step("teams.addMember", "Add a member", { organizationId: ORG, teamId: "team_bcn", id: "tm_ana", membershipId: "mem_ana" }, 201, as("mgr")),
  step("teams.addMember", "Invite a member: they must accept", { organizationId: ORG, teamId: "team_bcn", id: "tm_bob", membershipId: "mem_bob", status: "pending" }, 201, as("mgr")),
  step("teamMembers.accept", "The invited person accepts", { organizationId: ORG, teamMembershipId: "tm_bob" }, 200, as("bob")),
  step("teams.members", "List the members of a team", { organizationId: ORG, teamId: "team_bcn", status: "active" }),
  step("teamMembers.setResponsibility", "Set who looks after the team", { organizationId: ORG, teamMembershipId: "tm_ana", responsibility: "manager" }, 200, as("mgr")),
  step("teamMembers.assignRole", "A role that applies only inside the team", { organizationId: ORG, teamMembershipId: "tm_ana", roleId: "role_viewer" }, 200, as("mgr")),
  step("teamMembers.unassignRole", "Take it away", { organizationId: ORG, teamMembershipId: "tm_ana", roleId: "role_viewer" }, 200, as("mgr")),
  step("teamMembers.suspend", "Suspend a team membership", { organizationId: ORG, teamMembershipId: "tm_ana", reason: "on leave" }, 200, as("mgr")),
  step("teamMembers.reactivate", "Lift it", { organizationId: ORG, teamMembershipId: "tm_ana" }, 200, as("mgr")),
  step("teamMembers.move", "Move a member to another team", { organizationId: ORG, id: "tm_ana_mad", membershipId: "mem_ana", fromTeamId: "team_bcn", toTeamId: "team_mad", reason: "transfer" }, 201, as("mgr")),
  step("teamMembers.remove", "Remove someone from a team", { organizationId: ORG, teamMembershipId: "tm_bob", reason: "left the project" }, 200, as("mgr")),
  step("teams.leave", "The actor leaves a team", { organizationId: ORG, teamId: "team_mad" }, 200, as("ana")),
  step("teams.archive", "Archive a team (sub-teams first)", { organizationId: ORG, teamId: "team_bcn", reason: "closed" }, 409, as("mgr")),
  step("teams.archive", "Archive the sub-team", { organizationId: ORG, teamId: "team_sants", reason: "closed" }, 200, as("mgr")),
  step("teams.restore", "Restore it", { organizationId: ORG, teamId: "team_sants" }, 200, as("mgr")),
  step("teams.archive", "Archive it again", { organizationId: ORG, teamId: "team_sants" }, 200, as("mgr")),
  step("teams.delete", "Delete an archived team", { organizationId: ORG, teamId: "team_sants" }, 200, as("mgr")),

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
