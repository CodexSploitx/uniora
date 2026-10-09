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
  "kind": "scope",                    // access | resource | scope | feature  (contextual, sensitive: designed, not available yet)
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
  person with something about the resource; `feature` must ask for a feature; `access` does not read the resource's state.
- **Limits:** at most 32 actions, 32 attributes, 64 condition nodes (operands count), depth 8, 16 children per `all`/`any`, 16
  feature/permission lookups, literals of 256 characters or 100 items, 16 KB per definition, 200 active policies per organization,
  and a budget of 20,000 evaluation steps per decision. Unknown fields are errors.

### Where each attribute comes from

| Attribute | Source | Trust |
| --- | --- | --- |
| `subject.membershipId`, `subject.membershipStatus`, `subject.identity`, `subject.roleKeys` | the storage, for the identity being asked about | UNIORA |
| `subject.teamIds` | the storage: ACTIVE team memberships in ACTIVE teams only | UNIORA |
| `resource.id`, `resource.teamIds`, `resource.<declared>` | **your server code**, when it calls `authorize({ resource })` | your server |
| `feature`, `permission` | the storage and the engine, per request | UNIORA |
| `environment.*`, `context.*`, `request.*`, `session.*` | reserved for later phases; refused today | n/a |

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
- Hierarchy: phase 1 does not inherit anything. `subject.teamIds` is the teams the person belongs to, not their sub-teams or parents.

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

Policy definitions are cached per organization against the **policy-set revision**, a counter the database bumps in the same
transaction as any policy change. The engine reads the counter on every decision, so a change, a disable or a retirement is seen by
every process on the next decision; a stale cache can never revive a disabled or retired policy. Decisions themselves are not
cached by UNIORA; if you cache them, key them on `policyRevision` plus whatever else your answer depends on, and keep the lifetime short.

## Designed, not implemented (later phases)

- **Hierarchies with scope inheritance.** An explicit attribute such as `subject.teamTreeIds` (the sub-teams of the teams where the
  person is owner or manager), opted into per policy. Teams already forbid cycles and cap depth at 8; decisions would additionally
  record a team-structure revision so a reparenting invalidates them.
- **Contextual and temporal conditions.** The `environment.*` namespace, fed only by a trusted server-side provider (the engine's
  clock, a risk signal your server verified), typed, with `indeterminate` when the provider fails.
- **Sensitive-action policies.** The `sensitive` kind with requirements such as "recent re-authentication", fed by the host's
  authentication through `environment.*`; they complement, never replace, the host's own step-up flow.
- **Platform baseline policies** that apply to every organization, administered from the platform scope.

## Status of this release

Phase 1 is built as a stack of changes. This section is updated by each.

- Definition language, validation and the pure evaluator (`parsePolicyDefinition`, `evaluatePolicy`, `evaluatePolicySet`): **done**.
- Storage (memory, SQLite, PostgreSQL), authorization tokens, service, engine integration, audit: in progress.
