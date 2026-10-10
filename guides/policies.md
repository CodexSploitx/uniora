# Policies

Policies are the conditional authorization rules of UNIORA. A permission says a person *can* edit vehicles; a policy says *under which
conditions* that capability may be used: only vehicles of their own branch, and not while the vehicle is locked.

> Role = responsibility. Permission = capability to perform an action. Team = organizational context. Feature = available capability.
> **Policy = conditions governing authorization.** The authorization engine makes the final decision.

This guide is the design of the layer (phase 1) and its reference. The [status](#status-of-this-release) section at the end says what
ships in which version.

## Principles

1. **A policy never grants.** It can only restrict what the engine would otherwise allow. There is no `allow` effect: a definition that
   tries to use one is refused. A favourable policy does not give anybody a permission they do not hold.
2. **Policies are data, not code.** A policy is a JSON document in a fixed grammar. UNIORA never runs code supplied by a policy, never
   evaluates strings as expressions, and never lets a rule reach the server environment. Definitions are treated as untrusted input.
3. **The engine coordinates, policies are rules.** Policy = the rule. Policy evaluation = evaluating the rule. Authorization engine =
   the decision. Policies call back into the engine for permissions and into storage for features; they do not re-implement either.
4. **Fail closed.** If a rule cannot be decided (missing attribute, wrong type, a dependency fails, a budget runs out) the verdict is
   `indeterminate`, and `indeterminate` is never an allow.
5. **Tenant isolation is not a policy.** It is a mandatory check of the engine, plus database constraints. No policy can switch it off.

## The decision

`engine.authorize()` answers one question: *may this identity do this action, on this resource, in this organization?*

1. **Mandatory checks** (the engine's own, not configurable, not overridable by any policy): the organization is active, the
   resource (when there is one) belongs to the same organization, the identity has an active membership, and the permission is granted
   by roles (or a support grant). If any of them fails the answer is **deny** and policies are not evaluated.
2. **Applicable policies** of the organization (status `active`, matching the permission and the type of resource) are evaluated.
3. **Combination:** *deny overrides, then indeterminate, then allow.*

| Mandatory checks | Policies | Result |
| --- | --- | --- |
| deny | (not evaluated) | **deny** |
| allow | any policy denies | **deny** |
| allow | none denies, any is indeterminate | **indeterminate** (not allowed) |
| allow | all allow, or none applies | **allow** |

There is no priority and no order: the result is the same for any order of the policies, adding a policy can only make the answer
equal or more restrictive, and one policy's `allow` can never cancel another's `deny`. (Both properties are tested with generated
policies.) The effective answer for a caller is `allowed === (decision === "allow")`.

A protected operation can ask for `requireApplicablePolicy: true`: with no applicable policy the answer is deny
(`no_applicable_policy`). The policy administration permissions (`policies.*`) are never subject to policies, so no rule can lock
anybody out of fixing the rules.

## A policy

```jsonc
{
  "kind": "scope",                    // access | resource | scope | feature | contextual | sensitive
  "effect": "require",                // deny | require
  "actions": ["vehicles.update", "vehicles.read"],   // permission keys, "vehicles.*" prefixes, or "*"
  "resourceType": "vehicle",          // the policy applies to resources of this type
  "condition": { "intersects": [{ "ref": "subject.teamIds" }, { "ref": "resource.teamIds" }] }
}
```

```jsonc
{
  "kind": "resource",
  "effect": "deny",
  "actions": ["vehicles.*"],
  "resourceType": "vehicle",
  "attributes": { "status": "string" },            // what it reads from the resource, typed
  "condition": {
    "all": [
      { "eq": [{ "ref": "resource.status" }, { "value": "locked" }] },
      { "not": { "permission": "vehicles.unlock" } }   // a permission asked of the engine
    ]
  },
  "denyReason": "vehicle_locked"
}
```

- `deny`: refused **when** the condition is true. `require`: refused **unless** the condition is true.
- **Operators:** `all`, `any`, `not`; `eq`, `neq`, `lt`, `lte`, `gt`, `gte`, `in`, `contains`, `intersects`; `exists`; `feature` (the
  Feature is enabled for the organization); `permission` (the actor holds that permission, decided by the engine without policies,
  so policies cannot call each other: there are no references and therefore no cycles).
- **Types:** `string`, `number`, `boolean`, `string[]`, `number[]`. Comparisons are type-checked when the policy is saved and again
  when it runs; there is no coercion (`"5"` is not `5`).
- **Unknown (Kleene) logic:** a leaf that cannot be decided is *unknown*. `all` with a false member is false even if another is
  unknown; `any` with a true member is true; `not unknown` is unknown. An unknown condition makes the policy indeterminate.
- **Kinds are checked, not just labels.** `resource` must read a declared resource attribute; `scope` must compare something about the
  person with something about the resource; `feature` must ask for a feature; `access` does not read the resource's state;
  `contextual` must read the time or the request context, and `sensitive` must read how the person authenticated; no other kind may read either.
- **Limits:** at most 32 actions, 32 attributes, 64 condition nodes (operands count), depth 8, 16 children per `all`/`any`, 16
  feature/permission lookups, literals of 256 characters or 100 items, 16 KB per definition, 200 active policies per organization,
  and a budget of 20,000 evaluation steps per decision. Unknown fields are errors.

### Where each attribute comes from

| Attribute | Source | Trust |
| --- | --- | --- |
| `subject.membershipId`, `subject.membershipStatus`, `subject.identity`, `subject.roleKeys` | the storage, for the identity being asked about | UNIORA |
| `subject.teamIds` | the storage: ACTIVE team memberships in ACTIVE teams only | UNIORA |
| `subject.managedTeamIds` | the storage: the same, only where the person is `owner` or `manager` of the team | UNIORA |
| `resource.teamPathIds` | the team tree: `resource.teamIds` plus every ancestor of those teams, read at decision time | UNIORA (from the teams your server states) |
| `resource.id`, `resource.teamIds`, `resource.<declared>` | **your server code**, when it calls `authorize({ resource })` | your server |
| `feature`, `permission` | the storage and the engine, per request | UNIORA |
| `environment.*` (`hour`, `dayOfWeek`...) | the engine's own clock, in the policy's `timezone`; the caller cannot supply it | UNIORA |
| `context.<name>` | **your server code**, when it calls `authorize({ context })`, for the signals the policy declares | your server |
| `session.*` (`authAgeSeconds`, `mfa`...) | **your server's authentication**, when it calls `authorize({ session })`; UNIORA computes the ages with its own clock | your server |
| `request.*` | reserved for a later phase; refused today | n/a |

Never build `resource` from what the client sent. Load the resource from your own database on the server and pass what you read; a
policy is only as trustworthy as the facts it is given. A resource must carry its `organizationId`, which the engine compares with
the organization of the request before anything else.

## Teams

Teams give context; they never give access. The rules are explicit, not assumed:

- A person in several teams: `subject.teamIds` lists all of them; `intersects` means "any team in common".
- A resource in several teams: `resource.teamIds` is a list; same rule.
- A resource with no team: pass `teamIds: []`. That is a fact ("none") and nothing intersects with it. Omitting `teamIds` is *unknown*
  and the policy is indeterminate.
- An archived team, or a team membership that is pending, suspended or removed, is not in `subject.teamIds`.
- A suspended or blocked organization membership fails the mandatory checks.
- Being in a team grants nothing: the permission still has to come from a role.
- Hierarchy is opt-in, per policy (next section). Without it nothing is inherited: `subject.teamIds` is the teams the person belongs to,
  not their sub-teams or parents.

### Hierarchies and scope inheritance

Teams can be nested (`parentId`, up to 8 levels, no cycles). A policy reaches the tree through two attributes and nothing else:

- `subject.managedTeamIds`: the teams the person **leads** (an active `owner` or `manager` of an active team).
- `resource.teamPathIds`: the teams the resource belongs to **plus all their ancestors**.

"A leader reaches everything below their team" is then one line, and it is read from the tree at the moment of the decision, so
moving a team, changing a responsibility or suspending a leader applies to the next decision with no cache to invalidate:

```jsonc
{
  "kind": "scope", "effect": "require", "actions": ["vehicles.update"], "resourceType": "vehicle",
  "condition": { "any": [
    { "intersects": [{ "ref": "subject.teamIds" },        { "ref": "resource.teamIds" }] },       // my own team
    { "intersects": [{ "ref": "subject.managedTeamIds" }, { "ref": "resource.teamPathIds" }] }    // a team I lead, above the resource
  ] }
}
```

Use `subject.teamIds` instead of `subject.managedTeamIds` for "anyone in a team above the resource". The attribute is walked **up** from
the resource (a bounded recursive query by primary key), not down from the person, so a regional manager with ten thousand
sub-teams costs the same as anybody else. Roles are never inherited: a team still gives context, not access. If the tree cannot be read,
or the resource lists more than 50 teams, `resource.teamPathIds` is *unknown* and the policy is indeterminate (a refusal), never a guess.
Team ids of another organization are ignored.

## Time and context

A `contextual` policy depends on **when** or **in what circumstances** the request happens. Two sources, both server-side:

- **`environment.*` is the engine's clock.** It is read when the decision is made and expressed in the policy's `timezone` (an IANA name such as
  `Europe/Madrid`; default `UTC`; offsets like `+02:00` are refused because they do not follow daylight saving). Attributes, all numbers:
  `epochSeconds` (an absolute moment, whatever the timezone), `year`, `month` (1-12), `dayOfMonth`, `dayOfWeek` (1 Monday to 7 Sunday),
  `hour` (0-23), `minuteOfDay` (0-1439, so "from 08:00" is `gte 480`) and `dateNumber` (`20261231`, so a date compares with `lt`/`gte`).
  No request can carry the time: `authorize({ now })` or `{ environment }` are ignored.
- **`context.<name>` is a signal your server verified**, declared in the policy's `context` field with its type and passed in
  `authorize({ context: { ipCountry: "ES" } })`. Derive it from something you trust (your proxy's verified client address, your device
  management, your session), never copy a header or a body field. Only the signals the applicable policies declare are read.

```jsonc
{
  "kind": "contextual", "effect": "require", "actions": ["vehicles.delete"],
  "timezone": "Europe/Madrid",
  "context": { "ipCountry": "string" },
  "condition": { "all": [
    { "gte": [{ "ref": "environment.dayOfWeek" },  { "value": 1 }] },  { "lte": [{ "ref": "environment.dayOfWeek" },  { "value": 5 }] },
    { "gte": [{ "ref": "environment.minuteOfDay" }, { "value": 480 }] }, { "lt":  [{ "ref": "environment.minuteOfDay" }, { "value": 1080 }] },
    { "in": [{ "ref": "context.ipCountry" }, { "value": ["ES", "PT"] }] }
  ] },
  "denyReason": "outside_business_hours"
}
```

If the clock cannot be read, or a signal is missing or has the wrong type, the policy is **indeterminate** (`environment_unavailable`,
`attribute_missing`, `attribute_type_mismatch`) and the request is refused: absence of a signal is never "all clear". Use `exists` on a signal
when absence is a case you want to handle on purpose. A contextual policy may also read `subject.*` and `resource.*`, so "nobody edits a locked
vehicle outside office hours" is one policy. The decision records the policies and their results, never the values of the signals.

**Testing and simulation.** `createAuthorizationEngine(storage, { policies: { now: () => new Date(...) } })` fixes the clock in tests. The policy
service's `simulate` accepts `at` (an instant) and `context`, so you can ask "what happens on Saturday at 22:00 from Portugal?" before
activating. Time zones come from the runtime's timezone database: keep Node's up to date, because two hosts with different database versions can
disagree around a daylight-saving change.

## Sensitive actions and step-up

A `sensitive` policy protects an action by **how strongly the person authenticated**: "refunds need a sign-in from the last five minutes with a
second factor", "deleting a key needs a hardware key". UNIORA does not authenticate anybody, so it cannot check any of this itself: your server
states it from the verified session or token, and the policy decides on that. It complements your own step-up flow; it never replaces it.

```ts
const result = await engine.authorize({
  identity, organizationId, permission: "payments.refund",
  session: {
    authenticatedAt: new Date(claims.auth_time * 1000),   // the LAST sign-in or step-up, as a Date (auth_time is in seconds)
    mfa: claims.amr.includes("mfa"),
    methods: claims.amr,                                    // up to 16 names: "pwd", "otp", "webauthn"...
    assuranceLevel: 2,                                      // optional integer 0-100; what each number means is yours
  },
});
if (result.stepUp) return redirectToReauthentication();     // see below
if (!result.allowed) return forbidden();
```

```jsonc
{
  "kind": "sensitive", "effect": "require", "actions": ["payments.refund"],
  "condition": { "all": [
    { "lte": [{ "ref": "session.authAgeSeconds" }, { "value": 300 }] },
    { "eq":  [{ "ref": "session.mfa" },            { "value": true }] }
  ] },
  "denyReason": "step_up_required"
}
```

- **Attributes** (`session.*`): `authAgeSeconds` (since `authenticatedAt`), `ageSeconds` (since `startedAt`), `mfa`, `assuranceLevel`, `methods`.
  The ages are computed by the engine's clock, never taken from the host. A date more than a minute in the future is not believed (the
  attribute is unknown); a little skew is tolerated.
- **Missing is not strong.** If your server does not say something a policy needs, that policy is indeterminate (`session_unavailable`) and
  the request is refused. A `session` that is not plain data (wrong types, unknown fields, a getter, text instead of a `Date`) is
  `malformed_input`, a deny.
- **`result.stepUp`** is present when the refusal comes **only** from sensitive policies that more recent or stronger authentication could
  satisfy: `{ policyKeys: [...] }`. Send the person to your step-up flow, then ask again with the new `session`. It is a hint, not a promise
  (the answer can still be no), it is absent when anything else also refuses, when the engine's clock failed, or for a policy that cannot be
  evaluated; and the keys are for your logs, not for the end user. It never appears on an allow.
- **Audit:** the decision record names the policies, their kind and the `stepUp` keys; it never contains the session values.
- `simulate` takes a `session` too (in JSON, `authenticatedAt` and `startedAt` as ISO-8601 text).

## Lifecycle and versions

`draft` → `active` ⇄ `disabled` → `retired` (terminal).

- **draft**: being written, never evaluated, deletable.
- **active**: evaluated. **disabled**: not evaluated, can be activated again. Disabling and enabling are audited.
- **retired**: never evaluated again, never reactivated, kept for the record; its key is not reused. A draft that was never active is
  deleted instead of retired.
- The **definition is versioned**: every change creates an immutable *revision* (1, 2, 3, ...) with the SHA-256 of its canonical
  JSON. Revisions are append-only (the databases refuse updates and deletes). Name and description are metadata and do not create
  revisions.
- Every decision reports the policies it used with their `revision` and `definitionHash`, so a decision can be reproduced later.
- `version` is the optimistic-concurrency counter of the row (`expectedVersion`), as everywhere in UNIORA.

## Failure behaviour

`authorize` does not throw for a problem while deciding. A storage error, a stored definition that no longer validates, a missing
dependency, an exhausted budget: the answer is `indeterminate` with a stable `reason`, never an allow. Malformed input (an empty
permission, a resource without `organizationId`) is a deny.

## Audit and explainability

The result lists the applicable policies and what each said (`key`, `revision`, `definitionHash`, `effect`, `result`, `reason`),
the policy-set `policyRevision`, and a stable `reason` code. It never contains attribute values. Pass `onDecision` (or the decision
auditor) to keep a trail: denied and indeterminate decisions are the ones worth keeping by default. Every change of a policy is
recorded in the audit log with the actor, in the same transaction as the change.

## Cache

Policy definitions are cached per organization against the **policy-set revision**, a number the database changes in the same
transaction as any policy change. It comes from one counter shared by all organizations, so it is never handed out twice (not even
to an organization deleted and created again under the same id): it goes up, but it is not consecutive, so compare it with `===`
and never count with it. The engine reads the number on every decision, so a change, a disable or a retirement is seen by
every process on the next decision; a stale cache can never revive a disabled or retired policy. Decisions themselves are not
cached by UNIORA; if you cache them, key them on `policyRevision` plus whatever else your answer depends on, and keep the lifetime short.

## Designed, not implemented (later phases)

- **Platform baseline policies** that apply to every organization, administered from the platform scope.

## Using it in your application

**1. Decide with roles and policies together.**

```ts
const engine = createAuthorizationEngine(storage);

const vehicle = await db.vehicles.find(id);                     // load it on the server, from your own database
const result = await engine.authorize({
  identity,                                                     // who is asking (from your session)
  organizationId,
  permission: "vehicles.update",
  resource: { type: "vehicle", id: vehicle.id, organizationId: vehicle.organizationId, teamIds: vehicle.teamIds, attributes: { status: vehicle.status } },
});
if (!result.allowed) return forbidden();                        // deny AND indeterminate both end here
```

`authorize` never throws. Keep using `engine.can()` where no policy is involved; nothing changes for existing code.

**2. Guard routes.** `@uniora/express`: `authorizeResource(engine, { permission, resolve })`. `@uniora/next`: `assertAuthorized(engine, input)`
(throws `PolicyDeniedError`) or `authorizeResourceRoute(engine, input)` (returns a 403 `Response` or `null`). Neither sends the policies
or the reason to the client; log `result` on the server instead.

**3. Administer policies.** `createPolicyService({ storage })` checks `policies.read`, `policies.manage` and `policies.activate`
(register them and give them to the right roles; names are configurable) and writes the audit trail. Mount it with
`policyCommand(service, { command, resolve })` (Express) or `policyCommandRoute(service, { command, caller, params })` (Next), one route
per command: `createPolicy`, `updatePolicy`, `activatePolicy`, `disablePolicy`, `retirePolicy`, `deletePolicy`, `getPolicy`,
`listPolicies`, `listRevisions`, `validatePolicy`, `simulate`. The caller and the organization come from your session, never from the
body, and unknown fields are rejected. Authoring and publishing can be given to different people (`policies.manage` versus
`policies.activate`), and `requireSeparateActivator: true` makes the author unable to activate their own revision.

**4. Try before you publish.** `simulate` answers "what would be decided for this person on this resource?", optionally with a candidate
definition that replaces a policy (or is added as one more) without saving anything. `validatePolicy` checks a definition and reports
what it reads.

**5. Keep a trail of decisions** (optional). `createPolicyDecisionAuditor(storage, { record: "denied" })` writes
`policy.decision_denied` / `policy.decision_indeterminate` entries (with the policy keys, revisions and hashes, never attribute values)
from `onDecision`.

## Studio

The organization page has a **Policies** tab, read only: the list (search and status filter, keyset paging), and for each policy its
definition, status, hash and the revision history. Studio is an operator tool without your application's roles, so it shows what is
enforced; changes go through the policy service of your application.

## Storage

Policies live in `storage.policies` (memory, SQLite, PostgreSQL), all held to the same conformance suite.

- **Isolation by construction.** Every method takes the organization id and treats a policy of another organization like one that does
  not exist. In the databases, `policy_revisions` references its policy through a composite key that includes `organization_id`, and
  the policy points at its current revision with another one, so a revision can never be attached to a policy of another organization.
- **Writes need an authorization.** Like Teams, every write of `storage.policies` demands a short-lived (60 s) `PolicyAuthorization`
  bound to the organization, the actor and the operation. `createPolicyService` issues it after asking the authorization engine;
  `createTrustedPolicyStorage` is the audited back-office route (imports, sync jobs, tests) and must never serve end-user requests.
- **The database enforces the lifecycle too**, with triggers: a retired policy cannot change, only legal status moves are accepted,
  `activated_at` is set once, a policy that was ever active cannot be deleted, `version` goes up by one per change, revisions are
  immutable (no update, no delete) and the definition on the policy row must equal its current revision. Limits are enforced as well:
  1000 policies per organization, 200 active, 1000 revisions per policy. Concurrent activations at the limit are serialised (an
  advisory lock on PostgreSQL, the single writer on SQLite) so exactly one of two wins.
- **Limits of that protection.** Someone who can disable triggers (PostgreSQL superuser, `session_replication_role = replica`) or
  rewrite the file (SQLite) can bypass them; the revision hash is computed by UNIORA, the database checks that it is consistent
  between the policy and its revision but cannot recompute it.
- **Performance.** A single organization has at most 1000 policies, and every query starts with `organization_id`, so each read is a
  short index range scan regardless of how many organizations or members exist. Measured with `EXPLAIN (ANALYZE)` on PostgreSQL with
  200,000 policies spread over 4,000 organizations: the active set (`policies_active_idx`), a search with filters and cursor, a lookup
  by key and the policy-set revision all use an index and finish in well under a millisecond. `subject.teamIds` is one indexed query
  (`team_memberships_member_idx`), capped at 500 teams.

## Status of this release

Phase 1 is built as a stack of changes. This section is updated by each.

- Definition language, validation and the pure evaluator (`parsePolicyDefinition`, `evaluatePolicy`, `evaluatePolicySet`): **done**.
- Storage (memory, SQLite migration 0025, PostgreSQL migration 0040), authorization tokens, service, engine integration
  (`engine.authorize`), audit (`policy.*` entries and the decision auditor): **done**.
- Commands, Express and Next routes and guards, Studio read-only tab: **done**.
- Internal red team: **done**, four findings fixed (policy writes pinned to the version that was checked, never-reused revision
  numbers, own-property attribute lookups, server-generated policy ids in the command door). Report:
  `uniora-policies/auditoria-policies.md` in the project files. Released in 0.7.0 (migrations PostgreSQL 0040–0041, SQLite 0025–0026).
