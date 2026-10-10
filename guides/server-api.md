# The UNIORA API reference

> Generated from the route table of `@uniora/server` and from a run against a real server. Do not edit by hand:
> `UPDATE_DOCS=1 pnpm --filter @uniora/server test` regenerates it, and a test fails when it is out of date. Every example below
> was executed; the response shown is what the server answered. The machine-readable contract is [`openapi.json`](openapi.json).
> How to run the server and the flows end to end are in the [server guide](server.md).

## Conventions

- **Transport.** HTTPS and JSON. Send `Content-Type: application/json` on anything with a body. Paths live under `/v1`. Plain HTTP is only for a server on the same machine.
- **Authentication.** `Authorization: Bearer uniora_sk_…` on every call under `/v1`. A key belongs to an **API client**, which has **scopes** and a list of **organizations**; a call outside them is refused. Keys are created in Studio or with `uniora server keys create`: there is no route that creates or changes one.
- **Application and delegated calls.** An application call is your backend asking as itself (decisions, reads, creating an organization). A **delegated** call changes things on behalf of an end user, who travels in `Uniora-Actor-Subject` (percent-encoded) and, if the server has no default label, `Uniora-Actor-Provider`. It needs the `actor:assert` scope too, and it succeeds only if that user may do it: a key can never do more than the user it speaks for. Never copy the actor from what the end user sent.
- **Identities.** `{ "subject": "…" }` is the user's id in your auth provider. `provider` is an opaque label you choose (it does not have to name your vendor); leave it out and the server's default label is used. The labels `uniora-api`, `uniora-studio`, `uniora-cli` and `uniora-platform` are reserved.
- **Versions.** Resources that change carry a `version`. It is also the `ETag` (quoted). Send it back as `If-Match` to refuse an edit made from a stale copy (`412`).
- **Idempotency.** Operations that create something accept `Idempotency-Key` (1–128 letters, digits and `._:-`). The same key with the same request answers the first result and does nothing again; the same key with a different request is refused. Keys are per API client.
- **Pagination.** Lists answer `{ "items": [...], "nextCursor": "…" | null }`. Pass `nextCursor` back as `cursor`. `limit` is at most 100. A cursor is opaque and only names a position.
- **Dates** are RFC 3339 in UTC.
- **Request ids.** Every answer has a `Request-Id` header and every error body a `requestId`; the detail of a failure is in the server's log under it.

## Errors <a id="errors"></a>

Errors are `application/problem+json` (RFC 9457):

```json
{
  "type": "urn:uniora:error:forbidden",
  "title": "Forbidden",
  "status": 403,
  "code": "forbidden",
  "requestId": "req_xxxxxxxxxxxxxxx1"
}
```

`code` is stable and only ever added: branch on it, never on `title`. **No internal message is ever returned**: a message can name an identity or an organization, and your backend may forward errors to a browser. A `403` never says why. On `400 invalid_request` the body also lists `errors: [{ "path", "code" }]`: where the input is wrong and why, never the value.

| Status | `code` | Meaning |
| --- | --- | --- |
| 400 | `invalid_request`, `invalid_json`, `unexpected_body`, `invalid_cursor` | The request is not acceptable. Unknown fields are refused, not ignored. |
| 400 | `actor_required`, `identity_provider_required`, `identity_provider_reserved` | A delegated call without a usable actor, or an identity with no provider label and no server default. |
| 401 | `unauthenticated` | No key, or one that is not valid: unknown, wrong, revoked, expired and disabled all answer the same. |
| 403 | `forbidden` | The client lacks the scope, the end user lacks the permission, or the target is out of reach. Never says which. |
| 403 | `access_self_change`, `access_escalation`, `access_target_stronger`, `access_owner_protected` | One of the four anti-escalation rules stopped a user who had the permission. |
| 404 | `organization_not_found` and the `*_not_found` of each resource | An organization outside the client's list answers exactly like one that does not exist. |
| 409 | `*_exists`, `last_owner`, `idempotency_in_progress`… | A conflict with the current state. |
| 412 | `*_version_conflict` | `If-Match` named a version that is no longer current. |
| 413, 415 | `body_too_large`, `unsupported_media_type` | Bodies are at most 64 KB and must be JSON. |
| 422 | `idempotency_key_reused` | The key was used for a different request. |
| 429 | `rate_limited` | Too many requests, per key or per source after failed authentications. `Retry-After` says when. |
| 500 | `internal_error` | A bug or a failure of the server. Nothing was exposed; quote the `requestId`. |
| 501 | `actor_token_unsupported`, `invitations_not_configured` | Not available in this deployment. |
| 503 | `overloaded`, `timeout`, `unavailable`, `read_only` | The server cannot take this now. `Retry-After` when it knows. |

## Scopes

| Scope | Allows |
| --- | --- |
| `check` | Ask whether an identity may do something (can, authorize, access checks, snapshots). |
| `organizations:read` | Read organizations, members, roles, permissions, features, teams and policies. |
| `organizations:create` | Create an organization together with its first Owner. |
| `members:write` | Assign and remove roles, block, suspend and remove members, on behalf of a user. **Sensitive.** |
| `roles:write` | Create, edit and delete roles and their permissions, on behalf of a user. **Sensitive.** |
| `teams:write` | Manage teams and their members, on behalf of a user. **Sensitive.** |
| `policies:write` | Manage an organization's policies, on behalf of a user. **Sensitive.** |
| `invitations:write` | Invite, resend and revoke invitations, on behalf of a user. **Sensitive.** |
| `audit:read` | Read an organization's audit log. |
| `actor:assert` | Act on behalf of an end user. A key with this scope can speak for ANY user of its organizations. **Sensitive.** |

## Operations

- **Decisions**
  - [`POST /v1/check`](#decisions-check): May this identity do this?
  - [`POST /v1/check:batch`](#decisions-checkbatch): Several questions about one identity in one round trip
  - [`POST /v1/authorize`](#decisions-authorize): The full decision, with the organization's policies
  - [`POST /v1/snapshots`](#decisions-snapshot): A bounded set of decisions for a UI, in one call
- **Organizations**
  - [`GET /v1/organizations`](#organizations-list): List organizations
  - [`GET /v1/organizations/:organizationId`](#organizations-get): Get an organization
  - [`GET /v1/organizations/:organizationId/features`](#organizations-features): What an organization has unlocked
  - [`POST /v1/organizations`](#organizations-create): Create an organization with its first Owner
- **Members**
  - [`GET /v1/organizations/:organizationId/members`](#members-list): List an organization's members
  - [`GET /v1/organizations/:organizationId/members/:membershipId`](#members-get): Get a member
  - [`PUT /v1/organizations/:organizationId/members/:membershipId/roles/:roleId`](#members-assignrole): Give a member a role
  - [`DELETE /v1/organizations/:organizationId/members/:membershipId/roles/:roleId`](#members-unassignrole): Take a role away from a member
  - [`POST /v1/organizations/:organizationId/members/:membershipId/block`](#members-block): Block a member
  - [`POST /v1/organizations/:organizationId/members/:membershipId/suspend`](#members-suspend): Suspend a member until a date
  - [`POST /v1/organizations/:organizationId/members/:membershipId/unblock`](#members-unblock): Lift a block or a suspension
  - [`DELETE /v1/organizations/:organizationId/members/:membershipId`](#members-remove): Remove a member from the organization
- **Roles**
  - [`GET /v1/organizations/:organizationId/roles`](#roles-list): List an organization's roles
  - [`GET /v1/organizations/:organizationId/roles/:roleId/permissions`](#roles-permissions): List the permissions a role grants
  - [`POST /v1/organizations/:organizationId/roles`](#roles-create): Create a role
  - [`PATCH /v1/organizations/:organizationId/roles/:roleId`](#roles-update): Rename a role or change its description
  - [`PUT /v1/organizations/:organizationId/roles/:roleId/permissions`](#roles-setpermissions): Make a role hold exactly these permissions
  - [`PUT /v1/organizations/:organizationId/roles/:roleId/permissions/:permissionKey`](#roles-grantpermission): Add one permission to a role
  - [`DELETE /v1/organizations/:organizationId/roles/:roleId/permissions/:permissionKey`](#roles-revokepermission): Take one permission away from a role
  - [`POST /v1/organizations/:organizationId/roles/:roleId/clone`](#roles-clone): Copy a role under a new name
  - [`DELETE /v1/organizations/:organizationId/roles/:roleId`](#roles-delete): Delete a role
- **Catalog**
  - [`GET /v1/permissions`](#permissions-list): The permission catalog
  - [`GET /v1/features`](#features-list): The feature catalog
- **Teams**
  - [`GET /v1/organizations/:organizationId/teams`](#teams-list): List an organization's teams
  - [`GET /v1/organizations/:organizationId/teams/:teamId`](#teams-get): Get a team
  - [`GET /v1/organizations/:organizationId/teams/:teamId/members`](#teams-members): List the members of a team
  - [`POST /v1/organizations/:organizationId/teams`](#teams-create): Create a team
  - [`PATCH /v1/organizations/:organizationId/teams/:teamId`](#teams-update): Edit a team
  - [`POST /v1/organizations/:organizationId/teams/:teamId/archive`](#teams-archive): Archive a team
  - [`POST /v1/organizations/:organizationId/teams/:teamId/restore`](#teams-restore): Restore an archived team
  - [`DELETE /v1/organizations/:organizationId/teams/:teamId`](#teams-delete): Delete a team
  - [`POST /v1/organizations/:organizationId/teams/:teamId/members`](#teams-addmember): Add a member to a team, or invite them
  - [`POST /v1/organizations/:organizationId/teams/:teamId/leave`](#teams-leave): The actor leaves a team, or declines an invitation
  - [`POST /v1/organizations/:organizationId/team-memberships/:teamMembershipId/accept`](#teammembers-accept): Accept a team invitation
  - [`DELETE /v1/organizations/:organizationId/team-memberships/:teamMembershipId`](#teammembers-remove): Remove someone from a team
  - [`POST /v1/organizations/:organizationId/team-memberships/:teamMembershipId/suspend`](#teammembers-suspend): Suspend a team membership
  - [`POST /v1/organizations/:organizationId/team-memberships/:teamMembershipId/reactivate`](#teammembers-reactivate): Lift a team suspension
  - [`PUT /v1/organizations/:organizationId/team-memberships/:teamMembershipId/responsibility`](#teammembers-setresponsibility): Set who looks after a team
  - [`PUT /v1/organizations/:organizationId/team-memberships/:teamMembershipId/roles/:roleId`](#teammembers-assignrole): Give a team member a role inside the team
  - [`DELETE /v1/organizations/:organizationId/team-memberships/:teamMembershipId/roles/:roleId`](#teammembers-unassignrole): Take a role away from a team member
  - [`POST /v1/organizations/:organizationId/team-moves`](#teammembers-move): Move a member from one team to another
- **Policies**
  - [`GET /v1/organizations/:organizationId/policies`](#policies-list): List an organization's policies
  - [`GET /v1/organizations/:organizationId/policies/:policyId`](#policies-get): Get a policy
  - [`GET /v1/organizations/:organizationId/policies/:policyId/revisions`](#policies-revisions): The history of a policy's definition
  - [`POST /v1/organizations/:organizationId/policies`](#policies-create): Create a policy as a draft
  - [`PATCH /v1/organizations/:organizationId/policies/:policyId`](#policies-update): Edit a policy
  - [`POST /v1/organizations/:organizationId/policies/:policyId/activate`](#policies-activate): Put a policy live
  - [`POST /v1/organizations/:organizationId/policies/:policyId/disable`](#policies-disable): Switch a policy off
  - [`POST /v1/organizations/:organizationId/policies/:policyId/retire`](#policies-retire): Retire a policy for good
  - [`DELETE /v1/organizations/:organizationId/policies/:policyId`](#policies-delete): Delete a draft
  - [`POST /v1/organizations/:organizationId/policy-validations`](#policies-validate): Check a definition without saving it
  - [`POST /v1/organizations/:organizationId/policy-simulations`](#policies-simulate): What would be decided?
- **Invitations**
  - [`POST /v1/organizations/:organizationId/invitations`](#invitations-create): Invite someone by e-mail
  - [`POST /v1/organizations/:organizationId/invitations/:invitationId/resend`](#invitations-resend): Send an invitation again
  - [`DELETE /v1/organizations/:organizationId/invitations/:invitationId`](#invitations-revoke): Revoke an invitation
  - [`POST /v1/invitations/preview`](#invitations-preview): What an accept page may show before sign-in
  - [`POST /v1/invitations/accept`](#invitations-accept): Accept an invitation as the person who just signed in
- **Audit log**
  - [`GET /v1/organizations/:organizationId/audit-log`](#audit-list): An organization's audit log

## Decisions

Ask whether a user may do something. Application calls: your backend asks about any user.

### `POST /v1/check`  <a id="decisions-check"></a>

**May this identity do this?** · operation `decisions.check`

Answers with the role-based decision of the engine: whether the identity holds the permission in the organization (and, if asked, whether the organization has the feature enabled). Anything the engine cannot justify is `false`; an unknown organization, a non-member and a malformed key all answer `false` the same way. Policies are not applied here: use `authorize` for that.

- **Scope:** `check`
- **Kind:** application (your backend asks as itself)
- **Changes data:** no

**Request**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `identity` | object | yes | Who the question is about. |
| `identity.provider` | string (1–64 chars) | no | An opaque label for the auth system the subject belongs to (not necessarily its vendor name). Omit it to use the server's default label. |
| `identity.subject` | string (1–500 chars) | yes | The user's stable id in your auth provider. Never an e-mail address. |
| `organizationId` | string (1–200 chars) | yes | The organization the question is about. |
| `permission` | string (1–200 chars) | no | The permission the identity needs. |
| `feature` | string (1–200 chars) | no | The feature the organization needs enabled. |
| `teamId` | string (1–200 chars) | no | Ask inside this team: it can only narrow the answer. |

**Response `200`**

| Field | Type | Description |
| --- | --- | --- |
| `allowed` | boolean | `true` only when every part of the question holds. |

**Errors of this operation** (besides the ones every call can meet: see [Errors](#errors))

- `400` `identity_provider_required`
- `400` `identity_provider_reserved`
- `404` `organization_not_found`

**Example: May Ana read reports?**

```bash
curl -X POST "https://uniora.example.com/v1/check" \
  -H "Authorization: Bearer $UNIORA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "identity": {
      "subject": "ana"
    },
    "organizationId": "org_acme",
    "permission": "reports.read"
  }'
```

```ts
const result = await uniora.decisions.check(
  {
    identity: { subject: "ana" },
    organizationId: "org_acme",
    permission: "reports.read",
  },
);
```

```http
HTTP/1.1 200 OK

{
  "allowed": true
}
```

**Example: A member without the permission**

```bash
curl -X POST "https://uniora.example.com/v1/check" \
  -H "Authorization: Bearer $UNIORA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "identity": {
      "subject": "bob"
    },
    "organizationId": "org_acme",
    "permission": "reports.read"
  }'
```

```ts
const result = await uniora.decisions.check(
  {
    identity: { subject: "bob" },
    organizationId: "org_acme",
    permission: "reports.read",
  },
);
```

```http
HTTP/1.1 200 OK

{
  "allowed": false
}
```

**Example: A malformed question is refused, not guessed**

```bash
curl -X POST "https://uniora.example.com/v1/check" \
  -H "Authorization: Bearer $UNIORA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "identity": {
      "subject": "ana"
    },
    "organizationId": "org_acme"
  }'
```

```ts
await uniora.decisions.check({ identity: { subject: "ana" }, organizationId: "org_acme" });
```

```http
HTTP/1.1 400 Bad Request

{
  "type": "urn:uniora:error:invalid_request",
  "title": "Bad Request",
  "status": 400,
  "code": "invalid_request",
  "requestId": "req_xxxxxxxxxxxxxxx2",
  "errors": [
    {
      "path": "permission",
      "code": "required"
    }
  ]
}
```

### `POST /v1/check:batch`  <a id="decisions-checkbatch"></a>

**Several questions about one identity in one round trip** · operation `decisions.checkBatch`

Each check is evaluated independently, in the order given, and the answers come back in the same order. Use it to render a whole screen in one call. A malformed check answers `false` for that entry only.

- **Scope:** `check`
- **Kind:** application (your backend asks as itself)
- **Changes data:** no

**Request**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `identity` | object | yes | Who the question is about. |
| `identity.provider` | string (1–64 chars) | no | An opaque label for the auth system the subject belongs to (not necessarily its vendor name). Omit it to use the server's default label. |
| `identity.subject` | string (1–500 chars) | yes | The user's stable id in your auth provider. Never an e-mail address. |
| `organizationId` | string (1–200 chars) | yes | The organization the questions are about. |
| `checks` | array (≤ 1000) | yes | At most the server's batch limit (50 unless configured). |
| `checks[].permission` | string (1–200 chars) | no | The permission the identity needs. |
| `checks[].feature` | string (1–200 chars) | no | The feature the organization needs enabled. |
| `checks[].teamId` | string (1–200 chars) | no | Ask inside this team: it can only narrow the answer. |

**Response `200`**

| Field | Type | Description |
| --- | --- | --- |
| `results` | array (≤ 1000) |  |
| `results[].allowed` | boolean |  |

**Errors of this operation** (besides the ones every call can meet: see [Errors](#errors))

- `400` `identity_provider_required`
- `400` `identity_provider_reserved`
- `404` `organization_not_found`

**Example: Several questions in one round trip**

```bash
curl -X POST "https://uniora.example.com/v1/check:batch" \
  -H "Authorization: Bearer $UNIORA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "identity": {
      "subject": "ana"
    },
    "organizationId": "org_acme",
    "checks": [
      {
        "permission": "reports.read"
      },
      {
        "permission": "vehicles.delete"
      }
    ]
  }'
```

```ts
const result = await uniora.decisions.checkBatch(
  {
    identity: { subject: "ana" },
    organizationId: "org_acme",
    checks: [{ permission: "reports.read" }, { permission: "vehicles.delete" }],
  },
);
```

```http
HTTP/1.1 200 OK

{
  "results": [
    {
      "allowed": true
    },
    {
      "allowed": false
    }
  ]
}
```

### `POST /v1/authorize`  <a id="decisions-authorize"></a>

**The full decision, with the organization's policies** · operation `decisions.authorize`

Like `check`, and then the organization's policies are applied on top of the roles (they can only restrict). Pass what YOUR server knows: the resource, the signals about the request (`context`) and how the person authenticated (`session`). UNIORA cannot verify those, so never copy them from what the end user sent. The answer never throws: a failure while deciding is `allowed: false`. When the refusal comes only from policies that stronger or fresher authentication could satisfy, `stepUp` says so: send the person to your own sign-in flow and ask again.

- **Scope:** `check`
- **Kind:** application (your backend asks as itself)
- **Changes data:** no

**Request**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `identity` | object | yes | Who the question is about. |
| `identity.provider` | string (1–64 chars) | no | An opaque label for the auth system the subject belongs to (not necessarily its vendor name). Omit it to use the server's default label. |
| `identity.subject` | string (1–500 chars) | yes | The user's stable id in your auth provider. Never an e-mail address. |
| `organizationId` | string (1–200 chars) | yes | The organization the question is about. |
| `permission` | string (1–200 chars) | yes | The permission the identity needs. |
| `teamId` | string (1–200 chars) | no | Ask inside this team: it can only narrow the answer. |
| `resource` | object | no | The thing the question is about. |
| `resource.type` | string (1–64 chars) | yes | What kind of resource (`vehicle`, `ticket`): policies are matched on it. |
| `resource.id` | string (1–200 chars) | yes | The resource's id in your database. |
| `resource.organizationId` | string (1–200 chars) | yes | The organization the resource belongs to, as YOUR database says. A mismatch is `cross_tenant_resource`. |
| `resource.teamIds` | array (≤ 50) | no |  |
| `resource.attributes` | object (free keys) | no | The values of the attributes the policies declare (`status`, `ownerIdentity`...). |
| `context` | object (free keys) | no | Signals about the request that your server verified (`{ "ipCountry": "ES" }`). Only the ones a policy declares are used. |
| `session` | object | no | How the person authenticated, as your server's authentication states it. |
| `session.authenticatedAt` | string (date-time) | no | When the person last proved who they are (a sign-in or a step-up), NOT when the session began. |
| `session.startedAt` | string (date-time) | no | When the session began. |
| `session.mfa` | boolean | no | Whether a second factor was used. |
| `session.assuranceLevel` | integer (0–100) | no |  |
| `session.methods` | array (≤ 16) | no |  |
| `requireApplicablePolicy` | boolean | no | A protected operation: with no applicable policy the answer is deny. |

**Response `200`**

| Field | Type | Description |
| --- | --- | --- |
| `allowed` | boolean | Check this, not `decision`. |
| `decision` | `allow` \| `deny` \| `indeterminate` | Only `allow` lets the operation go on. |
| `reason` | `allowed` \| `malformed_input` \| `cross_tenant_resource` \| `organization_inactive` \| `membership_inactive` \| `permission_denied` \| `policy_denied` \| `policy_indeterminate` \| `no_applicable_policy` \| `evaluation_error` \| `policy_set_too_large` | Why. Stable codes; only ever added. |
| `via` | `membership` \| `support_grant`, may be absent | What granted the permission. |
| `policyRevision` | integer (0–…) or `null` | The revision of the organization's policy set that the decision used (`0` when it has no policies yet); `null` when the roles refused first, so no policy was consulted. Key any cache of decisions on it. |
| `stepUp` | object, may be absent | Present only when stronger or fresher authentication could change the answer. Do not echo the keys to the person. |
| `stepUp.policyKeys` | array (≤ 100) |  |
| `evaluatedAt` | string (date-time) |  |

**Errors of this operation** (besides the ones every call can meet: see [Errors](#errors))

- `400` `identity_provider_required`
- `400` `identity_provider_reserved`
- `404` `organization_not_found`

**Example: The full decision, with a resource of the organization**

```bash
curl -X POST "https://uniora.example.com/v1/authorize" \
  -H "Authorization: Bearer $UNIORA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "identity": {
      "subject": "ana"
    },
    "organizationId": "org_acme",
    "permission": "reports.read",
    "resource": {
      "type": "report",
      "id": "rep_42",
      "organizationId": "org_acme"
    }
  }'
```

```ts
const result = await uniora.decisions.authorize(
  {
    identity: { subject: "ana" },
    organizationId: "org_acme",
    permission: "reports.read",
    resource: { type: "report", id: "rep_42", organizationId: "org_acme" },
  },
);
```

```http
HTTP/1.1 200 OK

{
  "allowed": true,
  "decision": "allow",
  "reason": "allowed",
  "via": "membership",
  "policyRevision": 0,
  "evaluatedAt": "2026-03-02T09:00:00.000Z"
}
```

**Example: A resource of ANOTHER organization is never allowed**

```bash
curl -X POST "https://uniora.example.com/v1/authorize" \
  -H "Authorization: Bearer $UNIORA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "identity": {
      "subject": "ana"
    },
    "organizationId": "org_acme",
    "permission": "reports.read",
    "resource": {
      "type": "report",
      "id": "rep_99",
      "organizationId": "org_globex"
    }
  }'
```

```ts
const result = await uniora.decisions.authorize(
  {
    identity: { subject: "ana" },
    organizationId: "org_acme",
    permission: "reports.read",
    resource: { type: "report", id: "rep_99", organizationId: "org_globex" },
  },
);
```

```http
HTTP/1.1 200 OK

{
  "allowed": false,
  "decision": "deny",
  "reason": "cross_tenant_resource",
  "policyRevision": null,
  "evaluatedAt": "2026-03-02T09:01:00.000Z"
}
```

**Example: From now on the policy decides**

```bash
curl -X POST "https://uniora.example.com/v1/authorize" \
  -H "Authorization: Bearer $UNIORA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "identity": {
      "subject": "ana"
    },
    "organizationId": "org_acme",
    "permission": "reports.read"
  }'
```

```ts
const result = await uniora.decisions.authorize(
  {
    identity: { subject: "ana" },
    organizationId: "org_acme",
    permission: "reports.read",
  },
);
```

```http
HTTP/1.1 200 OK

{
  "allowed": false,
  "decision": "deny",
  "reason": "policy_denied",
  "via": "membership",
  "policyRevision": 4,
  "evaluatedAt": "2026-03-02T09:02:00.000Z"
}
```

### `POST /v1/snapshots`  <a id="decisions-snapshot"></a>

**A bounded set of decisions for a UI, in one call** · operation `decisions.snapshot`

Resolves exactly the permissions and features listed, for one identity in one organization. It is bounded on purpose: this is not "everything this person can do" (which is not even defined for an Owner). A key you did not list is absent, and a consumer must treat an absent key as denied. Safe to hand to client-side UI after your own server authorizes the request.

- **Scope:** `check`
- **Kind:** application (your backend asks as itself)
- **Changes data:** no

**Request**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `identity` | object | yes | Who the question is about. |
| `identity.provider` | string (1–64 chars) | no | An opaque label for the auth system the subject belongs to (not necessarily its vendor name). Omit it to use the server's default label. |
| `identity.subject` | string (1–500 chars) | yes | The user's stable id in your auth provider. Never an e-mail address. |
| `organizationId` | string (1–200 chars) | yes | The organization the snapshot is about. |
| `permissions` | array (≤ 100) | no |  |
| `features` | array (≤ 100) | no |  |

**Response `200`**

| Field | Type | Description |
| --- | --- | --- |
| `organizationId` | string (≤ 200 chars) |  |
| `permissions` | object (free keys) |  |
| `features` | object (free keys) |  |

**Errors of this operation** (besides the ones every call can meet: see [Errors](#errors))

- `400` `identity_provider_required`
- `400` `identity_provider_reserved`
- `404` `organization_not_found`

**Example: What a screen needs, in one call**

```bash
curl -X POST "https://uniora.example.com/v1/snapshots" \
  -H "Authorization: Bearer $UNIORA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "identity": {
      "subject": "ana"
    },
    "organizationId": "org_acme",
    "permissions": [
      "reports.read",
      "vehicles.delete"
    ],
    "features": [
      "advanced_reports"
    ]
  }'
```

```ts
const result = await uniora.decisions.snapshot(
  {
    identity: { subject: "ana" },
    organizationId: "org_acme",
    permissions: ["reports.read", "vehicles.delete"],
    features: ["advanced_reports"],
  },
);
```

```http
HTTP/1.1 200 OK

{
  "organizationId": "org_acme",
  "permissions": {
    "reports.read": true,
    "vehicles.delete": false
  },
  "features": {
    "advanced_reports": false
  }
}
```

## Organizations

Read organizations, and create one with its first Owner.

### `GET /v1/organizations`  <a id="organizations-list"></a>

**List organizations** · operation `organizations.list`

Only the organizations this API client may access: all of them for a client with the `*` allowlist, otherwise exactly the ones on its list. Ordered by creation time.

- **Scope:** `organizations:read`
- **Kind:** application (your backend asks as itself)
- **Changes data:** no

**Request**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `limit` | integer (1–1000) | no | (query) Items per page. At most the server's maximum (100 unless configured). |
| `cursor` | string (1–600 chars) | no | (query) The `nextCursor` of the previous page. |
| `q` | string (1–200 chars) | no | (query) Case-insensitive text to look for. |
| `status` | `active` \| `suspended` \| `archived` | no | (query) |

**Response `200`**

| Field | Type | Description |
| --- | --- | --- |
| `items` | array (≤ 1000) |  |
| `items[].id` | string (≤ 200 chars) |  |
| `items[].slug` | string (≤ 200 chars) |  |
| `items[].name` | string (≤ 200 chars) |  |
| `items[].status` | `active` \| `suspended` \| `archived` | `suspended` and `archived` organizations are denied every decision. |
| `items[].createdAt` | string (date-time) |  |
| `items[].version` | integer (1–…) |  |
| `nextCursor` | string (≤ 600 chars) or `null` | Pass it back as `cursor` for the next page; `null` on the last one. |

**Errors of this operation** (besides the ones every call can meet: see [Errors](#errors))

- `400` `invalid_cursor`
- `400` `invalid_request`

**Example: The organizations this client may reach**

```bash
curl -X GET "https://uniora.example.com/v1/organizations?limit=10" \
  -H "Authorization: Bearer $UNIORA_API_KEY"
```

```ts
const result = await uniora.organizations.list({ limit: 10 });
```

```http
HTTP/1.1 200 OK

{
  "items": [
    {
      "id": "org_acme",
      "slug": "acme",
      "name": "Acme",
      "status": "active",
      "createdAt": "2026-03-02T09:03:00.000Z",
      "version": 1
    },
    {
      "id": "org_globex",
      "slug": "globex",
      "name": "Globex",
      "status": "active",
      "createdAt": "2026-03-02T09:04:00.000Z",
      "version": 1
    }
  ],
  "nextCursor": null
}
```

**Example: A call with no key**

```bash
curl -X GET "https://uniora.example.com/v1/organizations"
```

```ts
await uniora.organizations.list();
```

```http
HTTP/1.1 401 Unauthorized

{
  "type": "urn:uniora:error:unauthenticated",
  "title": "Unauthorized",
  "status": 401,
  "code": "unauthenticated",
  "requestId": "req_xxxxxxxxxxxxxxx3"
}
```

### `GET /v1/organizations/:organizationId`  <a id="organizations-get"></a>

**Get an organization** · operation `organizations.get`

An organization outside this client's allowlist answers exactly like one that does not exist.

- **Scope:** `organizations:read`
- **Kind:** application (your backend asks as itself)
- **Changes data:** no

**Request**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `organizationId` | string (1–200 chars) | yes | (in the path) The organization. |

**Response `200`**

| Field | Type | Description |
| --- | --- | --- |
| `id` | string (≤ 200 chars) |  |
| `slug` | string (≤ 200 chars) |  |
| `name` | string (≤ 200 chars) |  |
| `status` | `active` \| `suspended` \| `archived` | `suspended` and `archived` organizations are denied every decision. |
| `createdAt` | string (date-time) |  |
| `version` | integer (1–…) |  |

**Errors of this operation** (besides the ones every call can meet: see [Errors](#errors))

- `404` `organization_not_found`

**Example: One organization**

```bash
curl -X GET "https://uniora.example.com/v1/organizations/org_acme" \
  -H "Authorization: Bearer $UNIORA_API_KEY"
```

```ts
const result = await uniora.organizations.get({ organizationId: "org_acme" });
```

```http
HTTP/1.1 200 OK

{
  "id": "org_acme",
  "slug": "acme",
  "name": "Acme",
  "status": "active",
  "createdAt": "2026-03-02T09:05:00.000Z",
  "version": 1
}
```

### `GET /v1/organizations/:organizationId/features`  <a id="organizations-features"></a>

**What an organization has unlocked** · operation `organizations.features`

The effective state of each feature (the override, else the default, and every parent on) and why. Paged by feature key.

- **Scope:** `organizations:read`
- **Kind:** application (your backend asks as itself)
- **Changes data:** no

**Request**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `organizationId` | string (1–200 chars) | yes | (in the path) The organization. |
| `limit` | integer (1–1000) | no | (query) Items per page. At most the server's maximum (100 unless configured). |
| `cursor` | string (1–600 chars) | no | (query) The `nextCursor` of the previous page. |
| `q` | string (1–200 chars) | no | (query) Case-insensitive text to look for. |

**Response `200`**

| Field | Type | Description |
| --- | --- | --- |
| `items` | array (≤ 1000) |  |
| `items[].key` | string (≤ 200 chars) |  |
| `items[].enabled` | boolean | What a check sees: the organization's override, else the default, and every parent on. |
| `items[].reason` | `enabled` \| `disabled` \| `default` \| `parent_disabled` |  |
| `items[].defaultEnabled` | boolean |  |
| `items[].parentKey` | string (≤ 200 chars), may be absent |  |
| `items[].blockedBy` | string (≤ 200 chars), may be absent |  |
| `nextCursor` | string (≤ 600 chars) or `null` | Pass it back as `cursor` for the next page; `null` on the last one. |

**Errors of this operation** (besides the ones every call can meet: see [Errors](#errors))

- `400` `invalid_cursor`
- `400` `invalid_request`
- `404` `organization_not_found`

**Example: Its features, as a check sees them**

```bash
curl -X GET "https://uniora.example.com/v1/organizations/org_acme/features?limit=5" \
  -H "Authorization: Bearer $UNIORA_API_KEY"
```

```ts
const result = await uniora.organizations.features({ organizationId: "org_acme", limit: 5 });
```

```http
HTTP/1.1 200 OK

{
  "items": [],
  "nextCursor": null
}
```

### `POST /v1/organizations`  <a id="organizations-create"></a>

**Create an organization with its first Owner** · operation `organizations.create`

The sign-up flow: the organization, its protected Owner role and the founder's membership are created together or not at all. `owner` is the person who signs up, as your auth provider knows them. The ids are generated by the server. Send an `Idempotency-Key` so a retry cannot create a second organization: the same key with the same request answers the first result with `replayed: true`; the same key with a different request is `422 idempotency_key_reused`. The new organization is outside the allowlist of any client that lists organizations, so only a client that may reach every organization can create one.

- **Scope:** `organizations:create`
- **Kind:** application (your backend asks as itself)
- **Changes data:** yes (refused with `503 read_only` while the server is read-only)
- **Client:** one that may reach every organization (`*`)
- **`Idempotency-Key`:** accepted, so a retry cannot repeat the change

**Request**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string (1–255 chars) | yes |  |
| `slug` | string (1–63 chars) | no | URL-safe handle, unique. Derived from the name when omitted. |
| `owner` | object | yes | Who the question is about. |
| `owner.provider` | string (1–64 chars) | no | An opaque label for the auth system the subject belongs to (not necessarily its vendor name). Omit it to use the server's default label. |
| `owner.subject` | string (1–500 chars) | yes | The user's stable id in your auth provider. Never an e-mail address. |

**Response `201`**

| Field | Type | Description |
| --- | --- | --- |
| `organization` | object |  |
| `organization.id` | string (≤ 200 chars) |  |
| `organization.slug` | string (≤ 200 chars) |  |
| `organization.name` | string (≤ 200 chars) |  |
| `organization.status` | `active` \| `suspended` \| `archived` | `suspended` and `archived` organizations are denied every decision. |
| `organization.createdAt` | string (date-time) |  |
| `organization.version` | integer (1–…) |  |
| `ownerRole` | object |  |
| `ownerRole.id` | string (≤ 200 chars) |  |
| `ownerRole.organizationId` | string (≤ 200 chars) |  |
| `ownerRole.key` | string (≤ 200 chars) |  |
| `ownerRole.name` | string (≤ 200 chars) |  |
| `ownerRole.isOwnerRole` | boolean | The protected Owner role: it passes every permission check. |
| `ownerRole.isSystem` | boolean |  |
| `ownerRole.description` | string (≤ 500 chars), may be absent |  |
| `ownerRole.version` | integer (1–…) | Send it back as `If-Match` to refuse changes made from a stale copy. |
| `membership` | object |  |
| `membership.id` | string (≤ 200 chars) |  |
| `membership.organizationId` | string (≤ 200 chars) |  |
| `membership.identity` | object |  |
| `membership.identity.provider` | string (≤ 200 chars) |  |
| `membership.identity.subject` | string (≤ 500 chars) |  |
| `membership.roleIds` | array (≤ 1000) |  |
| `membership.status` | `active` \| `suspended` \| `blocked` |  |
| `membership.createdAt` | string (date-time) |  |
| `membership.updatedAt` | string (date-time) |  |
| `membership.lastActiveAt` | string (date-time), may be absent |  |
| `membership.invitedBy` | object, may be absent |  |
| `membership.invitedBy.provider` | string (≤ 200 chars) |  |
| `membership.invitedBy.subject` | string (≤ 500 chars) |  |
| `membership.blocked` | object, may be absent | Present while the member is blocked or suspended. |
| `membership.blocked.at` | string (date-time) |  |
| `membership.blocked.until` | string (date-time), may be absent |  |
| `membership.version` | integer (1–…) | Send it back as `If-Match` to refuse changes made from a stale copy. |
| `replayed` | boolean, may be absent | `true` when this is the answer to an earlier request with the same `Idempotency-Key`: nothing new was created. |

**Errors of this operation** (besides the ones every call can meet: see [Errors](#errors))

- `400` `identity_provider_required`
- `400` `identity_provider_reserved`
- `400` `organization_slug_invalid`
- `409` `organization_slug_taken`
- `422` `idempotency_key_reused`

**Example: Sign-up: an organization with its first Owner**

```bash
curl -X POST "https://uniora.example.com/v1/organizations" \
  -H "Authorization: Bearer $UNIORA_API_KEY" \
  -H 'Idempotency-Key: signup-7f3a' \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Initech",
    "owner": {
      "subject": "founder-7"
    }
  }'
```

```ts
const result = await uniora.organizations.create(
  { name: "Initech", owner: { subject: "founder-7" } },
  { idempotencyKey: "signup-7f3a" },
);
```

```http
HTTP/1.1 201 Created

{
  "organization": {
    "id": "org_EXAMPLE0001_____________",
    "slug": "initech",
    "name": "Initech",
    "status": "active",
    "createdAt": "2026-03-02T09:06:00.000Z",
    "version": 1
  },
  "ownerRole": {
    "id": "role_EXAMPLE0002_____________",
    "organizationId": "org_EXAMPLE0001_____________",
    "key": "owner",
    "name": "Owner",
    "isOwnerRole": true,
    "isSystem": false,
    "version": 1
  },
  "membership": {
    "id": "mem_EXAMPLE0003_____________",
    "organizationId": "org_EXAMPLE0001_____________",
    "identity": {
      "provider": "main",
      "subject": "founder-7"
    },
    "roleIds": [
      "role_EXAMPLE0002_____________"
    ],
    "status": "active",
    "createdAt": "2026-03-02T09:07:00.000Z",
    "updatedAt": "2026-03-02T09:08:00.000Z",
    "version": 1
  }
}
```

**Example: The same request again answers the first result**

```bash
curl -X POST "https://uniora.example.com/v1/organizations" \
  -H "Authorization: Bearer $UNIORA_API_KEY" \
  -H 'Idempotency-Key: signup-7f3a' \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Initech",
    "owner": {
      "subject": "founder-7"
    }
  }'
```

```ts
const result = await uniora.organizations.create(
  { name: "Initech", owner: { subject: "founder-7" } },
  { idempotencyKey: "signup-7f3a" },
);
```

```http
HTTP/1.1 201 Created

{
  "organization": {
    "id": "org_EXAMPLE0001_____________",
    "slug": "initech",
    "name": "Initech",
    "status": "active",
    "createdAt": "2026-03-02T09:09:00.000Z",
    "version": 1
  },
  "ownerRole": {
    "id": "role_EXAMPLE0002_____________",
    "organizationId": "org_EXAMPLE0001_____________",
    "key": "owner",
    "name": "Owner",
    "isOwnerRole": true,
    "isSystem": false,
    "version": 1
  },
  "membership": {
    "id": "mem_EXAMPLE0003_____________",
    "organizationId": "org_EXAMPLE0001_____________",
    "identity": {
      "provider": "main",
      "subject": "founder-7"
    },
    "roleIds": [
      "role_EXAMPLE0002_____________"
    ],
    "status": "active",
    "createdAt": "2026-03-02T09:10:00.000Z",
    "updatedAt": "2026-03-02T09:11:00.000Z",
    "version": 1
  },
  "replayed": true
}
```

**Example: The same key for a different request is refused**

```bash
curl -X POST "https://uniora.example.com/v1/organizations" \
  -H "Authorization: Bearer $UNIORA_API_KEY" \
  -H 'Idempotency-Key: signup-7f3a' \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Initech Europe",
    "owner": {
      "subject": "founder-7"
    }
  }'
```

```ts
await uniora.organizations.create(
  { name: "Initech Europe", owner: { subject: "founder-7" } },
  { idempotencyKey: "signup-7f3a" },
);
```

```http
HTTP/1.1 422 Unprocessable Content

{
  "type": "urn:uniora:error:idempotency_key_reused",
  "title": "Unprocessable Content",
  "status": 422,
  "code": "idempotency_key_reused",
  "requestId": "req_xxxxxxxxxxxxxxx4"
}
```

## Members

An organization's members, and what an end user may change about them.

### `GET /v1/organizations/:organizationId/members`  <a id="members-list"></a>

**List an organization's members** · operation `members.list`

Ordered by member id. `q` matches the identity's subject or provider.

- **Scope:** `organizations:read`
- **Kind:** application (your backend asks as itself)
- **Changes data:** no

**Request**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `organizationId` | string (1–200 chars) | yes | (in the path) The organization. |
| `limit` | integer (1–1000) | no | (query) Items per page. At most the server's maximum (100 unless configured). |
| `cursor` | string (1–600 chars) | no | (query) The `nextCursor` of the previous page. |
| `q` | string (1–200 chars) | no | (query) Case-insensitive text to look for. |
| `status` | `active` \| `suspended` \| `blocked` | no | (query) |

**Response `200`**

| Field | Type | Description |
| --- | --- | --- |
| `items` | array (≤ 1000) |  |
| `items[].id` | string (≤ 200 chars) |  |
| `items[].organizationId` | string (≤ 200 chars) |  |
| `items[].identity` | object |  |
| `items[].identity.provider` | string (≤ 200 chars) |  |
| `items[].identity.subject` | string (≤ 500 chars) |  |
| `items[].roleIds` | array (≤ 1000) |  |
| `items[].status` | `active` \| `suspended` \| `blocked` |  |
| `items[].createdAt` | string (date-time) |  |
| `items[].updatedAt` | string (date-time) |  |
| `items[].lastActiveAt` | string (date-time), may be absent |  |
| `items[].invitedBy` | object, may be absent |  |
| `items[].invitedBy.provider` | string (≤ 200 chars) |  |
| `items[].invitedBy.subject` | string (≤ 500 chars) |  |
| `items[].blocked` | object, may be absent | Present while the member is blocked or suspended. |
| `items[].blocked.at` | string (date-time) |  |
| `items[].blocked.until` | string (date-time), may be absent |  |
| `items[].version` | integer (1–…) | Send it back as `If-Match` to refuse changes made from a stale copy. |
| `nextCursor` | string (≤ 600 chars) or `null` | Pass it back as `cursor` for the next page; `null` on the last one. |

**Errors of this operation** (besides the ones every call can meet: see [Errors](#errors))

- `400` `invalid_cursor`
- `400` `invalid_request`
- `404` `organization_not_found`

**Example: Its members**

```bash
curl -X GET "https://uniora.example.com/v1/organizations/org_acme/members?limit=10" \
  -H "Authorization: Bearer $UNIORA_API_KEY"
```

```ts
const result = await uniora.members.list({ organizationId: "org_acme", limit: 10 });
```

```http
HTTP/1.1 200 OK

{
  "items": [
    {
      "id": "mem_ana",
      "organizationId": "org_acme",
      "identity": {
        "provider": "main",
        "subject": "ana"
      },
      "roleIds": [
        "role_viewer"
      ],
      "status": "active",
      "createdAt": "2026-03-02T09:12:00.000Z",
      "updatedAt": "2026-03-02T09:13:00.000Z",
      "version": 1
    },
    {
      "id": "mem_bob",
      "organizationId": "org_acme",
      "identity": {
        "provider": "main",
        "subject": "bob"
      },
      "roleIds": [],
      "status": "active",
      "createdAt": "2026-03-02T09:14:00.000Z",
      "updatedAt": "2026-03-02T09:15:00.000Z",
      "version": 1
    },
    {
      "id": "mem_mgr",
      "organizationId": "org_acme",
      "identity": {
        "provider": "main",
        "subject": "mgr"
      },
      "roleIds": [
        "role_manager"
      ],
      "status": "active",
      "createdAt": "2026-03-02T09:16:00.000Z",
      "updatedAt": "2026-03-02T09:17:00.000Z",
      "version": 1
    },
    {
      "id": "mem_owner",
      "organizationId": "org_acme",
      "identity": {
        "provider": "main",
        "subject": "owner"
      },
      "roleIds": [
        "role_owner"
      ],
      "status": "active",
      "createdAt": "2026-03-02T09:18:00.000Z",
      "updatedAt": "2026-03-02T09:19:00.000Z",
      "version": 1
    }
  ],
  "nextCursor": null
}
```

### `GET /v1/organizations/:organizationId/members/:membershipId`  <a id="members-get"></a>

**Get a member** · operation `members.get`

A member of another organization answers exactly like one that does not exist.

- **Scope:** `organizations:read`
- **Kind:** application (your backend asks as itself)
- **Changes data:** no

**Request**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `organizationId` | string (1–200 chars) | yes | (in the path) The organization. |
| `membershipId` | string (1–200 chars) | yes | (in the path) The membership. |

**Response `200`**

| Field | Type | Description |
| --- | --- | --- |
| `id` | string (≤ 200 chars) |  |
| `organizationId` | string (≤ 200 chars) |  |
| `identity` | object |  |
| `identity.provider` | string (≤ 200 chars) |  |
| `identity.subject` | string (≤ 500 chars) |  |
| `roleIds` | array (≤ 1000) |  |
| `status` | `active` \| `suspended` \| `blocked` |  |
| `createdAt` | string (date-time) |  |
| `updatedAt` | string (date-time) |  |
| `lastActiveAt` | string (date-time), may be absent |  |
| `invitedBy` | object, may be absent |  |
| `invitedBy.provider` | string (≤ 200 chars) |  |
| `invitedBy.subject` | string (≤ 500 chars) |  |
| `blocked` | object, may be absent | Present while the member is blocked or suspended. |
| `blocked.at` | string (date-time) |  |
| `blocked.until` | string (date-time), may be absent |  |
| `version` | integer (1–…) | Send it back as `If-Match` to refuse changes made from a stale copy. |

**Errors of this operation** (besides the ones every call can meet: see [Errors](#errors))

- `404` `membership_not_found`
- `404` `organization_not_found`

**Example: One member**

```bash
curl -X GET "https://uniora.example.com/v1/organizations/org_acme/members/mem_ana" \
  -H "Authorization: Bearer $UNIORA_API_KEY"
```

```ts
const result = await uniora.members.get({ organizationId: "org_acme", membershipId: "mem_ana" });
```

```http
HTTP/1.1 200 OK

{
  "id": "mem_ana",
  "organizationId": "org_acme",
  "identity": {
    "provider": "main",
    "subject": "ana"
  },
  "roleIds": [
    "role_viewer"
  ],
  "status": "active",
  "createdAt": "2026-03-02T09:20:00.000Z",
  "updatedAt": "2026-03-02T09:21:00.000Z",
  "version": 1
}
```

### `PUT /v1/organizations/:organizationId/members/:membershipId/roles/:roleId`  <a id="members-assignrole"></a>

**Give a member a role** · operation `members.assignRole`

The actor can only give a role if they hold every permission in it, and never to themselves. Idempotent: giving a role the member already has changes nothing. Send `If-Match` with the member's version to refuse a stale edit. A delegated call: it speaks for the end user in the `Uniora-Actor-Subject` header, needs the `actor:assert` scope as well, and succeeds only if that user may do it (the four anti-escalation rules apply to them).

- **Scope:** `members:write` and `actor:assert`
- **Kind:** delegated (speaks for an end user)
- **Changes data:** yes (refused with `503 read_only` while the server is read-only)
- **`If-Match`:** send the version you last saw; a stale one is a `412` and nothing changes
- **`ETag`:** the answer carries the version of the resource

**Request**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `organizationId` | string (1–200 chars) | yes | (in the path) The organization. |
| `membershipId` | string (1–200 chars) | yes | (in the path) The membership (not the user id): `members.list` shows both. |
| `roleId` | string (1–200 chars) | yes | (in the path) The role. |

Delegated calls also send `Uniora-Actor-Subject` (the end user, percent-encoded) and, when your server has no default label, `Uniora-Actor-Provider`.

**Response `200`**

| Field | Type | Description |
| --- | --- | --- |
| `id` | string (≤ 200 chars) |  |
| `organizationId` | string (≤ 200 chars) |  |
| `identity` | object |  |
| `identity.provider` | string (≤ 200 chars) |  |
| `identity.subject` | string (≤ 500 chars) |  |
| `roleIds` | array (≤ 1000) |  |
| `status` | `active` \| `suspended` \| `blocked` |  |
| `createdAt` | string (date-time) |  |
| `updatedAt` | string (date-time) |  |
| `lastActiveAt` | string (date-time), may be absent |  |
| `invitedBy` | object, may be absent |  |
| `invitedBy.provider` | string (≤ 200 chars) |  |
| `invitedBy.subject` | string (≤ 500 chars) |  |
| `blocked` | object, may be absent | Present while the member is blocked or suspended. |
| `blocked.at` | string (date-time) |  |
| `blocked.until` | string (date-time), may be absent |  |
| `version` | integer (1–…) | Send it back as `If-Match` to refuse changes made from a stale copy. |

**Errors of this operation** (besides the ones every call can meet: see [Errors](#errors))

- `400` `actor_required`
- `400` `identity_provider_required`
- `400` `identity_provider_reserved`
- `403` `access_escalation`
- `403` `access_owner_protected`
- `403` `access_self_change`
- `403` `access_target_stronger`
- `403` `forbidden`
- `404` `membership_not_found`
- `404` `organization_not_found`
- `404` `role_not_found`
- `412` `membership_version_conflict`
- `501` `actor_token_unsupported`

**Example: A manager gives Bob a role**

```bash
curl -X PUT "https://uniora.example.com/v1/organizations/org_acme/members/mem_bob/roles/role_viewer" \
  -H "Authorization: Bearer $UNIORA_API_KEY" \
  -H 'Uniora-Actor-Subject: mgr'
```

```ts
const result = await uniora.members.assignRole(
  {
    organizationId: "org_acme",
    membershipId: "mem_bob",
    roleId: "role_viewer",
  },
  { actor: { subject: "mgr" } },
);
```

```http
HTTP/1.1 200 OK
ETag: "2"

{
  "id": "mem_bob",
  "organizationId": "org_acme",
  "identity": {
    "provider": "main",
    "subject": "bob"
  },
  "roleIds": [
    "role_viewer"
  ],
  "status": "active",
  "createdAt": "2026-03-02T09:22:00.000Z",
  "updatedAt": "2026-03-02T09:23:00.000Z",
  "version": 2
}
```

**Example: Nobody changes their own roles**

```bash
curl -X PUT "https://uniora.example.com/v1/organizations/org_acme/members/mem_mgr/roles/role_viewer" \
  -H "Authorization: Bearer $UNIORA_API_KEY" \
  -H 'Uniora-Actor-Subject: mgr'
```

```ts
await uniora.members.assignRole(
  {
    organizationId: "org_acme",
    membershipId: "mem_mgr",
    roleId: "role_viewer",
  },
  { actor: { subject: "mgr" } },
);
```

```http
HTTP/1.1 403 Forbidden

{
  "type": "urn:uniora:error:access_self_change",
  "title": "Forbidden",
  "status": 403,
  "code": "access_self_change",
  "requestId": "req_xxxxxxxxxxxxxxx5"
}
```

**Example: Someone without the permission gets a plain forbidden**

```bash
curl -X PUT "https://uniora.example.com/v1/organizations/org_acme/members/mem_bob/roles/role_viewer" \
  -H "Authorization: Bearer $UNIORA_API_KEY" \
  -H 'Uniora-Actor-Subject: ana'
```

```ts
await uniora.members.assignRole(
  {
    organizationId: "org_acme",
    membershipId: "mem_bob",
    roleId: "role_viewer",
  },
  { actor: { subject: "ana" } },
);
```

```http
HTTP/1.1 403 Forbidden

{
  "type": "urn:uniora:error:forbidden",
  "title": "Forbidden",
  "status": 403,
  "code": "forbidden",
  "requestId": "req_xxxxxxxxxxxxxxx6"
}
```

### `DELETE /v1/organizations/:organizationId/members/:membershipId/roles/:roleId`  <a id="members-unassignrole"></a>

**Take a role away from a member** · operation `members.unassignRole`

The member keeps their other roles. The Owner role does not move through here. A delegated call: it speaks for the end user in the `Uniora-Actor-Subject` header, needs the `actor:assert` scope as well, and succeeds only if that user may do it (the four anti-escalation rules apply to them).

- **Scope:** `members:write` and `actor:assert`
- **Kind:** delegated (speaks for an end user)
- **Changes data:** yes (refused with `503 read_only` while the server is read-only)
- **`If-Match`:** send the version you last saw; a stale one is a `412` and nothing changes
- **`ETag`:** the answer carries the version of the resource

**Request**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `organizationId` | string (1–200 chars) | yes | (in the path) The organization. |
| `membershipId` | string (1–200 chars) | yes | (in the path) The membership (not the user id): `members.list` shows both. |
| `roleId` | string (1–200 chars) | yes | (in the path) The role. |

Delegated calls also send `Uniora-Actor-Subject` (the end user, percent-encoded) and, when your server has no default label, `Uniora-Actor-Provider`.

**Response `200`**

| Field | Type | Description |
| --- | --- | --- |
| `id` | string (≤ 200 chars) |  |
| `organizationId` | string (≤ 200 chars) |  |
| `identity` | object |  |
| `identity.provider` | string (≤ 200 chars) |  |
| `identity.subject` | string (≤ 500 chars) |  |
| `roleIds` | array (≤ 1000) |  |
| `status` | `active` \| `suspended` \| `blocked` |  |
| `createdAt` | string (date-time) |  |
| `updatedAt` | string (date-time) |  |
| `lastActiveAt` | string (date-time), may be absent |  |
| `invitedBy` | object, may be absent |  |
| `invitedBy.provider` | string (≤ 200 chars) |  |
| `invitedBy.subject` | string (≤ 500 chars) |  |
| `blocked` | object, may be absent | Present while the member is blocked or suspended. |
| `blocked.at` | string (date-time) |  |
| `blocked.until` | string (date-time), may be absent |  |
| `version` | integer (1–…) | Send it back as `If-Match` to refuse changes made from a stale copy. |

**Errors of this operation** (besides the ones every call can meet: see [Errors](#errors))

- `400` `actor_required`
- `400` `identity_provider_required`
- `400` `identity_provider_reserved`
- `403` `access_escalation`
- `403` `access_owner_protected`
- `403` `access_self_change`
- `403` `access_target_stronger`
- `403` `forbidden`
- `404` `membership_not_found`
- `404` `organization_not_found`
- `404` `role_not_found`
- `412` `membership_version_conflict`
- `501` `actor_token_unsupported`

**Example: Take the role away, if the member is still at the version we saw**

```bash
curl -X DELETE "https://uniora.example.com/v1/organizations/org_acme/members/mem_bob/roles/role_viewer" \
  -H "Authorization: Bearer $UNIORA_API_KEY" \
  -H 'Uniora-Actor-Subject: mgr' \
  -H 'If-Match: "2"'
```

```ts
const result = await uniora.members.unassignRole(
  {
    organizationId: "org_acme",
    membershipId: "mem_bob",
    roleId: "role_viewer",
  },
  { actor: { subject: "mgr" }, ifMatch: 2 },
);
```

```http
HTTP/1.1 200 OK
ETag: "3"

{
  "id": "mem_bob",
  "organizationId": "org_acme",
  "identity": {
    "provider": "main",
    "subject": "bob"
  },
  "roleIds": [],
  "status": "active",
  "createdAt": "2026-03-02T09:24:00.000Z",
  "updatedAt": "2026-03-02T09:25:00.000Z",
  "version": 3
}
```

### `POST /v1/organizations/:organizationId/members/:membershipId/block`  <a id="members-block"></a>

**Block a member** · operation `members.block`

A blocked member keeps their roles and history but is denied every check until unblocked. A delegated call: it speaks for the end user in the `Uniora-Actor-Subject` header, needs the `actor:assert` scope as well, and succeeds only if that user may do it (the four anti-escalation rules apply to them).

- **Scope:** `members:write` and `actor:assert`
- **Kind:** delegated (speaks for an end user)
- **Changes data:** yes (refused with `503 read_only` while the server is read-only)
- **`If-Match`:** send the version you last saw; a stale one is a `412` and nothing changes
- **`ETag`:** the answer carries the version of the resource

**Request**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `organizationId` | string (1–200 chars) | yes | (in the path) The organization. |
| `membershipId` | string (1–200 chars) | yes | (in the path) The membership (not the user id): `members.list` shows both. |
| `reason` | string (1–500 chars) | no | Why. Kept in the audit log. |

Delegated calls also send `Uniora-Actor-Subject` (the end user, percent-encoded) and, when your server has no default label, `Uniora-Actor-Provider`.

**Response `200`**

| Field | Type | Description |
| --- | --- | --- |
| `id` | string (≤ 200 chars) |  |
| `organizationId` | string (≤ 200 chars) |  |
| `identity` | object |  |
| `identity.provider` | string (≤ 200 chars) |  |
| `identity.subject` | string (≤ 500 chars) |  |
| `roleIds` | array (≤ 1000) |  |
| `status` | `active` \| `suspended` \| `blocked` |  |
| `createdAt` | string (date-time) |  |
| `updatedAt` | string (date-time) |  |
| `lastActiveAt` | string (date-time), may be absent |  |
| `invitedBy` | object, may be absent |  |
| `invitedBy.provider` | string (≤ 200 chars) |  |
| `invitedBy.subject` | string (≤ 500 chars) |  |
| `blocked` | object, may be absent | Present while the member is blocked or suspended. |
| `blocked.at` | string (date-time) |  |
| `blocked.until` | string (date-time), may be absent |  |
| `version` | integer (1–…) | Send it back as `If-Match` to refuse changes made from a stale copy. |

**Errors of this operation** (besides the ones every call can meet: see [Errors](#errors))

- `400` `actor_required`
- `400` `identity_provider_required`
- `400` `identity_provider_reserved`
- `403` `access_escalation`
- `403` `access_owner_protected`
- `403` `access_self_change`
- `403` `access_target_stronger`
- `403` `forbidden`
- `404` `membership_not_found`
- `404` `organization_not_found`
- `412` `membership_version_conflict`
- `501` `actor_token_unsupported`

**Example: Block a member**

```bash
curl -X POST "https://uniora.example.com/v1/organizations/org_acme/members/mem_bob/block" \
  -H "Authorization: Bearer $UNIORA_API_KEY" \
  -H 'Uniora-Actor-Subject: mgr' \
  -H "Content-Type: application/json" \
  -d '{
    "reason": "left the company"
  }'
```

```ts
const result = await uniora.members.block(
  {
    organizationId: "org_acme",
    membershipId: "mem_bob",
    reason: "left the company",
  },
  { actor: { subject: "mgr" } },
);
```

```http
HTTP/1.1 200 OK
ETag: "4"

{
  "id": "mem_bob",
  "organizationId": "org_acme",
  "identity": {
    "provider": "main",
    "subject": "bob"
  },
  "roleIds": [],
  "status": "blocked",
  "createdAt": "2026-03-02T09:26:00.000Z",
  "updatedAt": "2026-03-02T09:27:00.000Z",
  "blocked": {
    "at": "2026-03-02T09:28:00.000Z"
  },
  "version": 4
}
```

### `POST /v1/organizations/:organizationId/members/:membershipId/suspend`  <a id="members-suspend"></a>

**Suspend a member until a date** · operation `members.suspend`

Like a block that ends by itself at `until`, with no job to run. A delegated call: it speaks for the end user in the `Uniora-Actor-Subject` header, needs the `actor:assert` scope as well, and succeeds only if that user may do it (the four anti-escalation rules apply to them).

- **Scope:** `members:write` and `actor:assert`
- **Kind:** delegated (speaks for an end user)
- **Changes data:** yes (refused with `503 read_only` while the server is read-only)
- **`If-Match`:** send the version you last saw; a stale one is a `412` and nothing changes
- **`ETag`:** the answer carries the version of the resource

**Request**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `organizationId` | string (1–200 chars) | yes | (in the path) The organization. |
| `membershipId` | string (1–200 chars) | yes | (in the path) The membership (not the user id): `members.list` shows both. |
| `until` | string (date-time) | yes | When the suspension ends. Must be in the future. |
| `reason` | string (1–500 chars) | no | Why. Kept in the audit log. |

Delegated calls also send `Uniora-Actor-Subject` (the end user, percent-encoded) and, when your server has no default label, `Uniora-Actor-Provider`.

**Response `200`**

| Field | Type | Description |
| --- | --- | --- |
| `id` | string (≤ 200 chars) |  |
| `organizationId` | string (≤ 200 chars) |  |
| `identity` | object |  |
| `identity.provider` | string (≤ 200 chars) |  |
| `identity.subject` | string (≤ 500 chars) |  |
| `roleIds` | array (≤ 1000) |  |
| `status` | `active` \| `suspended` \| `blocked` |  |
| `createdAt` | string (date-time) |  |
| `updatedAt` | string (date-time) |  |
| `lastActiveAt` | string (date-time), may be absent |  |
| `invitedBy` | object, may be absent |  |
| `invitedBy.provider` | string (≤ 200 chars) |  |
| `invitedBy.subject` | string (≤ 500 chars) |  |
| `blocked` | object, may be absent | Present while the member is blocked or suspended. |
| `blocked.at` | string (date-time) |  |
| `blocked.until` | string (date-time), may be absent |  |
| `version` | integer (1–…) | Send it back as `If-Match` to refuse changes made from a stale copy. |

**Errors of this operation** (besides the ones every call can meet: see [Errors](#errors))

- `400` `actor_required`
- `400` `identity_provider_required`
- `400` `identity_provider_reserved`
- `400` `membership_block_until_invalid`
- `403` `access_escalation`
- `403` `access_owner_protected`
- `403` `access_self_change`
- `403` `access_target_stronger`
- `403` `forbidden`
- `404` `membership_not_found`
- `404` `organization_not_found`
- `412` `membership_version_conflict`
- `501` `actor_token_unsupported`

**Example: Suspend a member until a date**

```bash
curl -X POST "https://uniora.example.com/v1/organizations/org_acme/members/mem_bob/suspend" \
  -H "Authorization: Bearer $UNIORA_API_KEY" \
  -H 'Uniora-Actor-Subject: mgr' \
  -H "Content-Type: application/json" \
  -d '{
    "until": "2099-01-01T00:00:00.000Z",
    "reason": "on leave"
  }'
```

```ts
const result = await uniora.members.suspend(
  {
    organizationId: "org_acme",
    membershipId: "mem_bob",
    until: "2099-01-01T00:00:00.000Z",
    reason: "on leave",
  },
  { actor: { subject: "mgr" } },
);
```

```http
HTTP/1.1 200 OK
ETag: "6"

{
  "id": "mem_bob",
  "organizationId": "org_acme",
  "identity": {
    "provider": "main",
    "subject": "bob"
  },
  "roleIds": [],
  "status": "suspended",
  "createdAt": "2026-03-02T09:29:00.000Z",
  "updatedAt": "2026-03-02T09:30:00.000Z",
  "blocked": {
    "at": "2026-03-02T09:31:00.000Z",
    "until": "2099-01-01T00:00:00.000Z"
  },
  "version": 6
}
```

### `POST /v1/organizations/:organizationId/members/:membershipId/unblock`  <a id="members-unblock"></a>

**Lift a block or a suspension** · operation `members.unblock`

The member is evaluated normally again. A delegated call: it speaks for the end user in the `Uniora-Actor-Subject` header, needs the `actor:assert` scope as well, and succeeds only if that user may do it (the four anti-escalation rules apply to them).

- **Scope:** `members:write` and `actor:assert`
- **Kind:** delegated (speaks for an end user)
- **Changes data:** yes (refused with `503 read_only` while the server is read-only)
- **`If-Match`:** send the version you last saw; a stale one is a `412` and nothing changes
- **`ETag`:** the answer carries the version of the resource

**Request**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `organizationId` | string (1–200 chars) | yes | (in the path) The organization. |
| `membershipId` | string (1–200 chars) | yes | (in the path) The membership (not the user id): `members.list` shows both. |

Delegated calls also send `Uniora-Actor-Subject` (the end user, percent-encoded) and, when your server has no default label, `Uniora-Actor-Provider`.

**Response `200`**

| Field | Type | Description |
| --- | --- | --- |
| `id` | string (≤ 200 chars) |  |
| `organizationId` | string (≤ 200 chars) |  |
| `identity` | object |  |
| `identity.provider` | string (≤ 200 chars) |  |
| `identity.subject` | string (≤ 500 chars) |  |
| `roleIds` | array (≤ 1000) |  |
| `status` | `active` \| `suspended` \| `blocked` |  |
| `createdAt` | string (date-time) |  |
| `updatedAt` | string (date-time) |  |
| `lastActiveAt` | string (date-time), may be absent |  |
| `invitedBy` | object, may be absent |  |
| `invitedBy.provider` | string (≤ 200 chars) |  |
| `invitedBy.subject` | string (≤ 500 chars) |  |
| `blocked` | object, may be absent | Present while the member is blocked or suspended. |
| `blocked.at` | string (date-time) |  |
| `blocked.until` | string (date-time), may be absent |  |
| `version` | integer (1–…) | Send it back as `If-Match` to refuse changes made from a stale copy. |

**Errors of this operation** (besides the ones every call can meet: see [Errors](#errors))

- `400` `actor_required`
- `400` `identity_provider_required`
- `400` `identity_provider_reserved`
- `403` `access_escalation`
- `403` `access_owner_protected`
- `403` `access_self_change`
- `403` `access_target_stronger`
- `403` `forbidden`
- `404` `membership_not_found`
- `404` `organization_not_found`
- `412` `membership_version_conflict`
- `501` `actor_token_unsupported`

**Example: Lift the block**

```bash
curl -X POST "https://uniora.example.com/v1/organizations/org_acme/members/mem_bob/unblock" \
  -H "Authorization: Bearer $UNIORA_API_KEY" \
  -H 'Uniora-Actor-Subject: mgr'
```

```ts
const result = await uniora.members.unblock(
  { organizationId: "org_acme", membershipId: "mem_bob" },
  { actor: { subject: "mgr" } },
);
```

```http
HTTP/1.1 200 OK
ETag: "5"

{
  "id": "mem_bob",
  "organizationId": "org_acme",
  "identity": {
    "provider": "main",
    "subject": "bob"
  },
  "roleIds": [],
  "status": "active",
  "createdAt": "2026-03-02T09:32:00.000Z",
  "updatedAt": "2026-03-02T09:33:00.000Z",
  "version": 5
}
```

**Example: Lift the suspension early**

```bash
curl -X POST "https://uniora.example.com/v1/organizations/org_acme/members/mem_bob/unblock" \
  -H "Authorization: Bearer $UNIORA_API_KEY" \
  -H 'Uniora-Actor-Subject: mgr'
```

```ts
const result = await uniora.members.unblock(
  { organizationId: "org_acme", membershipId: "mem_bob" },
  { actor: { subject: "mgr" } },
);
```

```http
HTTP/1.1 200 OK
ETag: "7"

{
  "id": "mem_bob",
  "organizationId": "org_acme",
  "identity": {
    "provider": "main",
    "subject": "bob"
  },
  "roleIds": [],
  "status": "active",
  "createdAt": "2026-03-02T09:34:00.000Z",
  "updatedAt": "2026-03-02T09:35:00.000Z",
  "version": 7
}
```

### `DELETE /v1/organizations/:organizationId/members/:membershipId`  <a id="members-remove"></a>

**Remove a member from the organization** · operation `members.remove`

Their team memberships go with it. The last Owner cannot be removed. Leaving by one's own choice is not a delegated call. A delegated call: it speaks for the end user in the `Uniora-Actor-Subject` header, needs the `actor:assert` scope as well, and succeeds only if that user may do it (the four anti-escalation rules apply to them).

- **Scope:** `members:write` and `actor:assert`
- **Kind:** delegated (speaks for an end user)
- **Changes data:** yes (refused with `503 read_only` while the server is read-only)

**Request**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `organizationId` | string (1–200 chars) | yes | (in the path) The organization. |
| `membershipId` | string (1–200 chars) | yes | (in the path) The membership (not the user id): `members.list` shows both. |

Delegated calls also send `Uniora-Actor-Subject` (the end user, percent-encoded) and, when your server has no default label, `Uniora-Actor-Provider`.

**Response `200`**

| Field | Type | Description |
| --- | --- | --- |
| `removed` | boolean |  |

**Errors of this operation** (besides the ones every call can meet: see [Errors](#errors))

- `400` `actor_required`
- `400` `identity_provider_required`
- `400` `identity_provider_reserved`
- `403` `access_escalation`
- `403` `access_owner_protected`
- `403` `access_self_change`
- `403` `access_target_stronger`
- `403` `forbidden`
- `404` `membership_not_found`
- `404` `organization_not_found`
- `409` `last_owner`
- `412` `membership_version_conflict`
- `501` `actor_token_unsupported`

**Example: Remove a member from the organization**

```bash
curl -X DELETE "https://uniora.example.com/v1/organizations/org_acme/members/00000000-0000-4000-8000-000000000001" \
  -H "Authorization: Bearer $UNIORA_API_KEY" \
  -H 'Uniora-Actor-Subject: mgr'
```

```ts
const result = await uniora.members.remove(
  {
    organizationId: "org_acme",
    membershipId: "00000000-0000-4000-8000-000000000001",
  },
  { actor: { subject: "mgr" } },
);
```

```http
HTTP/1.1 200 OK

{
  "removed": true
}
```

## Roles

Roles and the permissions they hold.

### `GET /v1/organizations/:organizationId/roles`  <a id="roles-list"></a>

**List an organization's roles** · operation `roles.list`

Ordered by role key. `q` matches the name or the key. A role's permissions are listed by `roles.permissions`.

- **Scope:** `organizations:read`
- **Kind:** application (your backend asks as itself)
- **Changes data:** no

**Request**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `organizationId` | string (1–200 chars) | yes | (in the path) The organization. |
| `limit` | integer (1–1000) | no | (query) Items per page. At most the server's maximum (100 unless configured). |
| `cursor` | string (1–600 chars) | no | (query) The `nextCursor` of the previous page. |
| `q` | string (1–200 chars) | no | (query) Case-insensitive text to look for. |

**Response `200`**

| Field | Type | Description |
| --- | --- | --- |
| `items` | array (≤ 1000) |  |
| `items[].id` | string (≤ 200 chars) |  |
| `items[].organizationId` | string (≤ 200 chars) |  |
| `items[].key` | string (≤ 200 chars) |  |
| `items[].name` | string (≤ 200 chars) |  |
| `items[].isOwnerRole` | boolean | The protected Owner role: it passes every permission check. |
| `items[].isSystem` | boolean |  |
| `items[].description` | string (≤ 500 chars), may be absent |  |
| `nextCursor` | string (≤ 600 chars) or `null` | Pass it back as `cursor` for the next page; `null` on the last one. |

**Errors of this operation** (besides the ones every call can meet: see [Errors](#errors))

- `400` `invalid_cursor`
- `400` `invalid_request`
- `404` `organization_not_found`

**Example: Its roles**

```bash
curl -X GET "https://uniora.example.com/v1/organizations/org_acme/roles?limit=10" \
  -H "Authorization: Bearer $UNIORA_API_KEY"
```

```ts
const result = await uniora.roles.list({ organizationId: "org_acme", limit: 10 });
```

```http
HTTP/1.1 200 OK

{
  "items": [
    {
      "id": "role_manager",
      "organizationId": "org_acme",
      "key": "manager",
      "name": "Manager",
      "isOwnerRole": false,
      "isSystem": false
    },
    {
      "id": "role_owner",
      "organizationId": "org_acme",
      "key": "owner",
      "name": "Owner",
      "isOwnerRole": true,
      "isSystem": false
    },
    {
      "id": "role_viewer",
      "organizationId": "org_acme",
      "key": "viewer",
      "name": "Viewer",
      "isOwnerRole": false,
      "isSystem": false
    }
  ],
  "nextCursor": null
}
```

### `GET /v1/organizations/:organizationId/roles/:roleId/permissions`  <a id="roles-permissions"></a>

**List the permissions a role grants** · operation `roles.permissions`

Paged, because a role can hold thousands of permissions. Ordered by permission key.

- **Scope:** `organizations:read`
- **Kind:** application (your backend asks as itself)
- **Changes data:** no

**Request**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `organizationId` | string (1–200 chars) | yes | (in the path) The organization. |
| `roleId` | string (1–200 chars) | yes | (in the path) The role. |
| `limit` | integer (1–1000) | no | (query) Items per page. At most the server's maximum (100 unless configured). |
| `cursor` | string (1–600 chars) | no | (query) The `nextCursor` of the previous page. |
| `q` | string (1–200 chars) | no | (query) Case-insensitive text to look for. |

**Response `200`**

| Field | Type | Description |
| --- | --- | --- |
| `items` | array (≤ 1000) |  |
| `items[].key` | string (≤ 200 chars) |  |
| `items[].name` | string (≤ 200 chars), may be absent |  |
| `items[].description` | string (≤ 1000 chars), may be absent |  |
| `items[].group` | string (≤ 200 chars), may be absent |  |
| `items[].implies` | array (≤ 100), may be absent |  |
| `nextCursor` | string (≤ 600 chars) or `null` | Pass it back as `cursor` for the next page; `null` on the last one. |

**Errors of this operation** (besides the ones every call can meet: see [Errors](#errors))

- `400` `invalid_cursor`
- `400` `invalid_request`
- `404` `organization_not_found`
- `404` `role_not_found`

**Example: What a role grants**

```bash
curl -X GET "https://uniora.example.com/v1/organizations/org_acme/roles/role_viewer/permissions" \
  -H "Authorization: Bearer $UNIORA_API_KEY"
```

```ts
const result = await uniora.roles.permissions(
  { organizationId: "org_acme", roleId: "role_viewer" },
);
```

```http
HTTP/1.1 200 OK

{
  "items": [
    {
      "key": "reports.read"
    }
  ],
  "nextCursor": null
}
```

### `POST /v1/organizations/:organizationId/roles`  <a id="roles-create"></a>

**Create a role** · operation `roles.create`

The actor can only put into the role permissions they hold themselves. The key is derived from the name unless given. A delegated call: it speaks for the end user in the `Uniora-Actor-Subject` header, needs the `actor:assert` scope as well, and succeeds only if that user may do it (the four anti-escalation rules apply to them).

- **Scope:** `roles:write` and `actor:assert`
- **Kind:** delegated (speaks for an end user)
- **Changes data:** yes (refused with `503 read_only` while the server is read-only)
- **`ETag`:** the answer carries the version of the resource

**Request**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `organizationId` | string (1–200 chars) | yes | (in the path) The organization. |
| `id` | string (1–200 chars) | no | Your own id for the role; generated when omitted. |
| `name` | string (1–255 chars) | yes | Shown to people. |
| `key` | string (1–100 chars) | no | Stable and URL-safe, unique in the organization. Cannot change later. |
| `description` | string (1–500 chars) | no |  |
| `permissionKeys` | array (≤ 200) | no |  |

Delegated calls also send `Uniora-Actor-Subject` (the end user, percent-encoded) and, when your server has no default label, `Uniora-Actor-Provider`.

**Response `201`**

| Field | Type | Description |
| --- | --- | --- |
| `id` | string (≤ 200 chars) |  |
| `organizationId` | string (≤ 200 chars) |  |
| `key` | string (≤ 200 chars) |  |
| `name` | string (≤ 200 chars) |  |
| `isOwnerRole` | boolean | The protected Owner role: it passes every permission check. |
| `isSystem` | boolean |  |
| `description` | string (≤ 500 chars), may be absent |  |
| `version` | integer (1–…) | Send it back as `If-Match` to refuse changes made from a stale copy. |

**Errors of this operation** (besides the ones every call can meet: see [Errors](#errors))

- `400` `actor_required`
- `400` `identity_provider_required`
- `400` `identity_provider_reserved`
- `403` `access_escalation`
- `403` `access_owner_protected`
- `403` `access_self_change`
- `403` `access_target_stronger`
- `403` `forbidden`
- `404` `organization_not_found`
- `404` `permission_not_found`
- `409` `role_exists`
- `409` `role_key_exists`
- `501` `actor_token_unsupported`

**Example: A new role**

```bash
curl -X POST "https://uniora.example.com/v1/organizations/org_acme/roles" \
  -H "Authorization: Bearer $UNIORA_API_KEY" \
  -H 'Uniora-Actor-Subject: mgr' \
  -H "Content-Type: application/json" \
  -d '{
    "id": "role_support",
    "name": "Support agent",
    "permissionKeys": [
      "reports.read"
    ]
  }'
```

```ts
const result = await uniora.roles.create(
  {
    organizationId: "org_acme",
    id: "role_support",
    name: "Support agent",
    permissionKeys: ["reports.read"],
  },
  { actor: { subject: "mgr" } },
);
```

```http
HTTP/1.1 201 Created
ETag: "1"
Location: /v1/organizations/org_acme/roles/role_support/permissions

{
  "id": "role_support",
  "organizationId": "org_acme",
  "key": "support-agent",
  "name": "Support agent",
  "isOwnerRole": false,
  "isSystem": false,
  "version": 1
}
```

### `PATCH /v1/organizations/:organizationId/roles/:roleId`  <a id="roles-update"></a>

**Rename a role or change its description** · operation `roles.update`

Send `description: null` to clear it. The key never changes. Send `If-Match` with the role's version to refuse a stale edit. A delegated call: it speaks for the end user in the `Uniora-Actor-Subject` header, needs the `actor:assert` scope as well, and succeeds only if that user may do it (the four anti-escalation rules apply to them).

- **Scope:** `roles:write` and `actor:assert`
- **Kind:** delegated (speaks for an end user)
- **Changes data:** yes (refused with `503 read_only` while the server is read-only)
- **`If-Match`:** send the version you last saw; a stale one is a `412` and nothing changes
- **`ETag`:** the answer carries the version of the resource

**Request**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `organizationId` | string (1–200 chars) | yes | (in the path) The organization. |
| `roleId` | string (1–200 chars) | yes | (in the path) The role. |
| `name` | string (1–255 chars) | no |  |
| `description` | string (1–500 chars) or `null` | no |  |

Delegated calls also send `Uniora-Actor-Subject` (the end user, percent-encoded) and, when your server has no default label, `Uniora-Actor-Provider`.

**Response `200`**

| Field | Type | Description |
| --- | --- | --- |
| `id` | string (≤ 200 chars) |  |
| `organizationId` | string (≤ 200 chars) |  |
| `key` | string (≤ 200 chars) |  |
| `name` | string (≤ 200 chars) |  |
| `isOwnerRole` | boolean | The protected Owner role: it passes every permission check. |
| `isSystem` | boolean |  |
| `description` | string (≤ 500 chars), may be absent |  |
| `version` | integer (1–…) | Send it back as `If-Match` to refuse changes made from a stale copy. |

**Errors of this operation** (besides the ones every call can meet: see [Errors](#errors))

- `400` `actor_required`
- `400` `identity_provider_required`
- `400` `identity_provider_reserved`
- `403` `access_escalation`
- `403` `access_owner_protected`
- `403` `access_self_change`
- `403` `access_target_stronger`
- `403` `forbidden`
- `404` `organization_not_found`
- `404` `role_not_found`
- `412` `role_version_conflict`
- `501` `actor_token_unsupported`

**Example: Rename it**

```bash
curl -X PATCH "https://uniora.example.com/v1/organizations/org_acme/roles/role_support" \
  -H "Authorization: Bearer $UNIORA_API_KEY" \
  -H 'Uniora-Actor-Subject: mgr' \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Support",
    "description": "Answers tickets"
  }'
```

```ts
const result = await uniora.roles.update(
  {
    organizationId: "org_acme",
    roleId: "role_support",
    name: "Support",
    description: "Answers tickets",
  },
  { actor: { subject: "mgr" } },
);
```

```http
HTTP/1.1 200 OK
ETag: "2"

{
  "id": "role_support",
  "organizationId": "org_acme",
  "key": "support-agent",
  "name": "Support",
  "isOwnerRole": false,
  "isSystem": false,
  "description": "Answers tickets",
  "version": 2
}
```

### `PUT /v1/organizations/:organizationId/roles/:roleId/permissions`  <a id="roles-setpermissions"></a>

**Make a role hold exactly these permissions** · operation `roles.setPermissions`

Replaces the role's permissions. The actor must hold the role's current permissions and every new one. A delegated call: it speaks for the end user in the `Uniora-Actor-Subject` header, needs the `actor:assert` scope as well, and succeeds only if that user may do it (the four anti-escalation rules apply to them).

- **Scope:** `roles:write` and `actor:assert`
- **Kind:** delegated (speaks for an end user)
- **Changes data:** yes (refused with `503 read_only` while the server is read-only)
- **`If-Match`:** send the version you last saw; a stale one is a `412` and nothing changes

**Request**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `organizationId` | string (1–200 chars) | yes | (in the path) The organization. |
| `roleId` | string (1–200 chars) | yes | (in the path) The role. |
| `permissionKeys` | array (≤ 200) | yes |  |

Delegated calls also send `Uniora-Actor-Subject` (the end user, percent-encoded) and, when your server has no default label, `Uniora-Actor-Provider`.

**Response `200`**

| Field | Type | Description |
| --- | --- | --- |
| `granted` | array (≤ 1000) |  |
| `revoked` | array (≤ 1000) |  |

**Errors of this operation** (besides the ones every call can meet: see [Errors](#errors))

- `400` `actor_required`
- `400` `identity_provider_required`
- `400` `identity_provider_reserved`
- `403` `access_escalation`
- `403` `access_owner_protected`
- `403` `access_self_change`
- `403` `access_target_stronger`
- `403` `forbidden`
- `404` `organization_not_found`
- `404` `permission_not_found`
- `404` `role_not_found`
- `412` `role_version_conflict`
- `501` `actor_token_unsupported`

**Example: Make it hold exactly these permissions**

```bash
curl -X PUT "https://uniora.example.com/v1/organizations/org_acme/roles/role_support/permissions" \
  -H "Authorization: Bearer $UNIORA_API_KEY" \
  -H 'Uniora-Actor-Subject: mgr' \
  -H "Content-Type: application/json" \
  -d '{
    "permissionKeys": [
      "reports.read",
      "members.block"
    ]
  }'
```

```ts
const result = await uniora.roles.setPermissions(
  {
    organizationId: "org_acme",
    roleId: "role_support",
    permissionKeys: ["reports.read", "members.block"],
  },
  { actor: { subject: "mgr" } },
);
```

```http
HTTP/1.1 200 OK

{
  "granted": [
    "members.block"
  ],
  "revoked": []
}
```

### `PUT /v1/organizations/:organizationId/roles/:roleId/permissions/:permissionKey`  <a id="roles-grantpermission"></a>

**Add one permission to a role** · operation `roles.grantPermission`

Idempotent. The actor must hold the permission themselves. A delegated call: it speaks for the end user in the `Uniora-Actor-Subject` header, needs the `actor:assert` scope as well, and succeeds only if that user may do it (the four anti-escalation rules apply to them).

- **Scope:** `roles:write` and `actor:assert`
- **Kind:** delegated (speaks for an end user)
- **Changes data:** yes (refused with `503 read_only` while the server is read-only)
- **`ETag`:** the answer carries the version of the resource

**Request**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `organizationId` | string (1–200 chars) | yes | (in the path) The organization. |
| `roleId` | string (1–200 chars) | yes | (in the path) The role. |
| `permissionKey` | string (1–200 chars) | yes | (in the path) The permission key. |

Delegated calls also send `Uniora-Actor-Subject` (the end user, percent-encoded) and, when your server has no default label, `Uniora-Actor-Provider`.

**Response `200`**

| Field | Type | Description |
| --- | --- | --- |
| `id` | string (≤ 200 chars) |  |
| `organizationId` | string (≤ 200 chars) |  |
| `key` | string (≤ 200 chars) |  |
| `name` | string (≤ 200 chars) |  |
| `isOwnerRole` | boolean | The protected Owner role: it passes every permission check. |
| `isSystem` | boolean |  |
| `description` | string (≤ 500 chars), may be absent |  |
| `version` | integer (1–…) | Send it back as `If-Match` to refuse changes made from a stale copy. |

**Errors of this operation** (besides the ones every call can meet: see [Errors](#errors))

- `400` `actor_required`
- `400` `identity_provider_required`
- `400` `identity_provider_reserved`
- `403` `access_escalation`
- `403` `access_owner_protected`
- `403` `access_self_change`
- `403` `access_target_stronger`
- `403` `forbidden`
- `404` `organization_not_found`
- `404` `permission_not_found`
- `404` `role_not_found`
- `412` `role_version_conflict`
- `501` `actor_token_unsupported`

**Example: Add one permission**

```bash
curl -X PUT "https://uniora.example.com/v1/organizations/org_acme/roles/role_support/permissions/members.remove" \
  -H "Authorization: Bearer $UNIORA_API_KEY" \
  -H 'Uniora-Actor-Subject: mgr'
```

```ts
const result = await uniora.roles.grantPermission(
  {
    organizationId: "org_acme",
    roleId: "role_support",
    permissionKey: "members.remove",
  },
  { actor: { subject: "mgr" } },
);
```

```http
HTTP/1.1 200 OK
ETag: "4"

{
  "id": "role_support",
  "organizationId": "org_acme",
  "key": "support-agent",
  "name": "Support",
  "isOwnerRole": false,
  "isSystem": false,
  "description": "Answers tickets",
  "version": 4
}
```

**Example: You cannot give what you do not hold**

```bash
curl -X PUT "https://uniora.example.com/v1/organizations/org_acme/roles/role_support/permissions/vehicles.delete" \
  -H "Authorization: Bearer $UNIORA_API_KEY" \
  -H 'Uniora-Actor-Subject: mgr'
```

```ts
await uniora.roles.grantPermission(
  {
    organizationId: "org_acme",
    roleId: "role_support",
    permissionKey: "vehicles.delete",
  },
  { actor: { subject: "mgr" } },
);
```

```http
HTTP/1.1 403 Forbidden

{
  "type": "urn:uniora:error:access_escalation",
  "title": "Forbidden",
  "status": 403,
  "code": "access_escalation",
  "requestId": "req_xxxxxxxxxxxxxxx7"
}
```

### `DELETE /v1/organizations/:organizationId/roles/:roleId/permissions/:permissionKey`  <a id="roles-revokepermission"></a>

**Take one permission away from a role** · operation `roles.revokePermission`

Idempotent. A delegated call: it speaks for the end user in the `Uniora-Actor-Subject` header, needs the `actor:assert` scope as well, and succeeds only if that user may do it (the four anti-escalation rules apply to them).

- **Scope:** `roles:write` and `actor:assert`
- **Kind:** delegated (speaks for an end user)
- **Changes data:** yes (refused with `503 read_only` while the server is read-only)
- **`ETag`:** the answer carries the version of the resource

**Request**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `organizationId` | string (1–200 chars) | yes | (in the path) The organization. |
| `roleId` | string (1–200 chars) | yes | (in the path) The role. |
| `permissionKey` | string (1–200 chars) | yes | (in the path) The permission key. |

Delegated calls also send `Uniora-Actor-Subject` (the end user, percent-encoded) and, when your server has no default label, `Uniora-Actor-Provider`.

**Response `200`**

| Field | Type | Description |
| --- | --- | --- |
| `id` | string (≤ 200 chars) |  |
| `organizationId` | string (≤ 200 chars) |  |
| `key` | string (≤ 200 chars) |  |
| `name` | string (≤ 200 chars) |  |
| `isOwnerRole` | boolean | The protected Owner role: it passes every permission check. |
| `isSystem` | boolean |  |
| `description` | string (≤ 500 chars), may be absent |  |
| `version` | integer (1–…) | Send it back as `If-Match` to refuse changes made from a stale copy. |

**Errors of this operation** (besides the ones every call can meet: see [Errors](#errors))

- `400` `actor_required`
- `400` `identity_provider_required`
- `400` `identity_provider_reserved`
- `403` `access_escalation`
- `403` `access_owner_protected`
- `403` `access_self_change`
- `403` `access_target_stronger`
- `403` `forbidden`
- `404` `organization_not_found`
- `404` `role_not_found`
- `412` `role_version_conflict`
- `501` `actor_token_unsupported`

**Example: Take one away**

```bash
curl -X DELETE "https://uniora.example.com/v1/organizations/org_acme/roles/role_support/permissions/members.remove" \
  -H "Authorization: Bearer $UNIORA_API_KEY" \
  -H 'Uniora-Actor-Subject: mgr'
```

```ts
const result = await uniora.roles.revokePermission(
  {
    organizationId: "org_acme",
    roleId: "role_support",
    permissionKey: "members.remove",
  },
  { actor: { subject: "mgr" } },
);
```

```http
HTTP/1.1 200 OK
ETag: "5"

{
  "id": "role_support",
  "organizationId": "org_acme",
  "key": "support-agent",
  "name": "Support",
  "isOwnerRole": false,
  "isSystem": false,
  "description": "Answers tickets",
  "version": 5
}
```

### `POST /v1/organizations/:organizationId/roles/:roleId/clone`  <a id="roles-clone"></a>

**Copy a role under a new name** · operation `roles.clone`

The copy is never a system role and the Owner role cannot be cloned. The actor must hold every permission the role holds. A delegated call: it speaks for the end user in the `Uniora-Actor-Subject` header, needs the `actor:assert` scope as well, and succeeds only if that user may do it (the four anti-escalation rules apply to them).

- **Scope:** `roles:write` and `actor:assert`
- **Kind:** delegated (speaks for an end user)
- **Changes data:** yes (refused with `503 read_only` while the server is read-only)
- **`ETag`:** the answer carries the version of the resource

**Request**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `organizationId` | string (1–200 chars) | yes | (in the path) The organization. |
| `roleId` | string (1–200 chars) | yes | (in the path) The role. |
| `id` | string (1–200 chars) | no | Your own id for the copy; generated when omitted. |
| `name` | string (1–255 chars) | yes |  |
| `key` | string (1–100 chars) | no |  |
| `description` | string (1–500 chars) | no |  |

Delegated calls also send `Uniora-Actor-Subject` (the end user, percent-encoded) and, when your server has no default label, `Uniora-Actor-Provider`.

**Response `201`**

| Field | Type | Description |
| --- | --- | --- |
| `id` | string (≤ 200 chars) |  |
| `organizationId` | string (≤ 200 chars) |  |
| `key` | string (≤ 200 chars) |  |
| `name` | string (≤ 200 chars) |  |
| `isOwnerRole` | boolean | The protected Owner role: it passes every permission check. |
| `isSystem` | boolean |  |
| `description` | string (≤ 500 chars), may be absent |  |
| `version` | integer (1–…) | Send it back as `If-Match` to refuse changes made from a stale copy. |

**Errors of this operation** (besides the ones every call can meet: see [Errors](#errors))

- `400` `actor_required`
- `400` `identity_provider_required`
- `400` `identity_provider_reserved`
- `400` `owner_role_protected`
- `403` `access_escalation`
- `403` `access_owner_protected`
- `403` `access_self_change`
- `403` `access_target_stronger`
- `403` `forbidden`
- `404` `organization_not_found`
- `404` `role_not_found`
- `409` `role_exists`
- `409` `role_key_exists`
- `412` `role_version_conflict`
- `501` `actor_token_unsupported`

**Example: Copy it**

```bash
curl -X POST "https://uniora.example.com/v1/organizations/org_acme/roles/role_support/clone" \
  -H "Authorization: Bearer $UNIORA_API_KEY" \
  -H 'Uniora-Actor-Subject: mgr' \
  -H "Content-Type: application/json" \
  -d '{
    "id": "role_support_eu",
    "name": "Support EU"
  }'
```

```ts
const result = await uniora.roles.clone(
  {
    organizationId: "org_acme",
    roleId: "role_support",
    id: "role_support_eu",
    name: "Support EU",
  },
  { actor: { subject: "mgr" } },
);
```

```http
HTTP/1.1 201 Created
ETag: "1"

{
  "id": "role_support_eu",
  "organizationId": "org_acme",
  "key": "support-eu",
  "name": "Support EU",
  "isOwnerRole": false,
  "isSystem": false,
  "description": "Answers tickets",
  "version": 1
}
```

### `DELETE /v1/organizations/:organizationId/roles/:roleId`  <a id="roles-delete"></a>

**Delete a role** · operation `roles.delete`

`members` says what happens to the people who still hold it: `detach` (default) takes it from them, `reject` refuses while anyone holds it, and `reassignTo` gives them another role of the same organization. The Owner role and system roles cannot be deleted. A delegated call: it speaks for the end user in the `Uniora-Actor-Subject` header, needs the `actor:assert` scope as well, and succeeds only if that user may do it (the four anti-escalation rules apply to them).

- **Scope:** `roles:write` and `actor:assert`
- **Kind:** delegated (speaks for an end user)
- **Changes data:** yes (refused with `503 read_only` while the server is read-only)

**Request**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `organizationId` | string (1–200 chars) | yes | (in the path) The organization. |
| `roleId` | string (1–200 chars) | yes | (in the path) The role. |
| `members` | `detach` \| `reject` | no | (query) What to do with the holders. |
| `reassignTo` | string (1–200 chars) | no | (query) Give the holders this role instead. |

Delegated calls also send `Uniora-Actor-Subject` (the end user, percent-encoded) and, when your server has no default label, `Uniora-Actor-Provider`.

**Response `200`**

| Field | Type | Description |
| --- | --- | --- |
| `deleted` | boolean |  |

**Errors of this operation** (besides the ones every call can meet: see [Errors](#errors))

- `400` `actor_required`
- `400` `identity_provider_required`
- `400` `identity_provider_reserved`
- `400` `owner_role_protected`
- `400` `role_system_protected`
- `403` `access_escalation`
- `403` `access_owner_protected`
- `403` `access_self_change`
- `403` `access_target_stronger`
- `403` `forbidden`
- `404` `organization_not_found`
- `404` `role_not_found`
- `409` `role_in_use`
- `412` `role_version_conflict`
- `501` `actor_token_unsupported`

**Example: Delete the copy**

```bash
curl -X DELETE "https://uniora.example.com/v1/organizations/org_acme/roles/role_support_eu" \
  -H "Authorization: Bearer $UNIORA_API_KEY" \
  -H 'Uniora-Actor-Subject: mgr'
```

```ts
const result = await uniora.roles.delete(
  { organizationId: "org_acme", roleId: "role_support_eu" },
  { actor: { subject: "mgr" } },
);
```

```http
HTTP/1.1 200 OK

{
  "deleted": true
}
```

## Catalog

The permissions and features registered in the deployment.

### `GET /v1/permissions`  <a id="permissions-list"></a>

**The permission catalog** · operation `permissions.list`

Every permission the project has registered. The catalog is shared by all organizations; it holds definitions, not who has them.

- **Scope:** `organizations:read`
- **Kind:** application (your backend asks as itself)
- **Changes data:** no

**Request**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `limit` | integer (1–1000) | no | (query) Items per page. At most the server's maximum (100 unless configured). |
| `cursor` | string (1–600 chars) | no | (query) The `nextCursor` of the previous page. |
| `q` | string (1–200 chars) | no | (query) Case-insensitive text to look for. |

**Response `200`**

| Field | Type | Description |
| --- | --- | --- |
| `items` | array (≤ 1000) |  |
| `items[].key` | string (≤ 200 chars) |  |
| `items[].name` | string (≤ 200 chars), may be absent |  |
| `items[].description` | string (≤ 1000 chars), may be absent |  |
| `items[].group` | string (≤ 200 chars), may be absent |  |
| `items[].implies` | array (≤ 100), may be absent |  |
| `nextCursor` | string (≤ 600 chars) or `null` | Pass it back as `cursor` for the next page; `null` on the last one. |

**Errors of this operation** (besides the ones every call can meet: see [Errors](#errors))

- `400` `invalid_cursor`
- `400` `invalid_request`

**Example: The permissions of the deployment**

```bash
curl -X GET "https://uniora.example.com/v1/permissions?limit=5" \
  -H "Authorization: Bearer $UNIORA_API_KEY"
```

```ts
const result = await uniora.permissions.list({ limit: 5 });
```

```http
HTTP/1.1 200 OK

{
  "items": [
    {
      "key": "members.block"
    },
    {
      "key": "members.invite"
    },
    {
      "key": "members.remove"
    },
    {
      "key": "members.roles.manage"
    },
    {
      "key": "policies.activate"
    }
  ],
  "nextCursor": "EXAMPLE_OPAQUE_CURSOR"
}
```

### `GET /v1/features`  <a id="features-list"></a>

**The feature catalog** · operation `features.list`

Every feature the project has registered, with its default and parent. What an organization has unlocked is `organizations.features`.

- **Scope:** `organizations:read`
- **Kind:** application (your backend asks as itself)
- **Changes data:** no

**Request**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `limit` | integer (1–1000) | no | (query) Items per page. At most the server's maximum (100 unless configured). |
| `cursor` | string (1–600 chars) | no | (query) The `nextCursor` of the previous page. |
| `q` | string (1–200 chars) | no | (query) Case-insensitive text to look for. |

**Response `200`**

| Field | Type | Description |
| --- | --- | --- |
| `items` | array (≤ 1000) |  |
| `items[].key` | string (≤ 200 chars) |  |
| `items[].name` | string (≤ 200 chars) |  |
| `items[].description` | string (≤ 1000 chars), may be absent |  |
| `items[].defaultEnabled` | boolean |  |
| `items[].parentKey` | string (≤ 200 chars), may be absent |  |
| `nextCursor` | string (≤ 600 chars) or `null` | Pass it back as `cursor` for the next page; `null` on the last one. |

**Errors of this operation** (besides the ones every call can meet: see [Errors](#errors))

- `400` `invalid_cursor`
- `400` `invalid_request`

**Example: The features of the deployment**

```bash
curl -X GET "https://uniora.example.com/v1/features?limit=5" \
  -H "Authorization: Bearer $UNIORA_API_KEY"
```

```ts
const result = await uniora.features.list({ limit: 5 });
```

```http
HTTP/1.1 200 OK

{
  "items": [],
  "nextCursor": null
}
```

## Teams

Teams, their tree and their members.

### `GET /v1/organizations/:organizationId/teams`  <a id="teams-list"></a>

**List an organization's teams** · operation `teams.list`

Ordered by id. `q` matches the name or the slug; `parentId` lists the direct sub-teams of a team.

- **Scope:** `organizations:read`
- **Kind:** application (your backend asks as itself)
- **Changes data:** no

**Request**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `organizationId` | string (1–200 chars) | yes | (in the path) The organization. |
| `limit` | integer (1–1000) | no | (query) Items per page. At most the server's maximum (100 unless configured). |
| `cursor` | string (1–600 chars) | no | (query) The `nextCursor` of the previous page. |
| `q` | string (1–200 chars) | no | (query) Case-insensitive text to look for. |
| `status` | `active` \| `archived` | no | (query) |
| `parentId` | string (1–200 chars) | no | (query) Only the direct sub-teams of this team. |

**Response `200`**

| Field | Type | Description |
| --- | --- | --- |
| `items` | array (≤ 1000) |  |
| `items[].id` | string (≤ 200 chars) |  |
| `items[].organizationId` | string (≤ 200 chars) |  |
| `items[].slug` | string (≤ 200 chars) |  |
| `items[].name` | string (≤ 255 chars) |  |
| `items[].status` | `active` \| `archived` |  |
| `items[].parentId` | string (≤ 200 chars), may be absent | The team this one sits under. Organizational only: it grants and inherits nothing. |
| `items[].externalId` | string (≤ 200 chars), may be absent | Your own id for the team in another system. |
| `items[].metadata` | object (free keys) |  |
| `items[].settings` | object (free keys) |  |
| `items[].createdAt` | string (date-time) |  |
| `items[].updatedAt` | string (date-time) |  |
| `items[].archived` | object, may be absent | Present while the team is archived. |
| `items[].archived.at` | string (date-time) |  |
| `items[].archived.by` | object |  |
| `items[].archived.by.provider` | string (≤ 200 chars) |  |
| `items[].archived.by.subject` | string (≤ 500 chars) |  |
| `items[].archived.reason` | string (≤ 500 chars), may be absent |  |
| `items[].version` | integer (1–…) | Send it back as `If-Match` to refuse changes made from a stale copy. |
| `nextCursor` | string (≤ 600 chars) or `null` | Pass it back as `cursor` for the next page; `null` on the last one. |

**Errors of this operation** (besides the ones every call can meet: see [Errors](#errors))

- `400` `invalid_cursor`
- `404` `organization_not_found`

**Example: List the teams**

```bash
curl -X GET "https://uniora.example.com/v1/organizations/org_acme/teams?limit=10" \
  -H "Authorization: Bearer $UNIORA_API_KEY"
```

```ts
const result = await uniora.teams.list({ organizationId: "org_acme", limit: 10 });
```

```http
HTTP/1.1 200 OK

{
  "items": [
    {
      "id": "team_bcn",
      "organizationId": "org_acme",
      "slug": "barcelona",
      "name": "Barcelona",
      "status": "active",
      "metadata": {
        "region": "ES"
      },
      "settings": {},
      "createdAt": "2026-03-02T09:36:00.000Z",
      "updatedAt": "2026-03-02T09:37:00.000Z",
      "version": 1
    },
    {
      "id": "team_mad",
      "organizationId": "org_acme",
      "slug": "madrid",
      "name": "Madrid",
      "status": "active",
      "metadata": {},
      "settings": {},
      "createdAt": "2026-03-02T09:38:00.000Z",
      "updatedAt": "2026-03-02T09:39:00.000Z",
      "version": 1
    },
    {
      "id": "team_sants",
      "organizationId": "org_acme",
      "slug": "sants",
      "name": "Sants",
      "status": "active",
      "parentId": "team_bcn",
      "metadata": {},
      "settings": {},
      "createdAt": "2026-03-02T09:40:00.000Z",
      "updatedAt": "2026-03-02T09:41:00.000Z",
      "version": 1
    }
  ],
  "nextCursor": null
}
```

### `GET /v1/organizations/:organizationId/teams/:teamId`  <a id="teams-get"></a>

**Get a team** · operation `teams.get`

A team of another organization answers exactly like one that does not exist.

- **Scope:** `organizations:read`
- **Kind:** application (your backend asks as itself)
- **Changes data:** no
- **`ETag`:** the answer carries the version of the resource

**Request**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `organizationId` | string (1–200 chars) | yes | (in the path) The organization. |
| `teamId` | string (1–200 chars) | yes | (in the path) The team. |

**Response `200`**

| Field | Type | Description |
| --- | --- | --- |
| `id` | string (≤ 200 chars) |  |
| `organizationId` | string (≤ 200 chars) |  |
| `slug` | string (≤ 200 chars) |  |
| `name` | string (≤ 255 chars) |  |
| `status` | `active` \| `archived` |  |
| `parentId` | string (≤ 200 chars), may be absent | The team this one sits under. Organizational only: it grants and inherits nothing. |
| `externalId` | string (≤ 200 chars), may be absent | Your own id for the team in another system. |
| `metadata` | object (free keys) |  |
| `settings` | object (free keys) |  |
| `createdAt` | string (date-time) |  |
| `updatedAt` | string (date-time) |  |
| `archived` | object, may be absent | Present while the team is archived. |
| `archived.at` | string (date-time) |  |
| `archived.by` | object |  |
| `archived.by.provider` | string (≤ 200 chars) |  |
| `archived.by.subject` | string (≤ 500 chars) |  |
| `archived.reason` | string (≤ 500 chars), may be absent |  |
| `version` | integer (1–…) | Send it back as `If-Match` to refuse changes made from a stale copy. |

**Errors of this operation** (besides the ones every call can meet: see [Errors](#errors))

- `404` `organization_not_found`
- `404` `team_not_found`

**Example: Read a team**

```bash
curl -X GET "https://uniora.example.com/v1/organizations/org_acme/teams/team_bcn" \
  -H "Authorization: Bearer $UNIORA_API_KEY"
```

```ts
const result = await uniora.teams.get({ organizationId: "org_acme", teamId: "team_bcn" });
```

```http
HTTP/1.1 200 OK
ETag: "1"

{
  "id": "team_bcn",
  "organizationId": "org_acme",
  "slug": "barcelona",
  "name": "Barcelona",
  "status": "active",
  "metadata": {
    "region": "ES"
  },
  "settings": {},
  "createdAt": "2026-03-02T09:42:00.000Z",
  "updatedAt": "2026-03-02T09:43:00.000Z",
  "version": 1
}
```

### `GET /v1/organizations/:organizationId/teams/:teamId/members`  <a id="teams-members"></a>

**List the members of a team** · operation `teams.members`

Team memberships, ordered by id. Filter by `status` or `responsibility`.

- **Scope:** `organizations:read`
- **Kind:** application (your backend asks as itself)
- **Changes data:** no

**Request**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `organizationId` | string (1–200 chars) | yes | (in the path) The organization. |
| `teamId` | string (1–200 chars) | yes | (in the path) The team. |
| `limit` | integer (1–1000) | no | (query) Items per page. At most the server's maximum (100 unless configured). |
| `cursor` | string (1–600 chars) | no | (query) The `nextCursor` of the previous page. |
| `status` | `pending` \| `active` \| `suspended` \| `removed` | no | (query) |
| `responsibility` | `owner` \| `manager` \| `member` | no | (query) |

**Response `200`**

| Field | Type | Description |
| --- | --- | --- |
| `items` | array (≤ 1000) |  |
| `items[].id` | string (≤ 200 chars) |  |
| `items[].organizationId` | string (≤ 200 chars) |  |
| `items[].teamId` | string (≤ 200 chars) |  |
| `items[].membershipId` | string (≤ 200 chars) | The organization membership. |
| `items[].status` | `pending` \| `active` \| `suspended` \| `removed` |  |
| `items[].responsibility` | `owner` \| `manager` \| `member` | A label, not a permission. |
| `items[].roleIds` | array (≤ 100) | Roles of the organization that apply only inside this team. |
| `items[].createdAt` | string (date-time) |  |
| `items[].updatedAt` | string (date-time) |  |
| `items[].joinedAt` | string (date-time), may be absent |  |
| `items[].invitedBy` | object, may be absent |  |
| `items[].invitedBy.provider` | string (≤ 200 chars) |  |
| `items[].invitedBy.subject` | string (≤ 500 chars) |  |
| `items[].statusChange` | object, may be absent | The last status change. |
| `items[].statusChange.at` | string (date-time) |  |
| `items[].statusChange.by` | object |  |
| `items[].statusChange.by.provider` | string (≤ 200 chars) |  |
| `items[].statusChange.by.subject` | string (≤ 500 chars) |  |
| `items[].statusChange.reason` | string (≤ 500 chars), may be absent |  |
| `items[].version` | integer (1–…) |  |
| `nextCursor` | string (≤ 600 chars) or `null` | Pass it back as `cursor` for the next page; `null` on the last one. |

**Errors of this operation** (besides the ones every call can meet: see [Errors](#errors))

- `400` `invalid_cursor`
- `404` `organization_not_found`
- `404` `team_not_found`

**Example: List the members of a team**

```bash
curl -X GET "https://uniora.example.com/v1/organizations/org_acme/teams/team_bcn/members?status=active" \
  -H "Authorization: Bearer $UNIORA_API_KEY"
```

```ts
const result = await uniora.teams.members(
  { organizationId: "org_acme", teamId: "team_bcn", status: "active" },
);
```

```http
HTTP/1.1 200 OK

{
  "items": [
    {
      "id": "tm_ana",
      "organizationId": "org_acme",
      "teamId": "team_bcn",
      "membershipId": "mem_ana",
      "status": "active",
      "responsibility": "member",
      "roleIds": [],
      "createdAt": "2026-03-02T09:44:00.000Z",
      "updatedAt": "2026-03-02T09:45:00.000Z",
      "joinedAt": "2026-03-02T09:46:00.000Z",
      "invitedBy": {
        "provider": "main",
        "subject": "mgr"
      },
      "version": 1
    },
    {
      "id": "tm_bob",
      "organizationId": "org_acme",
      "teamId": "team_bcn",
      "membershipId": "mem_bob",
      "status": "active",
      "responsibility": "member",
      "roleIds": [],
      "createdAt": "2026-03-02T09:47:00.000Z",
      "updatedAt": "2026-03-02T09:48:00.000Z",
      "joinedAt": "2026-03-02T09:49:00.000Z",
      "invitedBy": {
        "provider": "main",
        "subject": "mgr"
      },
      "statusChange": {
        "at": "2026-03-02T09:50:00.000Z",
        "by": {
          "provider": "main",
          "subject": "bob"
        }
      },
      "version": 2
    }
  ],
  "nextCursor": null
}
```

### `POST /v1/organizations/:organizationId/teams`  <a id="teams-create"></a>

**Create a team** · operation `teams.create`

A team is context, not authority: belonging to it grants nothing by itself. Teams nest up to 8 levels with no cycles. A delegated call: it speaks for the end user in the `Uniora-Actor-Subject` header, needs the `actor:assert` scope as well, and succeeds only if that user may do it.

- **Scope:** `teams:write` and `actor:assert`
- **Kind:** delegated (speaks for an end user)
- **Changes data:** yes (refused with `503 read_only` while the server is read-only)
- **`ETag`:** the answer carries the version of the resource

**Request**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `organizationId` | string (1–200 chars) | yes | (in the path) The organization. |
| `id` | string (1–200 chars) | no | Your own id for the team; generated when omitted. |
| `name` | string (1–255 chars) | yes |  |
| `slug` | string (1–100 chars) | no | URL-safe, unique in the organization; derived from the name when omitted. |
| `externalId` | string (1–200 chars) | no | Your own id for the team in another system. |
| `parentId` | string (1–200 chars) | no | The team this one sits under. |
| `metadata` | object (free keys) | no |  |
| `settings` | object (free keys) | no |  |

Delegated calls also send `Uniora-Actor-Subject` (the end user, percent-encoded) and, when your server has no default label, `Uniora-Actor-Provider`.

**Response `201`**

| Field | Type | Description |
| --- | --- | --- |
| `id` | string (≤ 200 chars) |  |
| `organizationId` | string (≤ 200 chars) |  |
| `slug` | string (≤ 200 chars) |  |
| `name` | string (≤ 255 chars) |  |
| `status` | `active` \| `archived` |  |
| `parentId` | string (≤ 200 chars), may be absent | The team this one sits under. Organizational only: it grants and inherits nothing. |
| `externalId` | string (≤ 200 chars), may be absent | Your own id for the team in another system. |
| `metadata` | object (free keys) |  |
| `settings` | object (free keys) |  |
| `createdAt` | string (date-time) |  |
| `updatedAt` | string (date-time) |  |
| `archived` | object, may be absent | Present while the team is archived. |
| `archived.at` | string (date-time) |  |
| `archived.by` | object |  |
| `archived.by.provider` | string (≤ 200 chars) |  |
| `archived.by.subject` | string (≤ 500 chars) |  |
| `archived.reason` | string (≤ 500 chars), may be absent |  |
| `version` | integer (1–…) | Send it back as `If-Match` to refuse changes made from a stale copy. |

**Errors of this operation** (besides the ones every call can meet: see [Errors](#errors))

- `400` `actor_required`
- `400` `identity_provider_required`
- `400` `identity_provider_reserved`
- `400` `team_cycle`
- `400` `team_parent_invalid`
- `400` `team_too_deep`
- `403` `access_escalation`
- `403` `access_owner_protected`
- `403` `access_self_change`
- `403` `access_target_stronger`
- `403` `forbidden`
- `404` `organization_not_found`
- `409` `team_exists`
- `409` `team_external_id_taken`
- `409` `team_slug_taken`
- `501` `actor_token_unsupported`

**Example: A team**

```bash
curl -X POST "https://uniora.example.com/v1/organizations/org_acme/teams" \
  -H "Authorization: Bearer $UNIORA_API_KEY" \
  -H 'Uniora-Actor-Subject: mgr' \
  -H "Content-Type: application/json" \
  -d '{
    "id": "team_bcn",
    "name": "Barcelona",
    "metadata": {
      "region": "ES"
    }
  }'
```

```ts
const result = await uniora.teams.create(
  {
    organizationId: "org_acme",
    id: "team_bcn",
    name: "Barcelona",
    metadata: { region: "ES" },
  },
  { actor: { subject: "mgr" } },
);
```

```http
HTTP/1.1 201 Created
ETag: "1"
Location: /v1/organizations/org_acme/teams/team_bcn

{
  "id": "team_bcn",
  "organizationId": "org_acme",
  "slug": "barcelona",
  "name": "Barcelona",
  "status": "active",
  "metadata": {
    "region": "ES"
  },
  "settings": {},
  "createdAt": "2026-03-02T09:51:00.000Z",
  "updatedAt": "2026-03-02T09:52:00.000Z",
  "version": 1
}
```

**Example: A team under it**

```bash
curl -X POST "https://uniora.example.com/v1/organizations/org_acme/teams" \
  -H "Authorization: Bearer $UNIORA_API_KEY" \
  -H 'Uniora-Actor-Subject: mgr' \
  -H "Content-Type: application/json" \
  -d '{
    "id": "team_sants",
    "name": "Sants",
    "parentId": "team_bcn"
  }'
```

```ts
const result = await uniora.teams.create(
  {
    organizationId: "org_acme",
    id: "team_sants",
    name: "Sants",
    parentId: "team_bcn",
  },
  { actor: { subject: "mgr" } },
);
```

```http
HTTP/1.1 201 Created
ETag: "1"
Location: /v1/organizations/org_acme/teams/team_sants

{
  "id": "team_sants",
  "organizationId": "org_acme",
  "slug": "sants",
  "name": "Sants",
  "status": "active",
  "parentId": "team_bcn",
  "metadata": {},
  "settings": {},
  "createdAt": "2026-03-02T09:53:00.000Z",
  "updatedAt": "2026-03-02T09:54:00.000Z",
  "version": 1
}
```

**Example: Another top-level team**

```bash
curl -X POST "https://uniora.example.com/v1/organizations/org_acme/teams" \
  -H "Authorization: Bearer $UNIORA_API_KEY" \
  -H 'Uniora-Actor-Subject: mgr' \
  -H "Content-Type: application/json" \
  -d '{
    "id": "team_mad",
    "name": "Madrid"
  }'
```

```ts
const result = await uniora.teams.create(
  { organizationId: "org_acme", id: "team_mad", name: "Madrid" },
  { actor: { subject: "mgr" } },
);
```

```http
HTTP/1.1 201 Created
ETag: "1"
Location: /v1/organizations/org_acme/teams/team_mad

{
  "id": "team_mad",
  "organizationId": "org_acme",
  "slug": "madrid",
  "name": "Madrid",
  "status": "active",
  "metadata": {},
  "settings": {},
  "createdAt": "2026-03-02T09:55:00.000Z",
  "updatedAt": "2026-03-02T09:56:00.000Z",
  "version": 1
}
```

### `PATCH /v1/organizations/:organizationId/teams/:teamId`  <a id="teams-update"></a>

**Edit a team** · operation `teams.update`

Send only what changes. `null` clears `externalId` or moves the team to the top level (`parentId`). Send `If-Match` with the team's version to refuse a stale edit. A delegated call: it speaks for the end user in the `Uniora-Actor-Subject` header, needs the `actor:assert` scope as well, and succeeds only if that user may do it.

- **Scope:** `teams:write` and `actor:assert`
- **Kind:** delegated (speaks for an end user)
- **Changes data:** yes (refused with `503 read_only` while the server is read-only)
- **`If-Match`:** send the version you last saw; a stale one is a `412` and nothing changes
- **`ETag`:** the answer carries the version of the resource

**Request**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `organizationId` | string (1–200 chars) | yes | (in the path) The organization. |
| `teamId` | string (1–200 chars) | yes | (in the path) The team. |
| `name` | string (1–255 chars) | no |  |
| `slug` | string (1–100 chars) | no |  |
| `externalId` | string (1–200 chars) or `null` | no |  |
| `parentId` | string (1–200 chars) or `null` | no | The new parent team. |
| `metadata` | object (free keys) | no |  |
| `settings` | object (free keys) | no |  |

Delegated calls also send `Uniora-Actor-Subject` (the end user, percent-encoded) and, when your server has no default label, `Uniora-Actor-Provider`.

**Response `200`**

| Field | Type | Description |
| --- | --- | --- |
| `id` | string (≤ 200 chars) |  |
| `organizationId` | string (≤ 200 chars) |  |
| `slug` | string (≤ 200 chars) |  |
| `name` | string (≤ 255 chars) |  |
| `status` | `active` \| `archived` |  |
| `parentId` | string (≤ 200 chars), may be absent | The team this one sits under. Organizational only: it grants and inherits nothing. |
| `externalId` | string (≤ 200 chars), may be absent | Your own id for the team in another system. |
| `metadata` | object (free keys) |  |
| `settings` | object (free keys) |  |
| `createdAt` | string (date-time) |  |
| `updatedAt` | string (date-time) |  |
| `archived` | object, may be absent | Present while the team is archived. |
| `archived.at` | string (date-time) |  |
| `archived.by` | object |  |
| `archived.by.provider` | string (≤ 200 chars) |  |
| `archived.by.subject` | string (≤ 500 chars) |  |
| `archived.reason` | string (≤ 500 chars), may be absent |  |
| `version` | integer (1–…) | Send it back as `If-Match` to refuse changes made from a stale copy. |

**Errors of this operation** (besides the ones every call can meet: see [Errors](#errors))

- `400` `actor_required`
- `400` `identity_provider_required`
- `400` `identity_provider_reserved`
- `400` `team_cycle`
- `400` `team_parent_invalid`
- `400` `team_too_deep`
- `403` `access_escalation`
- `403` `access_owner_protected`
- `403` `access_self_change`
- `403` `access_target_stronger`
- `403` `forbidden`
- `404` `organization_not_found`
- `404` `team_not_found`
- `409` `team_archived`
- `409` `team_external_id_taken`
- `409` `team_slug_taken`
- `412` `team_version_conflict`
- `501` `actor_token_unsupported`

**Example: Edit a team**

```bash
curl -X PATCH "https://uniora.example.com/v1/organizations/org_acme/teams/team_bcn" \
  -H "Authorization: Bearer $UNIORA_API_KEY" \
  -H 'Uniora-Actor-Subject: mgr' \
  -H "Content-Type: application/json" \
  -d '{
    "externalId": "ERP-BCN-01"
  }'
```

```ts
const result = await uniora.teams.update(
  {
    organizationId: "org_acme",
    teamId: "team_bcn",
    externalId: "ERP-BCN-01",
  },
  { actor: { subject: "mgr" } },
);
```

```http
HTTP/1.1 200 OK
ETag: "2"

{
  "id": "team_bcn",
  "organizationId": "org_acme",
  "slug": "barcelona",
  "name": "Barcelona",
  "status": "active",
  "externalId": "ERP-BCN-01",
  "metadata": {
    "region": "ES"
  },
  "settings": {},
  "createdAt": "2026-03-02T09:57:00.000Z",
  "updatedAt": "2026-03-02T09:58:00.000Z",
  "version": 2
}
```

### `POST /v1/organizations/:organizationId/teams/:teamId/archive`  <a id="teams-archive"></a>

**Archive a team** · operation `teams.archive`

An archived team keeps its history and accepts no changes until restored. Refused while it still has active sub-teams: archive those first (`team_has_children`). A delegated call: it speaks for the end user in the `Uniora-Actor-Subject` header, needs the `actor:assert` scope as well, and succeeds only if that user may do it.

- **Scope:** `teams:write` and `actor:assert`
- **Kind:** delegated (speaks for an end user)
- **Changes data:** yes (refused with `503 read_only` while the server is read-only)
- **`If-Match`:** send the version you last saw; a stale one is a `412` and nothing changes
- **`ETag`:** the answer carries the version of the resource

**Request**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `organizationId` | string (1–200 chars) | yes | (in the path) The organization. |
| `teamId` | string (1–200 chars) | yes | (in the path) The team. |
| `reason` | string (1–500 chars) | no | Why. Kept in the audit log. |

Delegated calls also send `Uniora-Actor-Subject` (the end user, percent-encoded) and, when your server has no default label, `Uniora-Actor-Provider`.

**Response `200`**

| Field | Type | Description |
| --- | --- | --- |
| `id` | string (≤ 200 chars) |  |
| `organizationId` | string (≤ 200 chars) |  |
| `slug` | string (≤ 200 chars) |  |
| `name` | string (≤ 255 chars) |  |
| `status` | `active` \| `archived` |  |
| `parentId` | string (≤ 200 chars), may be absent | The team this one sits under. Organizational only: it grants and inherits nothing. |
| `externalId` | string (≤ 200 chars), may be absent | Your own id for the team in another system. |
| `metadata` | object (free keys) |  |
| `settings` | object (free keys) |  |
| `createdAt` | string (date-time) |  |
| `updatedAt` | string (date-time) |  |
| `archived` | object, may be absent | Present while the team is archived. |
| `archived.at` | string (date-time) |  |
| `archived.by` | object |  |
| `archived.by.provider` | string (≤ 200 chars) |  |
| `archived.by.subject` | string (≤ 500 chars) |  |
| `archived.reason` | string (≤ 500 chars), may be absent |  |
| `version` | integer (1–…) | Send it back as `If-Match` to refuse changes made from a stale copy. |

**Errors of this operation** (besides the ones every call can meet: see [Errors](#errors))

- `400` `actor_required`
- `400` `identity_provider_required`
- `400` `identity_provider_reserved`
- `403` `access_escalation`
- `403` `access_owner_protected`
- `403` `access_self_change`
- `403` `access_target_stronger`
- `403` `forbidden`
- `404` `organization_not_found`
- `404` `team_not_found`
- `409` `team_has_children`
- `412` `team_version_conflict`
- `501` `actor_token_unsupported`

**Example: Archive a team (sub-teams first)**

```bash
curl -X POST "https://uniora.example.com/v1/organizations/org_acme/teams/team_bcn/archive" \
  -H "Authorization: Bearer $UNIORA_API_KEY" \
  -H 'Uniora-Actor-Subject: mgr' \
  -H "Content-Type: application/json" \
  -d '{
    "reason": "closed"
  }'
```

```ts
await uniora.teams.archive(
  { organizationId: "org_acme", teamId: "team_bcn", reason: "closed" },
  { actor: { subject: "mgr" } },
);
```

```http
HTTP/1.1 409 Conflict

{
  "type": "urn:uniora:error:team_has_children",
  "title": "Conflict",
  "status": 409,
  "code": "team_has_children",
  "requestId": "req_xxxxxxxxxxxxxxx8"
}
```

**Example: Archive the sub-team**

```bash
curl -X POST "https://uniora.example.com/v1/organizations/org_acme/teams/team_sants/archive" \
  -H "Authorization: Bearer $UNIORA_API_KEY" \
  -H 'Uniora-Actor-Subject: mgr' \
  -H "Content-Type: application/json" \
  -d '{
    "reason": "closed"
  }'
```

```ts
const result = await uniora.teams.archive(
  { organizationId: "org_acme", teamId: "team_sants", reason: "closed" },
  { actor: { subject: "mgr" } },
);
```

```http
HTTP/1.1 200 OK
ETag: "2"

{
  "id": "team_sants",
  "organizationId": "org_acme",
  "slug": "sants",
  "name": "Sants",
  "status": "archived",
  "parentId": "team_bcn",
  "metadata": {},
  "settings": {},
  "createdAt": "2026-03-02T09:59:00.000Z",
  "updatedAt": "2026-03-02T10:00:00.000Z",
  "archived": {
    "at": "2026-03-02T10:01:00.000Z",
    "by": {
      "provider": "main",
      "subject": "mgr"
    },
    "reason": "closed"
  },
  "version": 2
}
```

**Example: Archive it again**

```bash
curl -X POST "https://uniora.example.com/v1/organizations/org_acme/teams/team_sants/archive" \
  -H "Authorization: Bearer $UNIORA_API_KEY" \
  -H 'Uniora-Actor-Subject: mgr' \
  -H "Content-Type: application/json" \
  -d '{}'
```

```ts
const result = await uniora.teams.archive(
  { organizationId: "org_acme", teamId: "team_sants" },
  { actor: { subject: "mgr" } },
);
```

```http
HTTP/1.1 200 OK
ETag: "4"

{
  "id": "team_sants",
  "organizationId": "org_acme",
  "slug": "sants",
  "name": "Sants",
  "status": "archived",
  "parentId": "team_bcn",
  "metadata": {},
  "settings": {},
  "createdAt": "2026-03-02T10:02:00.000Z",
  "updatedAt": "2026-03-02T10:03:00.000Z",
  "archived": {
    "at": "2026-03-02T10:04:00.000Z",
    "by": {
      "provider": "main",
      "subject": "mgr"
    }
  },
  "version": 4
}
```

### `POST /v1/organizations/:organizationId/teams/:teamId/restore`  <a id="teams-restore"></a>

**Restore an archived team** · operation `teams.restore`

Brings the team back to normal operation. A delegated call: it speaks for the end user in the `Uniora-Actor-Subject` header, needs the `actor:assert` scope as well, and succeeds only if that user may do it.

- **Scope:** `teams:write` and `actor:assert`
- **Kind:** delegated (speaks for an end user)
- **Changes data:** yes (refused with `503 read_only` while the server is read-only)
- **`If-Match`:** send the version you last saw; a stale one is a `412` and nothing changes
- **`ETag`:** the answer carries the version of the resource

**Request**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `organizationId` | string (1–200 chars) | yes | (in the path) The organization. |
| `teamId` | string (1–200 chars) | yes | (in the path) The team. |

Delegated calls also send `Uniora-Actor-Subject` (the end user, percent-encoded) and, when your server has no default label, `Uniora-Actor-Provider`.

**Response `200`**

| Field | Type | Description |
| --- | --- | --- |
| `id` | string (≤ 200 chars) |  |
| `organizationId` | string (≤ 200 chars) |  |
| `slug` | string (≤ 200 chars) |  |
| `name` | string (≤ 255 chars) |  |
| `status` | `active` \| `archived` |  |
| `parentId` | string (≤ 200 chars), may be absent | The team this one sits under. Organizational only: it grants and inherits nothing. |
| `externalId` | string (≤ 200 chars), may be absent | Your own id for the team in another system. |
| `metadata` | object (free keys) |  |
| `settings` | object (free keys) |  |
| `createdAt` | string (date-time) |  |
| `updatedAt` | string (date-time) |  |
| `archived` | object, may be absent | Present while the team is archived. |
| `archived.at` | string (date-time) |  |
| `archived.by` | object |  |
| `archived.by.provider` | string (≤ 200 chars) |  |
| `archived.by.subject` | string (≤ 500 chars) |  |
| `archived.reason` | string (≤ 500 chars), may be absent |  |
| `version` | integer (1–…) | Send it back as `If-Match` to refuse changes made from a stale copy. |

**Errors of this operation** (besides the ones every call can meet: see [Errors](#errors))

- `400` `actor_required`
- `400` `identity_provider_required`
- `400` `identity_provider_reserved`
- `403` `access_escalation`
- `403` `access_owner_protected`
- `403` `access_self_change`
- `403` `access_target_stronger`
- `403` `forbidden`
- `404` `organization_not_found`
- `404` `team_not_found`
- `409` `team_not_archived`
- `412` `team_version_conflict`
- `501` `actor_token_unsupported`

**Example: Restore it**

```bash
curl -X POST "https://uniora.example.com/v1/organizations/org_acme/teams/team_sants/restore" \
  -H "Authorization: Bearer $UNIORA_API_KEY" \
  -H 'Uniora-Actor-Subject: mgr'
```

```ts
const result = await uniora.teams.restore(
  { organizationId: "org_acme", teamId: "team_sants" },
  { actor: { subject: "mgr" } },
);
```

```http
HTTP/1.1 200 OK
ETag: "3"

{
  "id": "team_sants",
  "organizationId": "org_acme",
  "slug": "sants",
  "name": "Sants",
  "status": "active",
  "parentId": "team_bcn",
  "metadata": {},
  "settings": {},
  "createdAt": "2026-03-02T10:05:00.000Z",
  "updatedAt": "2026-03-02T10:06:00.000Z",
  "version": 3
}
```

### `DELETE /v1/organizations/:organizationId/teams/:teamId`  <a id="teams-delete"></a>

**Delete a team** · operation `teams.delete`

Only an archived team can be deleted, and only once it has no sub-teams. Archiving alone keeps the history. A delegated call: it speaks for the end user in the `Uniora-Actor-Subject` header, needs the `actor:assert` scope as well, and succeeds only if that user may do it.

- **Scope:** `teams:write` and `actor:assert`
- **Kind:** delegated (speaks for an end user)
- **Changes data:** yes (refused with `503 read_only` while the server is read-only)

**Request**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `organizationId` | string (1–200 chars) | yes | (in the path) The organization. |
| `teamId` | string (1–200 chars) | yes | (in the path) The team. |

Delegated calls also send `Uniora-Actor-Subject` (the end user, percent-encoded) and, when your server has no default label, `Uniora-Actor-Provider`.

**Response `200`**

| Field | Type | Description |
| --- | --- | --- |
| `deleted` | boolean |  |

**Errors of this operation** (besides the ones every call can meet: see [Errors](#errors))

- `400` `actor_required`
- `400` `identity_provider_required`
- `400` `identity_provider_reserved`
- `403` `access_escalation`
- `403` `access_owner_protected`
- `403` `access_self_change`
- `403` `access_target_stronger`
- `403` `forbidden`
- `404` `organization_not_found`
- `404` `team_not_found`
- `409` `team_has_children`
- `409` `team_not_archived`
- `412` `team_version_conflict`
- `501` `actor_token_unsupported`

**Example: Delete an archived team**

```bash
curl -X DELETE "https://uniora.example.com/v1/organizations/org_acme/teams/team_sants" \
  -H "Authorization: Bearer $UNIORA_API_KEY" \
  -H 'Uniora-Actor-Subject: mgr'
```

```ts
const result = await uniora.teams.delete(
  { organizationId: "org_acme", teamId: "team_sants" },
  { actor: { subject: "mgr" } },
);
```

```http
HTTP/1.1 200 OK

{
  "deleted": true
}
```

### `POST /v1/organizations/:organizationId/teams/:teamId/members`  <a id="teams-addmember"></a>

**Add a member to a team, or invite them** · operation `teams.addMember`

Needs `teams.members.add`, even for oneself. With `status: "pending"` the person must accept. The roles given apply only inside this team, and only if the actor holds every permission in them. A delegated call: it speaks for the end user in the `Uniora-Actor-Subject` header, needs the `actor:assert` scope as well, and succeeds only if that user may do it.

- **Scope:** `teams:write` and `actor:assert`
- **Kind:** delegated (speaks for an end user)
- **Changes data:** yes (refused with `503 read_only` while the server is read-only)
- **`ETag`:** the answer carries the version of the resource

**Request**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `organizationId` | string (1–200 chars) | yes | (in the path) The organization. |
| `teamId` | string (1–200 chars) | yes | (in the path) The team. |
| `id` | string (1–200 chars) | no | Your own id for the team membership; generated when omitted. |
| `membershipId` | string (1–200 chars) | yes | The organization membership to add. |
| `status` | `pending` \| `active` | no |  |
| `responsibility` | `owner` \| `manager` \| `member` | no |  |
| `roleIds` | array (≤ 50) | no |  |

Delegated calls also send `Uniora-Actor-Subject` (the end user, percent-encoded) and, when your server has no default label, `Uniora-Actor-Provider`.

**Response `201`**

| Field | Type | Description |
| --- | --- | --- |
| `id` | string (≤ 200 chars) |  |
| `organizationId` | string (≤ 200 chars) |  |
| `teamId` | string (≤ 200 chars) |  |
| `membershipId` | string (≤ 200 chars) | The organization membership. |
| `status` | `pending` \| `active` \| `suspended` \| `removed` |  |
| `responsibility` | `owner` \| `manager` \| `member` | A label, not a permission. |
| `roleIds` | array (≤ 100) | Roles of the organization that apply only inside this team. |
| `createdAt` | string (date-time) |  |
| `updatedAt` | string (date-time) |  |
| `joinedAt` | string (date-time), may be absent |  |
| `invitedBy` | object, may be absent |  |
| `invitedBy.provider` | string (≤ 200 chars) |  |
| `invitedBy.subject` | string (≤ 500 chars) |  |
| `statusChange` | object, may be absent | The last status change. |
| `statusChange.at` | string (date-time) |  |
| `statusChange.by` | object |  |
| `statusChange.by.provider` | string (≤ 200 chars) |  |
| `statusChange.by.subject` | string (≤ 500 chars) |  |
| `statusChange.reason` | string (≤ 500 chars), may be absent |  |
| `version` | integer (1–…) |  |

**Errors of this operation** (besides the ones every call can meet: see [Errors](#errors))

- `400` `actor_required`
- `400` `identity_provider_required`
- `400` `identity_provider_reserved`
- `400` `team_role_invalid`
- `403` `access_escalation`
- `403` `access_owner_protected`
- `403` `access_self_change`
- `403` `access_target_stronger`
- `403` `forbidden`
- `404` `organization_not_found`
- `404` `team_member_unknown`
- `404` `team_not_found`
- `409` `team_archived`
- `409` `team_membership_exists`
- `412` `team_version_conflict`
- `501` `actor_token_unsupported`

**Example: Add a member**

```bash
curl -X POST "https://uniora.example.com/v1/organizations/org_acme/teams/team_bcn/members" \
  -H "Authorization: Bearer $UNIORA_API_KEY" \
  -H 'Uniora-Actor-Subject: mgr' \
  -H "Content-Type: application/json" \
  -d '{
    "id": "tm_ana",
    "membershipId": "mem_ana"
  }'
```

```ts
const result = await uniora.teams.addMember(
  {
    organizationId: "org_acme",
    teamId: "team_bcn",
    id: "tm_ana",
    membershipId: "mem_ana",
  },
  { actor: { subject: "mgr" } },
);
```

```http
HTTP/1.1 201 Created
ETag: "1"

{
  "id": "tm_ana",
  "organizationId": "org_acme",
  "teamId": "team_bcn",
  "membershipId": "mem_ana",
  "status": "active",
  "responsibility": "member",
  "roleIds": [],
  "createdAt": "2026-03-02T10:07:00.000Z",
  "updatedAt": "2026-03-02T10:08:00.000Z",
  "joinedAt": "2026-03-02T10:09:00.000Z",
  "invitedBy": {
    "provider": "main",
    "subject": "mgr"
  },
  "version": 1
}
```

**Example: Invite a member: they must accept**

```bash
curl -X POST "https://uniora.example.com/v1/organizations/org_acme/teams/team_bcn/members" \
  -H "Authorization: Bearer $UNIORA_API_KEY" \
  -H 'Uniora-Actor-Subject: mgr' \
  -H "Content-Type: application/json" \
  -d '{
    "id": "tm_bob",
    "membershipId": "mem_bob",
    "status": "pending"
  }'
```

```ts
const result = await uniora.teams.addMember(
  {
    organizationId: "org_acme",
    teamId: "team_bcn",
    id: "tm_bob",
    membershipId: "mem_bob",
    status: "pending",
  },
  { actor: { subject: "mgr" } },
);
```

```http
HTTP/1.1 201 Created
ETag: "1"

{
  "id": "tm_bob",
  "organizationId": "org_acme",
  "teamId": "team_bcn",
  "membershipId": "mem_bob",
  "status": "pending",
  "responsibility": "member",
  "roleIds": [],
  "createdAt": "2026-03-02T10:10:00.000Z",
  "updatedAt": "2026-03-02T10:11:00.000Z",
  "invitedBy": {
    "provider": "main",
    "subject": "mgr"
  },
  "version": 1
}
```

### `POST /v1/organizations/:organizationId/teams/:teamId/leave`  <a id="teams-leave"></a>

**The actor leaves a team, or declines an invitation** · operation `teams.leave`

Always allowed for oneself. A delegated call: it speaks for the end user in the `Uniora-Actor-Subject` header, needs the `actor:assert` scope as well, and succeeds only if that user may do it.

- **Scope:** `teams:write` and `actor:assert`
- **Kind:** delegated (speaks for an end user)
- **Changes data:** yes (refused with `503 read_only` while the server is read-only)
- **`ETag`:** the answer carries the version of the resource

**Request**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `organizationId` | string (1–200 chars) | yes | (in the path) The organization. |
| `teamId` | string (1–200 chars) | yes | (in the path) The team. |

Delegated calls also send `Uniora-Actor-Subject` (the end user, percent-encoded) and, when your server has no default label, `Uniora-Actor-Provider`.

**Response `200`**

| Field | Type | Description |
| --- | --- | --- |
| `id` | string (≤ 200 chars) |  |
| `organizationId` | string (≤ 200 chars) |  |
| `teamId` | string (≤ 200 chars) |  |
| `membershipId` | string (≤ 200 chars) | The organization membership. |
| `status` | `pending` \| `active` \| `suspended` \| `removed` |  |
| `responsibility` | `owner` \| `manager` \| `member` | A label, not a permission. |
| `roleIds` | array (≤ 100) | Roles of the organization that apply only inside this team. |
| `createdAt` | string (date-time) |  |
| `updatedAt` | string (date-time) |  |
| `joinedAt` | string (date-time), may be absent |  |
| `invitedBy` | object, may be absent |  |
| `invitedBy.provider` | string (≤ 200 chars) |  |
| `invitedBy.subject` | string (≤ 500 chars) |  |
| `statusChange` | object, may be absent | The last status change. |
| `statusChange.at` | string (date-time) |  |
| `statusChange.by` | object |  |
| `statusChange.by.provider` | string (≤ 200 chars) |  |
| `statusChange.by.subject` | string (≤ 500 chars) |  |
| `statusChange.reason` | string (≤ 500 chars), may be absent |  |
| `version` | integer (1–…) |  |

**Errors of this operation** (besides the ones every call can meet: see [Errors](#errors))

- `400` `actor_required`
- `400` `identity_provider_required`
- `400` `identity_provider_reserved`
- `403` `access_escalation`
- `403` `access_owner_protected`
- `403` `access_self_change`
- `403` `access_target_stronger`
- `403` `forbidden`
- `404` `organization_not_found`
- `404` `team_membership_not_found`
- `404` `team_not_found`
- `412` `team_version_conflict`
- `501` `actor_token_unsupported`

**Example: The actor leaves a team**

```bash
curl -X POST "https://uniora.example.com/v1/organizations/org_acme/teams/team_mad/leave" \
  -H "Authorization: Bearer $UNIORA_API_KEY" \
  -H 'Uniora-Actor-Subject: ana'
```

```ts
const result = await uniora.teams.leave(
  { organizationId: "org_acme", teamId: "team_mad" },
  { actor: { subject: "ana" } },
);
```

```http
HTTP/1.1 200 OK
ETag: "2"

{
  "id": "tm_ana_mad",
  "organizationId": "org_acme",
  "teamId": "team_mad",
  "membershipId": "mem_ana",
  "status": "removed",
  "responsibility": "member",
  "roleIds": [],
  "createdAt": "2026-03-02T10:12:00.000Z",
  "updatedAt": "2026-03-02T10:13:00.000Z",
  "joinedAt": "2026-03-02T10:14:00.000Z",
  "invitedBy": {
    "provider": "main",
    "subject": "mgr"
  },
  "statusChange": {
    "at": "2026-03-02T10:15:00.000Z",
    "by": {
      "provider": "main",
      "subject": "ana"
    },
    "reason": "left"
  },
  "version": 2
}
```

### `POST /v1/organizations/:organizationId/team-memberships/:teamMembershipId/accept`  <a id="teammembers-accept"></a>

**Accept a team invitation** · operation `teamMembers.accept`

Only the invited person can accept their own invitation. A delegated call: it speaks for the end user in the `Uniora-Actor-Subject` header, needs the `actor:assert` scope as well, and succeeds only if that user may do it.

- **Scope:** `teams:write` and `actor:assert`
- **Kind:** delegated (speaks for an end user)
- **Changes data:** yes (refused with `503 read_only` while the server is read-only)
- **`ETag`:** the answer carries the version of the resource

**Request**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `organizationId` | string (1–200 chars) | yes | (in the path) The organization. |
| `teamMembershipId` | string (1–200 chars) | yes | (in the path) The team membership (not the organization membership). |

Delegated calls also send `Uniora-Actor-Subject` (the end user, percent-encoded) and, when your server has no default label, `Uniora-Actor-Provider`.

**Response `200`**

| Field | Type | Description |
| --- | --- | --- |
| `id` | string (≤ 200 chars) |  |
| `organizationId` | string (≤ 200 chars) |  |
| `teamId` | string (≤ 200 chars) |  |
| `membershipId` | string (≤ 200 chars) | The organization membership. |
| `status` | `pending` \| `active` \| `suspended` \| `removed` |  |
| `responsibility` | `owner` \| `manager` \| `member` | A label, not a permission. |
| `roleIds` | array (≤ 100) | Roles of the organization that apply only inside this team. |
| `createdAt` | string (date-time) |  |
| `updatedAt` | string (date-time) |  |
| `joinedAt` | string (date-time), may be absent |  |
| `invitedBy` | object, may be absent |  |
| `invitedBy.provider` | string (≤ 200 chars) |  |
| `invitedBy.subject` | string (≤ 500 chars) |  |
| `statusChange` | object, may be absent | The last status change. |
| `statusChange.at` | string (date-time) |  |
| `statusChange.by` | object |  |
| `statusChange.by.provider` | string (≤ 200 chars) |  |
| `statusChange.by.subject` | string (≤ 500 chars) |  |
| `statusChange.reason` | string (≤ 500 chars), may be absent |  |
| `version` | integer (1–…) |  |

**Errors of this operation** (besides the ones every call can meet: see [Errors](#errors))

- `400` `actor_required`
- `400` `identity_provider_required`
- `400` `identity_provider_reserved`
- `403` `access_escalation`
- `403` `access_owner_protected`
- `403` `access_self_change`
- `403` `access_target_stronger`
- `403` `forbidden`
- `404` `organization_not_found`
- `404` `team_membership_not_found`
- `409` `team_membership_transition_invalid`
- `501` `actor_token_unsupported`

**Example: The invited person accepts**

```bash
curl -X POST "https://uniora.example.com/v1/organizations/org_acme/team-memberships/tm_bob/accept" \
  -H "Authorization: Bearer $UNIORA_API_KEY" \
  -H 'Uniora-Actor-Subject: bob'
```

```ts
const result = await uniora.teamMembers.accept(
  { organizationId: "org_acme", teamMembershipId: "tm_bob" },
  { actor: { subject: "bob" } },
);
```

```http
HTTP/1.1 200 OK
ETag: "2"

{
  "id": "tm_bob",
  "organizationId": "org_acme",
  "teamId": "team_bcn",
  "membershipId": "mem_bob",
  "status": "active",
  "responsibility": "member",
  "roleIds": [],
  "createdAt": "2026-03-02T10:16:00.000Z",
  "updatedAt": "2026-03-02T10:17:00.000Z",
  "joinedAt": "2026-03-02T10:18:00.000Z",
  "invitedBy": {
    "provider": "main",
    "subject": "mgr"
  },
  "statusChange": {
    "at": "2026-03-02T10:19:00.000Z",
    "by": {
      "provider": "main",
      "subject": "bob"
    }
  },
  "version": 2
}
```

### `DELETE /v1/organizations/:organizationId/team-memberships/:teamMembershipId`  <a id="teammembers-remove"></a>

**Remove someone from a team** · operation `teamMembers.remove`

The row stays for the record and can be added again. Needs `teams.members.remove`. A delegated call: it speaks for the end user in the `Uniora-Actor-Subject` header, needs the `actor:assert` scope as well, and succeeds only if that user may do it.

- **Scope:** `teams:write` and `actor:assert`
- **Kind:** delegated (speaks for an end user)
- **Changes data:** yes (refused with `503 read_only` while the server is read-only)
- **`ETag`:** the answer carries the version of the resource

**Request**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `organizationId` | string (1–200 chars) | yes | (in the path) The organization. |
| `teamMembershipId` | string (1–200 chars) | yes | (in the path) The team membership (not the organization membership). |
| `reason` | string (1–500 chars) | no | (query) Why. Kept in the audit log. |

Delegated calls also send `Uniora-Actor-Subject` (the end user, percent-encoded) and, when your server has no default label, `Uniora-Actor-Provider`.

**Response `200`**

| Field | Type | Description |
| --- | --- | --- |
| `id` | string (≤ 200 chars) |  |
| `organizationId` | string (≤ 200 chars) |  |
| `teamId` | string (≤ 200 chars) |  |
| `membershipId` | string (≤ 200 chars) | The organization membership. |
| `status` | `pending` \| `active` \| `suspended` \| `removed` |  |
| `responsibility` | `owner` \| `manager` \| `member` | A label, not a permission. |
| `roleIds` | array (≤ 100) | Roles of the organization that apply only inside this team. |
| `createdAt` | string (date-time) |  |
| `updatedAt` | string (date-time) |  |
| `joinedAt` | string (date-time), may be absent |  |
| `invitedBy` | object, may be absent |  |
| `invitedBy.provider` | string (≤ 200 chars) |  |
| `invitedBy.subject` | string (≤ 500 chars) |  |
| `statusChange` | object, may be absent | The last status change. |
| `statusChange.at` | string (date-time) |  |
| `statusChange.by` | object |  |
| `statusChange.by.provider` | string (≤ 200 chars) |  |
| `statusChange.by.subject` | string (≤ 500 chars) |  |
| `statusChange.reason` | string (≤ 500 chars), may be absent |  |
| `version` | integer (1–…) |  |

**Errors of this operation** (besides the ones every call can meet: see [Errors](#errors))

- `400` `actor_required`
- `400` `identity_provider_required`
- `400` `identity_provider_reserved`
- `403` `access_escalation`
- `403` `access_owner_protected`
- `403` `access_self_change`
- `403` `access_target_stronger`
- `403` `forbidden`
- `404` `organization_not_found`
- `404` `team_membership_not_found`
- `409` `team_membership_transition_invalid`
- `501` `actor_token_unsupported`

**Example: Remove someone from a team**

```bash
curl -X DELETE "https://uniora.example.com/v1/organizations/org_acme/team-memberships/tm_bob?reason=left+the+project" \
  -H "Authorization: Bearer $UNIORA_API_KEY" \
  -H 'Uniora-Actor-Subject: mgr'
```

```ts
const result = await uniora.teamMembers.remove(
  {
    organizationId: "org_acme",
    teamMembershipId: "tm_bob",
    reason: "left the project",
  },
  { actor: { subject: "mgr" } },
);
```

```http
HTTP/1.1 200 OK
ETag: "3"

{
  "id": "tm_bob",
  "organizationId": "org_acme",
  "teamId": "team_bcn",
  "membershipId": "mem_bob",
  "status": "removed",
  "responsibility": "member",
  "roleIds": [],
  "createdAt": "2026-03-02T10:20:00.000Z",
  "updatedAt": "2026-03-02T10:21:00.000Z",
  "joinedAt": "2026-03-02T10:22:00.000Z",
  "invitedBy": {
    "provider": "main",
    "subject": "mgr"
  },
  "statusChange": {
    "at": "2026-03-02T10:23:00.000Z",
    "by": {
      "provider": "main",
      "subject": "mgr"
    },
    "reason": "left the project"
  },
  "version": 3
}
```

### `POST /v1/organizations/:organizationId/team-memberships/:teamMembershipId/suspend`  <a id="teammembers-suspend"></a>

**Suspend a team membership** · operation `teamMembers.suspend`

The relation exists but stops counting for now. A delegated call: it speaks for the end user in the `Uniora-Actor-Subject` header, needs the `actor:assert` scope as well, and succeeds only if that user may do it.

- **Scope:** `teams:write` and `actor:assert`
- **Kind:** delegated (speaks for an end user)
- **Changes data:** yes (refused with `503 read_only` while the server is read-only)
- **`ETag`:** the answer carries the version of the resource

**Request**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `organizationId` | string (1–200 chars) | yes | (in the path) The organization. |
| `teamMembershipId` | string (1–200 chars) | yes | (in the path) The team membership (not the organization membership). |
| `reason` | string (1–500 chars) | no | Why. Kept in the audit log. |

Delegated calls also send `Uniora-Actor-Subject` (the end user, percent-encoded) and, when your server has no default label, `Uniora-Actor-Provider`.

**Response `200`**

| Field | Type | Description |
| --- | --- | --- |
| `id` | string (≤ 200 chars) |  |
| `organizationId` | string (≤ 200 chars) |  |
| `teamId` | string (≤ 200 chars) |  |
| `membershipId` | string (≤ 200 chars) | The organization membership. |
| `status` | `pending` \| `active` \| `suspended` \| `removed` |  |
| `responsibility` | `owner` \| `manager` \| `member` | A label, not a permission. |
| `roleIds` | array (≤ 100) | Roles of the organization that apply only inside this team. |
| `createdAt` | string (date-time) |  |
| `updatedAt` | string (date-time) |  |
| `joinedAt` | string (date-time), may be absent |  |
| `invitedBy` | object, may be absent |  |
| `invitedBy.provider` | string (≤ 200 chars) |  |
| `invitedBy.subject` | string (≤ 500 chars) |  |
| `statusChange` | object, may be absent | The last status change. |
| `statusChange.at` | string (date-time) |  |
| `statusChange.by` | object |  |
| `statusChange.by.provider` | string (≤ 200 chars) |  |
| `statusChange.by.subject` | string (≤ 500 chars) |  |
| `statusChange.reason` | string (≤ 500 chars), may be absent |  |
| `version` | integer (1–…) |  |

**Errors of this operation** (besides the ones every call can meet: see [Errors](#errors))

- `400` `actor_required`
- `400` `identity_provider_required`
- `400` `identity_provider_reserved`
- `403` `access_escalation`
- `403` `access_owner_protected`
- `403` `access_self_change`
- `403` `access_target_stronger`
- `403` `forbidden`
- `404` `organization_not_found`
- `404` `team_membership_not_found`
- `409` `team_membership_transition_invalid`
- `501` `actor_token_unsupported`

**Example: Suspend a team membership**

```bash
curl -X POST "https://uniora.example.com/v1/organizations/org_acme/team-memberships/tm_ana/suspend" \
  -H "Authorization: Bearer $UNIORA_API_KEY" \
  -H 'Uniora-Actor-Subject: mgr' \
  -H "Content-Type: application/json" \
  -d '{
    "reason": "on leave"
  }'
```

```ts
const result = await uniora.teamMembers.suspend(
  {
    organizationId: "org_acme",
    teamMembershipId: "tm_ana",
    reason: "on leave",
  },
  { actor: { subject: "mgr" } },
);
```

```http
HTTP/1.1 200 OK
ETag: "5"

{
  "id": "tm_ana",
  "organizationId": "org_acme",
  "teamId": "team_bcn",
  "membershipId": "mem_ana",
  "status": "suspended",
  "responsibility": "manager",
  "roleIds": [],
  "createdAt": "2026-03-02T10:24:00.000Z",
  "updatedAt": "2026-03-02T10:25:00.000Z",
  "joinedAt": "2026-03-02T10:26:00.000Z",
  "invitedBy": {
    "provider": "main",
    "subject": "mgr"
  },
  "statusChange": {
    "at": "2026-03-02T10:27:00.000Z",
    "by": {
      "provider": "main",
      "subject": "mgr"
    },
    "reason": "on leave"
  },
  "version": 5
}
```

### `POST /v1/organizations/:organizationId/team-memberships/:teamMembershipId/reactivate`  <a id="teammembers-reactivate"></a>

**Lift a team suspension** · operation `teamMembers.reactivate`

Nobody lifts their own suspension. A delegated call: it speaks for the end user in the `Uniora-Actor-Subject` header, needs the `actor:assert` scope as well, and succeeds only if that user may do it.

- **Scope:** `teams:write` and `actor:assert`
- **Kind:** delegated (speaks for an end user)
- **Changes data:** yes (refused with `503 read_only` while the server is read-only)
- **`ETag`:** the answer carries the version of the resource

**Request**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `organizationId` | string (1–200 chars) | yes | (in the path) The organization. |
| `teamMembershipId` | string (1–200 chars) | yes | (in the path) The team membership (not the organization membership). |

Delegated calls also send `Uniora-Actor-Subject` (the end user, percent-encoded) and, when your server has no default label, `Uniora-Actor-Provider`.

**Response `200`**

| Field | Type | Description |
| --- | --- | --- |
| `id` | string (≤ 200 chars) |  |
| `organizationId` | string (≤ 200 chars) |  |
| `teamId` | string (≤ 200 chars) |  |
| `membershipId` | string (≤ 200 chars) | The organization membership. |
| `status` | `pending` \| `active` \| `suspended` \| `removed` |  |
| `responsibility` | `owner` \| `manager` \| `member` | A label, not a permission. |
| `roleIds` | array (≤ 100) | Roles of the organization that apply only inside this team. |
| `createdAt` | string (date-time) |  |
| `updatedAt` | string (date-time) |  |
| `joinedAt` | string (date-time), may be absent |  |
| `invitedBy` | object, may be absent |  |
| `invitedBy.provider` | string (≤ 200 chars) |  |
| `invitedBy.subject` | string (≤ 500 chars) |  |
| `statusChange` | object, may be absent | The last status change. |
| `statusChange.at` | string (date-time) |  |
| `statusChange.by` | object |  |
| `statusChange.by.provider` | string (≤ 200 chars) |  |
| `statusChange.by.subject` | string (≤ 500 chars) |  |
| `statusChange.reason` | string (≤ 500 chars), may be absent |  |
| `version` | integer (1–…) |  |

**Errors of this operation** (besides the ones every call can meet: see [Errors](#errors))

- `400` `actor_required`
- `400` `identity_provider_required`
- `400` `identity_provider_reserved`
- `403` `access_escalation`
- `403` `access_owner_protected`
- `403` `access_self_change`
- `403` `access_target_stronger`
- `403` `forbidden`
- `404` `organization_not_found`
- `404` `team_membership_not_found`
- `409` `team_membership_transition_invalid`
- `501` `actor_token_unsupported`

**Example: Lift it**

```bash
curl -X POST "https://uniora.example.com/v1/organizations/org_acme/team-memberships/tm_ana/reactivate" \
  -H "Authorization: Bearer $UNIORA_API_KEY" \
  -H 'Uniora-Actor-Subject: mgr'
```

```ts
const result = await uniora.teamMembers.reactivate(
  { organizationId: "org_acme", teamMembershipId: "tm_ana" },
  { actor: { subject: "mgr" } },
);
```

```http
HTTP/1.1 200 OK
ETag: "6"

{
  "id": "tm_ana",
  "organizationId": "org_acme",
  "teamId": "team_bcn",
  "membershipId": "mem_ana",
  "status": "active",
  "responsibility": "manager",
  "roleIds": [],
  "createdAt": "2026-03-02T10:28:00.000Z",
  "updatedAt": "2026-03-02T10:29:00.000Z",
  "joinedAt": "2026-03-02T10:30:00.000Z",
  "invitedBy": {
    "provider": "main",
    "subject": "mgr"
  },
  "statusChange": {
    "at": "2026-03-02T10:31:00.000Z",
    "by": {
      "provider": "main",
      "subject": "mgr"
    }
  },
  "version": 6
}
```

### `PUT /v1/organizations/:organizationId/team-memberships/:teamMembershipId/responsibility`  <a id="teammembers-setresponsibility"></a>

**Set who looks after a team** · operation `teamMembers.setResponsibility`

A label (`owner`, `manager`, `member`), not a permission. Nobody changes their own. A delegated call: it speaks for the end user in the `Uniora-Actor-Subject` header, needs the `actor:assert` scope as well, and succeeds only if that user may do it.

- **Scope:** `teams:write` and `actor:assert`
- **Kind:** delegated (speaks for an end user)
- **Changes data:** yes (refused with `503 read_only` while the server is read-only)
- **`ETag`:** the answer carries the version of the resource

**Request**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `organizationId` | string (1–200 chars) | yes | (in the path) The organization. |
| `teamMembershipId` | string (1–200 chars) | yes | (in the path) The team membership (not the organization membership). |
| `responsibility` | `owner` \| `manager` \| `member` | yes |  |

Delegated calls also send `Uniora-Actor-Subject` (the end user, percent-encoded) and, when your server has no default label, `Uniora-Actor-Provider`.

**Response `200`**

| Field | Type | Description |
| --- | --- | --- |
| `id` | string (≤ 200 chars) |  |
| `organizationId` | string (≤ 200 chars) |  |
| `teamId` | string (≤ 200 chars) |  |
| `membershipId` | string (≤ 200 chars) | The organization membership. |
| `status` | `pending` \| `active` \| `suspended` \| `removed` |  |
| `responsibility` | `owner` \| `manager` \| `member` | A label, not a permission. |
| `roleIds` | array (≤ 100) | Roles of the organization that apply only inside this team. |
| `createdAt` | string (date-time) |  |
| `updatedAt` | string (date-time) |  |
| `joinedAt` | string (date-time), may be absent |  |
| `invitedBy` | object, may be absent |  |
| `invitedBy.provider` | string (≤ 200 chars) |  |
| `invitedBy.subject` | string (≤ 500 chars) |  |
| `statusChange` | object, may be absent | The last status change. |
| `statusChange.at` | string (date-time) |  |
| `statusChange.by` | object |  |
| `statusChange.by.provider` | string (≤ 200 chars) |  |
| `statusChange.by.subject` | string (≤ 500 chars) |  |
| `statusChange.reason` | string (≤ 500 chars), may be absent |  |
| `version` | integer (1–…) |  |

**Errors of this operation** (besides the ones every call can meet: see [Errors](#errors))

- `400` `actor_required`
- `400` `identity_provider_required`
- `400` `identity_provider_reserved`
- `403` `access_escalation`
- `403` `access_owner_protected`
- `403` `access_self_change`
- `403` `access_target_stronger`
- `403` `forbidden`
- `404` `organization_not_found`
- `404` `team_membership_not_found`
- `409` `team_membership_transition_invalid`
- `501` `actor_token_unsupported`

**Example: Set who looks after the team**

```bash
curl -X PUT "https://uniora.example.com/v1/organizations/org_acme/team-memberships/tm_ana/responsibility" \
  -H "Authorization: Bearer $UNIORA_API_KEY" \
  -H 'Uniora-Actor-Subject: mgr' \
  -H "Content-Type: application/json" \
  -d '{
    "responsibility": "manager"
  }'
```

```ts
const result = await uniora.teamMembers.setResponsibility(
  {
    organizationId: "org_acme",
    teamMembershipId: "tm_ana",
    responsibility: "manager",
  },
  { actor: { subject: "mgr" } },
);
```

```http
HTTP/1.1 200 OK
ETag: "2"

{
  "id": "tm_ana",
  "organizationId": "org_acme",
  "teamId": "team_bcn",
  "membershipId": "mem_ana",
  "status": "active",
  "responsibility": "manager",
  "roleIds": [],
  "createdAt": "2026-03-02T10:32:00.000Z",
  "updatedAt": "2026-03-02T10:33:00.000Z",
  "joinedAt": "2026-03-02T10:34:00.000Z",
  "invitedBy": {
    "provider": "main",
    "subject": "mgr"
  },
  "version": 2
}
```

### `PUT /v1/organizations/:organizationId/team-memberships/:teamMembershipId/roles/:roleId`  <a id="teammembers-assignrole"></a>

**Give a team member a role inside the team** · operation `teamMembers.assignRole`

Applies only inside this team. The actor must hold every permission of the role, and never changes their own. A delegated call: it speaks for the end user in the `Uniora-Actor-Subject` header, needs the `actor:assert` scope as well, and succeeds only if that user may do it.

- **Scope:** `teams:write` and `actor:assert`
- **Kind:** delegated (speaks for an end user)
- **Changes data:** yes (refused with `503 read_only` while the server is read-only)
- **`ETag`:** the answer carries the version of the resource

**Request**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `organizationId` | string (1–200 chars) | yes | (in the path) The organization. |
| `teamMembershipId` | string (1–200 chars) | yes | (in the path) The team membership (not the organization membership). |
| `roleId` | string (1–200 chars) | yes | (in the path) A role of the organization. |

Delegated calls also send `Uniora-Actor-Subject` (the end user, percent-encoded) and, when your server has no default label, `Uniora-Actor-Provider`.

**Response `200`**

| Field | Type | Description |
| --- | --- | --- |
| `id` | string (≤ 200 chars) |  |
| `organizationId` | string (≤ 200 chars) |  |
| `teamId` | string (≤ 200 chars) |  |
| `membershipId` | string (≤ 200 chars) | The organization membership. |
| `status` | `pending` \| `active` \| `suspended` \| `removed` |  |
| `responsibility` | `owner` \| `manager` \| `member` | A label, not a permission. |
| `roleIds` | array (≤ 100) | Roles of the organization that apply only inside this team. |
| `createdAt` | string (date-time) |  |
| `updatedAt` | string (date-time) |  |
| `joinedAt` | string (date-time), may be absent |  |
| `invitedBy` | object, may be absent |  |
| `invitedBy.provider` | string (≤ 200 chars) |  |
| `invitedBy.subject` | string (≤ 500 chars) |  |
| `statusChange` | object, may be absent | The last status change. |
| `statusChange.at` | string (date-time) |  |
| `statusChange.by` | object |  |
| `statusChange.by.provider` | string (≤ 200 chars) |  |
| `statusChange.by.subject` | string (≤ 500 chars) |  |
| `statusChange.reason` | string (≤ 500 chars), may be absent |  |
| `version` | integer (1–…) |  |

**Errors of this operation** (besides the ones every call can meet: see [Errors](#errors))

- `400` `actor_required`
- `400` `identity_provider_required`
- `400` `identity_provider_reserved`
- `400` `team_role_invalid`
- `403` `access_escalation`
- `403` `access_owner_protected`
- `403` `access_self_change`
- `403` `access_target_stronger`
- `403` `forbidden`
- `403` `team_role_owner_protected`
- `404` `organization_not_found`
- `404` `team_membership_not_found`
- `409` `team_membership_transition_invalid`
- `501` `actor_token_unsupported`

**Example: A role that applies only inside the team**

```bash
curl -X PUT "https://uniora.example.com/v1/organizations/org_acme/team-memberships/tm_ana/roles/role_viewer" \
  -H "Authorization: Bearer $UNIORA_API_KEY" \
  -H 'Uniora-Actor-Subject: mgr'
```

```ts
const result = await uniora.teamMembers.assignRole(
  {
    organizationId: "org_acme",
    teamMembershipId: "tm_ana",
    roleId: "role_viewer",
  },
  { actor: { subject: "mgr" } },
);
```

```http
HTTP/1.1 200 OK
ETag: "3"

{
  "id": "tm_ana",
  "organizationId": "org_acme",
  "teamId": "team_bcn",
  "membershipId": "mem_ana",
  "status": "active",
  "responsibility": "manager",
  "roleIds": [
    "role_viewer"
  ],
  "createdAt": "2026-03-02T10:35:00.000Z",
  "updatedAt": "2026-03-02T10:36:00.000Z",
  "joinedAt": "2026-03-02T10:37:00.000Z",
  "invitedBy": {
    "provider": "main",
    "subject": "mgr"
  },
  "version": 3
}
```

### `DELETE /v1/organizations/:organizationId/team-memberships/:teamMembershipId/roles/:roleId`  <a id="teammembers-unassignrole"></a>

**Take a role away from a team member** · operation `teamMembers.unassignRole`

Inside the team only. A delegated call: it speaks for the end user in the `Uniora-Actor-Subject` header, needs the `actor:assert` scope as well, and succeeds only if that user may do it.

- **Scope:** `teams:write` and `actor:assert`
- **Kind:** delegated (speaks for an end user)
- **Changes data:** yes (refused with `503 read_only` while the server is read-only)
- **`ETag`:** the answer carries the version of the resource

**Request**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `organizationId` | string (1–200 chars) | yes | (in the path) The organization. |
| `teamMembershipId` | string (1–200 chars) | yes | (in the path) The team membership (not the organization membership). |
| `roleId` | string (1–200 chars) | yes | (in the path) A role of the organization. |

Delegated calls also send `Uniora-Actor-Subject` (the end user, percent-encoded) and, when your server has no default label, `Uniora-Actor-Provider`.

**Response `200`**

| Field | Type | Description |
| --- | --- | --- |
| `id` | string (≤ 200 chars) |  |
| `organizationId` | string (≤ 200 chars) |  |
| `teamId` | string (≤ 200 chars) |  |
| `membershipId` | string (≤ 200 chars) | The organization membership. |
| `status` | `pending` \| `active` \| `suspended` \| `removed` |  |
| `responsibility` | `owner` \| `manager` \| `member` | A label, not a permission. |
| `roleIds` | array (≤ 100) | Roles of the organization that apply only inside this team. |
| `createdAt` | string (date-time) |  |
| `updatedAt` | string (date-time) |  |
| `joinedAt` | string (date-time), may be absent |  |
| `invitedBy` | object, may be absent |  |
| `invitedBy.provider` | string (≤ 200 chars) |  |
| `invitedBy.subject` | string (≤ 500 chars) |  |
| `statusChange` | object, may be absent | The last status change. |
| `statusChange.at` | string (date-time) |  |
| `statusChange.by` | object |  |
| `statusChange.by.provider` | string (≤ 200 chars) |  |
| `statusChange.by.subject` | string (≤ 500 chars) |  |
| `statusChange.reason` | string (≤ 500 chars), may be absent |  |
| `version` | integer (1–…) |  |

**Errors of this operation** (besides the ones every call can meet: see [Errors](#errors))

- `400` `actor_required`
- `400` `identity_provider_required`
- `400` `identity_provider_reserved`
- `403` `access_escalation`
- `403` `access_owner_protected`
- `403` `access_self_change`
- `403` `access_target_stronger`
- `403` `forbidden`
- `404` `organization_not_found`
- `404` `team_membership_not_found`
- `409` `team_membership_transition_invalid`
- `501` `actor_token_unsupported`

**Example: Take it away**

```bash
curl -X DELETE "https://uniora.example.com/v1/organizations/org_acme/team-memberships/tm_ana/roles/role_viewer" \
  -H "Authorization: Bearer $UNIORA_API_KEY" \
  -H 'Uniora-Actor-Subject: mgr'
```

```ts
const result = await uniora.teamMembers.unassignRole(
  {
    organizationId: "org_acme",
    teamMembershipId: "tm_ana",
    roleId: "role_viewer",
  },
  { actor: { subject: "mgr" } },
);
```

```http
HTTP/1.1 200 OK
ETag: "4"

{
  "id": "tm_ana",
  "organizationId": "org_acme",
  "teamId": "team_bcn",
  "membershipId": "mem_ana",
  "status": "active",
  "responsibility": "manager",
  "roleIds": [],
  "createdAt": "2026-03-02T10:38:00.000Z",
  "updatedAt": "2026-03-02T10:39:00.000Z",
  "joinedAt": "2026-03-02T10:40:00.000Z",
  "invitedBy": {
    "provider": "main",
    "subject": "mgr"
  },
  "version": 4
}
```

### `POST /v1/organizations/:organizationId/team-moves`  <a id="teammembers-move"></a>

**Move a member from one team to another** · operation `teamMembers.move`

Atomic: it needs `teams.members.remove` in the source team and `teams.members.add` in the destination. A delegated call: it speaks for the end user in the `Uniora-Actor-Subject` header, needs the `actor:assert` scope as well, and succeeds only if that user may do it.

- **Scope:** `teams:write` and `actor:assert`
- **Kind:** delegated (speaks for an end user)
- **Changes data:** yes (refused with `503 read_only` while the server is read-only)
- **`ETag`:** the answer carries the version of the resource

**Request**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `organizationId` | string (1–200 chars) | yes | (in the path) The organization. |
| `id` | string (1–200 chars) | no | Your own id for the new team membership; generated when omitted. |
| `membershipId` | string (1–200 chars) | yes | The organization membership that changes team. |
| `fromTeamId` | string (1–200 chars) | yes | The team. |
| `toTeamId` | string (1–200 chars) | yes | The team. |
| `reason` | string (1–500 chars) | no | Why. Kept in the audit log. |

Delegated calls also send `Uniora-Actor-Subject` (the end user, percent-encoded) and, when your server has no default label, `Uniora-Actor-Provider`.

**Response `201`**

| Field | Type | Description |
| --- | --- | --- |
| `id` | string (≤ 200 chars) |  |
| `organizationId` | string (≤ 200 chars) |  |
| `teamId` | string (≤ 200 chars) |  |
| `membershipId` | string (≤ 200 chars) | The organization membership. |
| `status` | `pending` \| `active` \| `suspended` \| `removed` |  |
| `responsibility` | `owner` \| `manager` \| `member` | A label, not a permission. |
| `roleIds` | array (≤ 100) | Roles of the organization that apply only inside this team. |
| `createdAt` | string (date-time) |  |
| `updatedAt` | string (date-time) |  |
| `joinedAt` | string (date-time), may be absent |  |
| `invitedBy` | object, may be absent |  |
| `invitedBy.provider` | string (≤ 200 chars) |  |
| `invitedBy.subject` | string (≤ 500 chars) |  |
| `statusChange` | object, may be absent | The last status change. |
| `statusChange.at` | string (date-time) |  |
| `statusChange.by` | object |  |
| `statusChange.by.provider` | string (≤ 200 chars) |  |
| `statusChange.by.subject` | string (≤ 500 chars) |  |
| `statusChange.reason` | string (≤ 500 chars), may be absent |  |
| `version` | integer (1–…) |  |

**Errors of this operation** (besides the ones every call can meet: see [Errors](#errors))

- `400` `actor_required`
- `400` `identity_provider_required`
- `400` `identity_provider_reserved`
- `403` `access_escalation`
- `403` `access_owner_protected`
- `403` `access_self_change`
- `403` `access_target_stronger`
- `403` `forbidden`
- `404` `organization_not_found`
- `404` `team_membership_not_found`
- `404` `team_not_found`
- `409` `team_membership_exists`
- `412` `team_version_conflict`
- `501` `actor_token_unsupported`

**Example: Move a member to another team**

```bash
curl -X POST "https://uniora.example.com/v1/organizations/org_acme/team-moves" \
  -H "Authorization: Bearer $UNIORA_API_KEY" \
  -H 'Uniora-Actor-Subject: mgr' \
  -H "Content-Type: application/json" \
  -d '{
    "id": "tm_ana_mad",
    "membershipId": "mem_ana",
    "fromTeamId": "team_bcn",
    "toTeamId": "team_mad",
    "reason": "transfer"
  }'
```

```ts
const result = await uniora.teamMembers.move(
  {
    organizationId: "org_acme",
    id: "tm_ana_mad",
    membershipId: "mem_ana",
    fromTeamId: "team_bcn",
    toTeamId: "team_mad",
    reason: "transfer",
  },
  { actor: { subject: "mgr" } },
);
```

```http
HTTP/1.1 201 Created
ETag: "1"

{
  "id": "tm_ana_mad",
  "organizationId": "org_acme",
  "teamId": "team_mad",
  "membershipId": "mem_ana",
  "status": "active",
  "responsibility": "member",
  "roleIds": [],
  "createdAt": "2026-03-02T10:41:00.000Z",
  "updatedAt": "2026-03-02T10:42:00.000Z",
  "joinedAt": "2026-03-02T10:43:00.000Z",
  "invitedBy": {
    "provider": "main",
    "subject": "mgr"
  },
  "version": 1
}
```

## Policies

Conditional rules that restrict what roles allow.

### `GET /v1/organizations/:organizationId/policies`  <a id="policies-list"></a>

**List an organization's policies** · operation `policies.list`

Ordered by id. `q` matches the key or the name. A delegated call: it speaks for the end user in the `Uniora-Actor-Subject` header, needs the `actor:assert` scope as well, and succeeds only if that user holds the policy permission (`policies.read`, `policies.manage`, `policies.activate`). Policy administration is never subject to policies.

- **Scope:** `organizations:read` and `actor:assert`
- **Kind:** delegated (speaks for an end user)
- **Changes data:** no

**Request**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `organizationId` | string (1–200 chars) | yes | (in the path) The organization. |
| `limit` | integer (1–1000) | no | (query) Items per page. At most the server's maximum (100 unless configured). |
| `cursor` | string (1–600 chars) | no | (query) The `nextCursor` of the previous page. |
| `q` | string (1–200 chars) | no | (query) Case-insensitive text to look for. |
| `status` | `draft` \| `active` \| `disabled` \| `retired` | no | (query) |
| `kind` | `access` \| `resource` \| `scope` \| `feature` \| `contextual` \| `sensitive` | no | (query) |
| `effect` | `deny` \| `require` | no | (query) |

Delegated calls also send `Uniora-Actor-Subject` (the end user, percent-encoded) and, when your server has no default label, `Uniora-Actor-Provider`.

**Response `200`**

| Field | Type | Description |
| --- | --- | --- |
| `items` | array (≤ 1000) |  |
| `items[].id` | string (≤ 200 chars) |  |
| `items[].organizationId` | string (≤ 200 chars) |  |
| `items[].key` | string (≤ 200 chars) | Stable handle, unique in the organization for all time. |
| `items[].name` | string (≤ 255 chars) |  |
| `items[].description` | string (≤ 1000 chars), may be absent |  |
| `items[].kind` | `access` \| `resource` \| `scope` \| `feature` \| `contextual` \| `sensitive` |  |
| `items[].effect` | `deny` \| `require` | A policy only restricts: `deny` refuses when the condition holds, `require` refuses unless it holds. |
| `items[].status` | `draft` \| `active` \| `disabled` \| `retired` |  |
| `items[].revision` | integer (1–…) | The revision of the definition. Decisions record it. |
| `items[].definition` | object (free keys) | The normalized definition. |
| `items[].definitionHash` | string (≤ 128 chars) |  |
| `items[].createdAt` | string (date-time) |  |
| `items[].createdBy` | object |  |
| `items[].createdBy.provider` | string (≤ 200 chars) |  |
| `items[].createdBy.subject` | string (≤ 500 chars) |  |
| `items[].updatedAt` | string (date-time) |  |
| `items[].statusChange` | object, may be absent |  |
| `items[].statusChange.at` | string (date-time) |  |
| `items[].statusChange.by` | object |  |
| `items[].statusChange.by.provider` | string (≤ 200 chars) |  |
| `items[].statusChange.by.subject` | string (≤ 500 chars) |  |
| `items[].statusChange.reason` | string (≤ 500 chars), may be absent |  |
| `items[].activatedAt` | string (date-time), may be absent |  |
| `items[].version` | integer (1–…) | Send it back as `If-Match` to refuse changes made from a stale copy. |
| `nextCursor` | string (≤ 600 chars) or `null` | Pass it back as `cursor` for the next page; `null` on the last one. |

**Errors of this operation** (besides the ones every call can meet: see [Errors](#errors))

- `400` `actor_required`
- `400` `identity_provider_required`
- `400` `identity_provider_reserved`
- `400` `invalid_cursor`
- `403` `forbidden`
- `404` `organization_not_found`
- `501` `actor_token_unsupported`

**Example: List policies**

```bash
curl -X GET "https://uniora.example.com/v1/organizations/org_acme/policies?limit=10" \
  -H "Authorization: Bearer $UNIORA_API_KEY" \
  -H 'Uniora-Actor-Subject: mgr'
```

```ts
const result = await uniora.policies.list(
  { organizationId: "org_acme", limit: 10 },
  { actor: { subject: "mgr" } },
);
```

```http
HTTP/1.1 200 OK

{
  "items": [
    {
      "id": "00000000-0000-4000-8000-000000000002",
      "organizationId": "org_acme",
      "key": "freeze-reports",
      "name": "Freeze reports",
      "description": "Nobody reads reports during the audit.",
      "kind": "access",
      "effect": "deny",
      "status": "draft",
      "revision": 1,
      "definition": {
        "actions": [
          "reports.read"
        ],
        "condition": {
          "eq": [
            {
              "ref": "subject.membershipStatus"
            },
            {
              "value": "active"
            }
          ]
        },
        "effect": "deny",
        "kind": "access"
      },
      "definitionHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1",
      "createdAt": "2026-03-02T10:44:00.000Z",
      "createdBy": {
        "provider": "main",
        "subject": "mgr"
      },
      "updatedAt": "2026-03-02T10:45:00.000Z",
      "version": 1
    }
  ],
  "nextCursor": null
}
```

### `GET /v1/organizations/:organizationId/policies/:policyId`  <a id="policies-get"></a>

**Get a policy** · operation `policies.get`

A policy of another organization answers exactly like one that does not exist. A delegated call: it speaks for the end user in the `Uniora-Actor-Subject` header, needs the `actor:assert` scope as well, and succeeds only if that user holds the policy permission (`policies.read`, `policies.manage`, `policies.activate`). Policy administration is never subject to policies.

- **Scope:** `organizations:read` and `actor:assert`
- **Kind:** delegated (speaks for an end user)
- **Changes data:** no
- **`ETag`:** the answer carries the version of the resource

**Request**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `organizationId` | string (1–200 chars) | yes | (in the path) The organization. |
| `policyId` | string (1–200 chars) | yes | (in the path) The policy. |

Delegated calls also send `Uniora-Actor-Subject` (the end user, percent-encoded) and, when your server has no default label, `Uniora-Actor-Provider`.

**Response `200`**

| Field | Type | Description |
| --- | --- | --- |
| `id` | string (≤ 200 chars) |  |
| `organizationId` | string (≤ 200 chars) |  |
| `key` | string (≤ 200 chars) | Stable handle, unique in the organization for all time. |
| `name` | string (≤ 255 chars) |  |
| `description` | string (≤ 1000 chars), may be absent |  |
| `kind` | `access` \| `resource` \| `scope` \| `feature` \| `contextual` \| `sensitive` |  |
| `effect` | `deny` \| `require` | A policy only restricts: `deny` refuses when the condition holds, `require` refuses unless it holds. |
| `status` | `draft` \| `active` \| `disabled` \| `retired` |  |
| `revision` | integer (1–…) | The revision of the definition. Decisions record it. |
| `definition` | object (free keys) | The normalized definition. |
| `definitionHash` | string (≤ 128 chars) |  |
| `createdAt` | string (date-time) |  |
| `createdBy` | object |  |
| `createdBy.provider` | string (≤ 200 chars) |  |
| `createdBy.subject` | string (≤ 500 chars) |  |
| `updatedAt` | string (date-time) |  |
| `statusChange` | object, may be absent |  |
| `statusChange.at` | string (date-time) |  |
| `statusChange.by` | object |  |
| `statusChange.by.provider` | string (≤ 200 chars) |  |
| `statusChange.by.subject` | string (≤ 500 chars) |  |
| `statusChange.reason` | string (≤ 500 chars), may be absent |  |
| `activatedAt` | string (date-time), may be absent |  |
| `version` | integer (1–…) | Send it back as `If-Match` to refuse changes made from a stale copy. |

**Errors of this operation** (besides the ones every call can meet: see [Errors](#errors))

- `400` `actor_required`
- `400` `identity_provider_required`
- `400` `identity_provider_reserved`
- `403` `forbidden`
- `404` `organization_not_found`
- `404` `policy_not_found`
- `412` `policy_version_conflict`
- `501` `actor_token_unsupported`

**Example: Read a policy**

```bash
curl -X GET "https://uniora.example.com/v1/organizations/org_acme/policies/00000000-0000-4000-8000-000000000002" \
  -H "Authorization: Bearer $UNIORA_API_KEY" \
  -H 'Uniora-Actor-Subject: mgr'
```

```ts
const result = await uniora.policies.get(
  {
    organizationId: "org_acme",
    policyId: "00000000-0000-4000-8000-000000000002",
  },
  { actor: { subject: "mgr" } },
);
```

```http
HTTP/1.1 200 OK
ETag: "1"

{
  "id": "00000000-0000-4000-8000-000000000002",
  "organizationId": "org_acme",
  "key": "freeze-reports",
  "name": "Freeze reports",
  "description": "Nobody reads reports during the audit.",
  "kind": "access",
  "effect": "deny",
  "status": "draft",
  "revision": 1,
  "definition": {
    "actions": [
      "reports.read"
    ],
    "condition": {
      "eq": [
        {
          "ref": "subject.membershipStatus"
        },
        {
          "value": "active"
        }
      ]
    },
    "effect": "deny",
    "kind": "access"
  },
  "definitionHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1",
  "createdAt": "2026-03-02T10:46:00.000Z",
  "createdBy": {
    "provider": "main",
    "subject": "mgr"
  },
  "updatedAt": "2026-03-02T10:47:00.000Z",
  "version": 1
}
```

### `GET /v1/organizations/:organizationId/policies/:policyId/revisions`  <a id="policies-revisions"></a>

**The history of a policy's definition** · operation `policies.revisions`

Newest first. Each revision is immutable; decisions record the revision they used. A delegated call: it speaks for the end user in the `Uniora-Actor-Subject` header, needs the `actor:assert` scope as well, and succeeds only if that user holds the policy permission (`policies.read`, `policies.manage`, `policies.activate`). Policy administration is never subject to policies.

- **Scope:** `organizations:read` and `actor:assert`
- **Kind:** delegated (speaks for an end user)
- **Changes data:** no

**Request**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `organizationId` | string (1–200 chars) | yes | (in the path) The organization. |
| `policyId` | string (1–200 chars) | yes | (in the path) The policy. |
| `limit` | integer (1–1000) | no | (query) Items per page. At most the server's maximum (100 unless configured). |
| `cursor` | string (1–600 chars) | no | (query) The `nextCursor` of the previous page. |

Delegated calls also send `Uniora-Actor-Subject` (the end user, percent-encoded) and, when your server has no default label, `Uniora-Actor-Provider`.

**Response `200`**

| Field | Type | Description |
| --- | --- | --- |
| `items` | array (≤ 1000) |  |
| `items[].policyId` | string (≤ 200 chars) |  |
| `items[].organizationId` | string (≤ 200 chars) |  |
| `items[].revision` | integer (1–…) |  |
| `items[].definition` | object (free keys) | The definition at this revision. |
| `items[].definitionHash` | string (≤ 128 chars) |  |
| `items[].createdAt` | string (date-time) |  |
| `items[].createdBy` | object |  |
| `items[].createdBy.provider` | string (≤ 200 chars) |  |
| `items[].createdBy.subject` | string (≤ 500 chars) |  |
| `items[].note` | string (≤ 500 chars), may be absent |  |
| `nextCursor` | string (≤ 600 chars) or `null` | Pass it back as `cursor` for the next page; `null` on the last one. |

**Errors of this operation** (besides the ones every call can meet: see [Errors](#errors))

- `400` `actor_required`
- `400` `identity_provider_required`
- `400` `identity_provider_reserved`
- `400` `invalid_cursor`
- `403` `forbidden`
- `404` `organization_not_found`
- `404` `policy_not_found`
- `412` `policy_version_conflict`
- `501` `actor_token_unsupported`

**Example: The history of the definition**

```bash
curl -X GET "https://uniora.example.com/v1/organizations/org_acme/policies/00000000-0000-4000-8000-000000000002/revisions" \
  -H "Authorization: Bearer $UNIORA_API_KEY" \
  -H 'Uniora-Actor-Subject: mgr'
```

```ts
const result = await uniora.policies.revisions(
  {
    organizationId: "org_acme",
    policyId: "00000000-0000-4000-8000-000000000002",
  },
  { actor: { subject: "mgr" } },
);
```

```http
HTTP/1.1 200 OK

{
  "items": [
    {
      "policyId": "00000000-0000-4000-8000-000000000002",
      "organizationId": "org_acme",
      "revision": 1,
      "definition": {
        "actions": [
          "reports.read"
        ],
        "condition": {
          "eq": [
            {
              "ref": "subject.membershipStatus"
            },
            {
              "value": "active"
            }
          ]
        },
        "effect": "deny",
        "kind": "access"
      },
      "definitionHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1",
      "createdAt": "2026-03-02T10:48:00.000Z",
      "createdBy": {
        "provider": "main",
        "subject": "mgr"
      }
    }
  ],
  "nextCursor": null
}
```

### `POST /v1/organizations/:organizationId/policies`  <a id="policies-create"></a>

**Create a policy as a draft** · operation `policies.create`

A draft is never evaluated. Its id is generated by the server. Needs `policies.manage`. A delegated call: it speaks for the end user in the `Uniora-Actor-Subject` header, needs the `actor:assert` scope as well, and succeeds only if that user holds the policy permission (`policies.read`, `policies.manage`, `policies.activate`). Policy administration is never subject to policies.

- **Scope:** `policies:write` and `actor:assert`
- **Kind:** delegated (speaks for an end user)
- **Changes data:** yes (refused with `503 read_only` while the server is read-only)
- **`ETag`:** the answer carries the version of the resource

**Request**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `organizationId` | string (1–200 chars) | yes | (in the path) The organization. |
| `key` | string (1–100 chars) | yes | Stable handle, unique in the organization for all time. |
| `name` | string (1–255 chars) | yes |  |
| `description` | string (1–1000 chars) | no |  |
| `definition` | object (free keys) | yes | The rule, in the policy language. `POST .../policy-validations` checks one without saving it. |
| `note` | string (1–500 chars) | no | A note kept with this revision of the definition. |

Delegated calls also send `Uniora-Actor-Subject` (the end user, percent-encoded) and, when your server has no default label, `Uniora-Actor-Provider`.

**Response `201`**

| Field | Type | Description |
| --- | --- | --- |
| `id` | string (≤ 200 chars) |  |
| `organizationId` | string (≤ 200 chars) |  |
| `key` | string (≤ 200 chars) | Stable handle, unique in the organization for all time. |
| `name` | string (≤ 255 chars) |  |
| `description` | string (≤ 1000 chars), may be absent |  |
| `kind` | `access` \| `resource` \| `scope` \| `feature` \| `contextual` \| `sensitive` |  |
| `effect` | `deny` \| `require` | A policy only restricts: `deny` refuses when the condition holds, `require` refuses unless it holds. |
| `status` | `draft` \| `active` \| `disabled` \| `retired` |  |
| `revision` | integer (1–…) | The revision of the definition. Decisions record it. |
| `definition` | object (free keys) | The normalized definition. |
| `definitionHash` | string (≤ 128 chars) |  |
| `createdAt` | string (date-time) |  |
| `createdBy` | object |  |
| `createdBy.provider` | string (≤ 200 chars) |  |
| `createdBy.subject` | string (≤ 500 chars) |  |
| `updatedAt` | string (date-time) |  |
| `statusChange` | object, may be absent |  |
| `statusChange.at` | string (date-time) |  |
| `statusChange.by` | object |  |
| `statusChange.by.provider` | string (≤ 200 chars) |  |
| `statusChange.by.subject` | string (≤ 500 chars) |  |
| `statusChange.reason` | string (≤ 500 chars), may be absent |  |
| `activatedAt` | string (date-time), may be absent |  |
| `version` | integer (1–…) | Send it back as `If-Match` to refuse changes made from a stale copy. |

**Errors of this operation** (besides the ones every call can meet: see [Errors](#errors))

- `400` `actor_required`
- `400` `identity_provider_required`
- `400` `identity_provider_reserved`
- `400` `policy_definition_invalid`
- `400` `policy_limit_reached`
- `400` `policy_retired`
- `400` `policy_separation_of_duties`
- `403` `forbidden`
- `404` `organization_not_found`
- `404` `policy_not_found`
- `409` `policy_key_taken`
- `409` `policy_transition_invalid`
- `412` `policy_version_conflict`
- `501` `actor_token_unsupported`

**Example: A draft policy: refuse reports while the membership is active**

```bash
curl -X POST "https://uniora.example.com/v1/organizations/org_acme/policies" \
  -H "Authorization: Bearer $UNIORA_API_KEY" \
  -H 'Uniora-Actor-Subject: mgr' \
  -H "Content-Type: application/json" \
  -d '{
    "key": "freeze-reports",
    "name": "Freeze reports",
    "description": "Nobody reads reports during the audit.",
    "definition": {
      "kind": "access",
      "effect": "deny",
      "actions": [
        "reports.read"
      ],
      "condition": {
        "eq": [
          {
            "ref": "subject.membershipStatus"
          },
          {
            "value": "active"
          }
        ]
      }
    }
  }'
```

```ts
const result = await uniora.policies.create(
  {
    organizationId: "org_acme",
    key: "freeze-reports",
    name: "Freeze reports",
    description: "Nobody reads reports during the audit.",
    definition: {
      kind: "access",
      effect: "deny",
      actions: ["reports.read"],
      condition: { eq: [{ ref: "subject.membershipStatus" }, { value: "active" }] },
    },
  },
  { actor: { subject: "mgr" } },
);
```

```http
HTTP/1.1 201 Created
ETag: "1"
Location: /v1/organizations/org_acme/policies/00000000-0000-4000-8000-000000000002

{
  "id": "00000000-0000-4000-8000-000000000002",
  "organizationId": "org_acme",
  "key": "freeze-reports",
  "name": "Freeze reports",
  "description": "Nobody reads reports during the audit.",
  "kind": "access",
  "effect": "deny",
  "status": "draft",
  "revision": 1,
  "definition": {
    "actions": [
      "reports.read"
    ],
    "condition": {
      "eq": [
        {
          "ref": "subject.membershipStatus"
        },
        {
          "value": "active"
        }
      ]
    },
    "effect": "deny",
    "kind": "access"
  },
  "definitionHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1",
  "createdAt": "2026-03-02T10:49:00.000Z",
  "createdBy": {
    "provider": "main",
    "subject": "mgr"
  },
  "updatedAt": "2026-03-02T10:50:00.000Z",
  "version": 1
}
```

**Example: Another draft**

```bash
curl -X POST "https://uniora.example.com/v1/organizations/org_acme/policies" \
  -H "Authorization: Bearer $UNIORA_API_KEY" \
  -H 'Uniora-Actor-Subject: mgr' \
  -H "Content-Type: application/json" \
  -d '{
    "key": "scratch",
    "name": "Scratch",
    "definition": {
      "kind": "access",
      "effect": "deny",
      "actions": [
        "reports.read"
      ],
      "condition": {
        "eq": [
          {
            "ref": "subject.membershipStatus"
          },
          {
            "value": "blocked"
          }
        ]
      }
    }
  }'
```

```ts
const result = await uniora.policies.create(
  {
    organizationId: "org_acme",
    key: "scratch",
    name: "Scratch",
    definition: {
      kind: "access",
      effect: "deny",
      actions: ["reports.read"],
      condition: { eq: [{ ref: "subject.membershipStatus" }, { value: "blocked" }] },
    },
  },
  { actor: { subject: "mgr" } },
);
```

```http
HTTP/1.1 201 Created
ETag: "1"
Location: /v1/organizations/org_acme/policies/00000000-0000-4000-8000-000000000003

{
  "id": "00000000-0000-4000-8000-000000000003",
  "organizationId": "org_acme",
  "key": "scratch",
  "name": "Scratch",
  "kind": "access",
  "effect": "deny",
  "status": "draft",
  "revision": 1,
  "definition": {
    "actions": [
      "reports.read"
    ],
    "condition": {
      "eq": [
        {
          "ref": "subject.membershipStatus"
        },
        {
          "value": "blocked"
        }
      ]
    },
    "effect": "deny",
    "kind": "access"
  },
  "definitionHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa2",
  "createdAt": "2026-03-02T10:51:00.000Z",
  "createdBy": {
    "provider": "main",
    "subject": "mgr"
  },
  "updatedAt": "2026-03-02T10:52:00.000Z",
  "version": 1
}
```

### `PATCH /v1/organizations/:organizationId/policies/:policyId`  <a id="policies-update"></a>

**Edit a policy** · operation `policies.update`

Metadata and, for a draft or disabled policy, the definition. Changing the definition of an ACTIVE policy also needs `policies.activate`. Send `If-Match` to refuse a stale edit. A delegated call: it speaks for the end user in the `Uniora-Actor-Subject` header, needs the `actor:assert` scope as well, and succeeds only if that user holds the policy permission (`policies.read`, `policies.manage`, `policies.activate`). Policy administration is never subject to policies.

- **Scope:** `policies:write` and `actor:assert`
- **Kind:** delegated (speaks for an end user)
- **Changes data:** yes (refused with `503 read_only` while the server is read-only)
- **`If-Match`:** send the version you last saw; a stale one is a `412` and nothing changes
- **`ETag`:** the answer carries the version of the resource

**Request**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `organizationId` | string (1–200 chars) | yes | (in the path) The organization. |
| `policyId` | string (1–200 chars) | yes | (in the path) The policy. |
| `name` | string (1–255 chars) | no |  |
| `description` | string (1–1000 chars) or `null` | no |  |
| `definition` | object (free keys) | no | The new rule. It becomes a new revision. |
| `note` | string (1–500 chars) | no | A note kept with this revision of the definition. |

Delegated calls also send `Uniora-Actor-Subject` (the end user, percent-encoded) and, when your server has no default label, `Uniora-Actor-Provider`.

**Response `200`**

| Field | Type | Description |
| --- | --- | --- |
| `id` | string (≤ 200 chars) |  |
| `organizationId` | string (≤ 200 chars) |  |
| `key` | string (≤ 200 chars) | Stable handle, unique in the organization for all time. |
| `name` | string (≤ 255 chars) |  |
| `description` | string (≤ 1000 chars), may be absent |  |
| `kind` | `access` \| `resource` \| `scope` \| `feature` \| `contextual` \| `sensitive` |  |
| `effect` | `deny` \| `require` | A policy only restricts: `deny` refuses when the condition holds, `require` refuses unless it holds. |
| `status` | `draft` \| `active` \| `disabled` \| `retired` |  |
| `revision` | integer (1–…) | The revision of the definition. Decisions record it. |
| `definition` | object (free keys) | The normalized definition. |
| `definitionHash` | string (≤ 128 chars) |  |
| `createdAt` | string (date-time) |  |
| `createdBy` | object |  |
| `createdBy.provider` | string (≤ 200 chars) |  |
| `createdBy.subject` | string (≤ 500 chars) |  |
| `updatedAt` | string (date-time) |  |
| `statusChange` | object, may be absent |  |
| `statusChange.at` | string (date-time) |  |
| `statusChange.by` | object |  |
| `statusChange.by.provider` | string (≤ 200 chars) |  |
| `statusChange.by.subject` | string (≤ 500 chars) |  |
| `statusChange.reason` | string (≤ 500 chars), may be absent |  |
| `activatedAt` | string (date-time), may be absent |  |
| `version` | integer (1–…) | Send it back as `If-Match` to refuse changes made from a stale copy. |

**Errors of this operation** (besides the ones every call can meet: see [Errors](#errors))

- `400` `actor_required`
- `400` `identity_provider_required`
- `400` `identity_provider_reserved`
- `400` `policy_definition_invalid`
- `400` `policy_retired`
- `400` `policy_separation_of_duties`
- `403` `forbidden`
- `404` `organization_not_found`
- `404` `policy_not_found`
- `409` `policy_transition_invalid`
- `412` `policy_version_conflict`
- `501` `actor_token_unsupported`

**Example: Edit the draft**

```bash
curl -X PATCH "https://uniora.example.com/v1/organizations/org_acme/policies/00000000-0000-4000-8000-000000000002" \
  -H "Authorization: Bearer $UNIORA_API_KEY" \
  -H 'Uniora-Actor-Subject: mgr' \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Freeze reports during the audit",
    "note": "clearer name"
  }'
```

```ts
const result = await uniora.policies.update(
  {
    organizationId: "org_acme",
    policyId: "00000000-0000-4000-8000-000000000002",
    name: "Freeze reports during the audit",
    note: "clearer name",
  },
  { actor: { subject: "mgr" } },
);
```

```http
HTTP/1.1 200 OK
ETag: "2"

{
  "id": "00000000-0000-4000-8000-000000000002",
  "organizationId": "org_acme",
  "key": "freeze-reports",
  "name": "Freeze reports during the audit",
  "description": "Nobody reads reports during the audit.",
  "kind": "access",
  "effect": "deny",
  "status": "draft",
  "revision": 1,
  "definition": {
    "actions": [
      "reports.read"
    ],
    "condition": {
      "eq": [
        {
          "ref": "subject.membershipStatus"
        },
        {
          "value": "active"
        }
      ]
    },
    "effect": "deny",
    "kind": "access"
  },
  "definitionHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1",
  "createdAt": "2026-03-02T10:53:00.000Z",
  "createdBy": {
    "provider": "main",
    "subject": "mgr"
  },
  "updatedAt": "2026-03-02T10:54:00.000Z",
  "version": 2
}
```

### `POST /v1/organizations/:organizationId/policies/:policyId/activate`  <a id="policies-activate"></a>

**Put a policy live** · operation `policies.activate`

From now on it is evaluated on every matching request. Needs `policies.activate`. A delegated call: it speaks for the end user in the `Uniora-Actor-Subject` header, needs the `actor:assert` scope as well, and succeeds only if that user holds the policy permission (`policies.read`, `policies.manage`, `policies.activate`). Policy administration is never subject to policies.

- **Scope:** `policies:write` and `actor:assert`
- **Kind:** delegated (speaks for an end user)
- **Changes data:** yes (refused with `503 read_only` while the server is read-only)
- **`If-Match`:** send the version you last saw; a stale one is a `412` and nothing changes
- **`ETag`:** the answer carries the version of the resource

**Request**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `organizationId` | string (1–200 chars) | yes | (in the path) The organization. |
| `policyId` | string (1–200 chars) | yes | (in the path) The policy. |
| `reason` | string (1–500 chars) | no | Why. Kept in the audit log. |

Delegated calls also send `Uniora-Actor-Subject` (the end user, percent-encoded) and, when your server has no default label, `Uniora-Actor-Provider`.

**Response `200`**

| Field | Type | Description |
| --- | --- | --- |
| `id` | string (≤ 200 chars) |  |
| `organizationId` | string (≤ 200 chars) |  |
| `key` | string (≤ 200 chars) | Stable handle, unique in the organization for all time. |
| `name` | string (≤ 255 chars) |  |
| `description` | string (≤ 1000 chars), may be absent |  |
| `kind` | `access` \| `resource` \| `scope` \| `feature` \| `contextual` \| `sensitive` |  |
| `effect` | `deny` \| `require` | A policy only restricts: `deny` refuses when the condition holds, `require` refuses unless it holds. |
| `status` | `draft` \| `active` \| `disabled` \| `retired` |  |
| `revision` | integer (1–…) | The revision of the definition. Decisions record it. |
| `definition` | object (free keys) | The normalized definition. |
| `definitionHash` | string (≤ 128 chars) |  |
| `createdAt` | string (date-time) |  |
| `createdBy` | object |  |
| `createdBy.provider` | string (≤ 200 chars) |  |
| `createdBy.subject` | string (≤ 500 chars) |  |
| `updatedAt` | string (date-time) |  |
| `statusChange` | object, may be absent |  |
| `statusChange.at` | string (date-time) |  |
| `statusChange.by` | object |  |
| `statusChange.by.provider` | string (≤ 200 chars) |  |
| `statusChange.by.subject` | string (≤ 500 chars) |  |
| `statusChange.reason` | string (≤ 500 chars), may be absent |  |
| `activatedAt` | string (date-time), may be absent |  |
| `version` | integer (1–…) | Send it back as `If-Match` to refuse changes made from a stale copy. |

**Errors of this operation** (besides the ones every call can meet: see [Errors](#errors))

- `400` `actor_required`
- `400` `identity_provider_required`
- `400` `identity_provider_reserved`
- `400` `policy_definition_invalid`
- `400` `policy_retired`
- `400` `policy_separation_of_duties`
- `403` `forbidden`
- `404` `organization_not_found`
- `404` `policy_not_found`
- `409` `policy_transition_invalid`
- `412` `policy_version_conflict`
- `501` `actor_token_unsupported`

**Example: Put it live**

```bash
curl -X POST "https://uniora.example.com/v1/organizations/org_acme/policies/00000000-0000-4000-8000-000000000002/activate" \
  -H "Authorization: Bearer $UNIORA_API_KEY" \
  -H 'Uniora-Actor-Subject: mgr' \
  -H "Content-Type: application/json" \
  -d '{
    "reason": "audit starts"
  }'
```

```ts
const result = await uniora.policies.activate(
  {
    organizationId: "org_acme",
    policyId: "00000000-0000-4000-8000-000000000002",
    reason: "audit starts",
  },
  { actor: { subject: "mgr" } },
);
```

```http
HTTP/1.1 200 OK
ETag: "3"

{
  "id": "00000000-0000-4000-8000-000000000002",
  "organizationId": "org_acme",
  "key": "freeze-reports",
  "name": "Freeze reports during the audit",
  "description": "Nobody reads reports during the audit.",
  "kind": "access",
  "effect": "deny",
  "status": "active",
  "revision": 1,
  "definition": {
    "actions": [
      "reports.read"
    ],
    "condition": {
      "eq": [
        {
          "ref": "subject.membershipStatus"
        },
        {
          "value": "active"
        }
      ]
    },
    "effect": "deny",
    "kind": "access"
  },
  "definitionHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1",
  "createdAt": "2026-03-02T10:55:00.000Z",
  "createdBy": {
    "provider": "main",
    "subject": "mgr"
  },
  "updatedAt": "2026-03-02T10:56:00.000Z",
  "statusChange": {
    "at": "2026-03-02T10:57:00.000Z",
    "by": {
      "provider": "main",
      "subject": "mgr"
    },
    "reason": "audit starts"
  },
  "activatedAt": "2026-03-02T10:58:00.000Z",
  "version": 3
}
```

### `POST /v1/organizations/:organizationId/policies/:policyId/disable`  <a id="policies-disable"></a>

**Switch a policy off** · operation `policies.disable`

It is no longer evaluated and can be activated again. Needs `policies.activate`. A delegated call: it speaks for the end user in the `Uniora-Actor-Subject` header, needs the `actor:assert` scope as well, and succeeds only if that user holds the policy permission (`policies.read`, `policies.manage`, `policies.activate`). Policy administration is never subject to policies.

- **Scope:** `policies:write` and `actor:assert`
- **Kind:** delegated (speaks for an end user)
- **Changes data:** yes (refused with `503 read_only` while the server is read-only)
- **`If-Match`:** send the version you last saw; a stale one is a `412` and nothing changes
- **`ETag`:** the answer carries the version of the resource

**Request**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `organizationId` | string (1–200 chars) | yes | (in the path) The organization. |
| `policyId` | string (1–200 chars) | yes | (in the path) The policy. |
| `reason` | string (1–500 chars) | no | Why. Kept in the audit log. |

Delegated calls also send `Uniora-Actor-Subject` (the end user, percent-encoded) and, when your server has no default label, `Uniora-Actor-Provider`.

**Response `200`**

| Field | Type | Description |
| --- | --- | --- |
| `id` | string (≤ 200 chars) |  |
| `organizationId` | string (≤ 200 chars) |  |
| `key` | string (≤ 200 chars) | Stable handle, unique in the organization for all time. |
| `name` | string (≤ 255 chars) |  |
| `description` | string (≤ 1000 chars), may be absent |  |
| `kind` | `access` \| `resource` \| `scope` \| `feature` \| `contextual` \| `sensitive` |  |
| `effect` | `deny` \| `require` | A policy only restricts: `deny` refuses when the condition holds, `require` refuses unless it holds. |
| `status` | `draft` \| `active` \| `disabled` \| `retired` |  |
| `revision` | integer (1–…) | The revision of the definition. Decisions record it. |
| `definition` | object (free keys) | The normalized definition. |
| `definitionHash` | string (≤ 128 chars) |  |
| `createdAt` | string (date-time) |  |
| `createdBy` | object |  |
| `createdBy.provider` | string (≤ 200 chars) |  |
| `createdBy.subject` | string (≤ 500 chars) |  |
| `updatedAt` | string (date-time) |  |
| `statusChange` | object, may be absent |  |
| `statusChange.at` | string (date-time) |  |
| `statusChange.by` | object |  |
| `statusChange.by.provider` | string (≤ 200 chars) |  |
| `statusChange.by.subject` | string (≤ 500 chars) |  |
| `statusChange.reason` | string (≤ 500 chars), may be absent |  |
| `activatedAt` | string (date-time), may be absent |  |
| `version` | integer (1–…) | Send it back as `If-Match` to refuse changes made from a stale copy. |

**Errors of this operation** (besides the ones every call can meet: see [Errors](#errors))

- `400` `actor_required`
- `400` `identity_provider_required`
- `400` `identity_provider_reserved`
- `400` `policy_definition_invalid`
- `400` `policy_retired`
- `400` `policy_separation_of_duties`
- `403` `forbidden`
- `404` `organization_not_found`
- `404` `policy_not_found`
- `409` `policy_transition_invalid`
- `412` `policy_version_conflict`
- `501` `actor_token_unsupported`

**Example: Switch it off**

```bash
curl -X POST "https://uniora.example.com/v1/organizations/org_acme/policies/00000000-0000-4000-8000-000000000002/disable" \
  -H "Authorization: Bearer $UNIORA_API_KEY" \
  -H 'Uniora-Actor-Subject: mgr' \
  -H "Content-Type: application/json" \
  -d '{}'
```

```ts
const result = await uniora.policies.disable(
  {
    organizationId: "org_acme",
    policyId: "00000000-0000-4000-8000-000000000002",
  },
  { actor: { subject: "mgr" } },
);
```

```http
HTTP/1.1 200 OK
ETag: "4"

{
  "id": "00000000-0000-4000-8000-000000000002",
  "organizationId": "org_acme",
  "key": "freeze-reports",
  "name": "Freeze reports during the audit",
  "description": "Nobody reads reports during the audit.",
  "kind": "access",
  "effect": "deny",
  "status": "disabled",
  "revision": 1,
  "definition": {
    "actions": [
      "reports.read"
    ],
    "condition": {
      "eq": [
        {
          "ref": "subject.membershipStatus"
        },
        {
          "value": "active"
        }
      ]
    },
    "effect": "deny",
    "kind": "access"
  },
  "definitionHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1",
  "createdAt": "2026-03-02T10:59:00.000Z",
  "createdBy": {
    "provider": "main",
    "subject": "mgr"
  },
  "updatedAt": "2026-03-02T11:00:00.000Z",
  "statusChange": {
    "at": "2026-03-02T11:01:00.000Z",
    "by": {
      "provider": "main",
      "subject": "mgr"
    }
  },
  "activatedAt": "2026-03-02T11:02:00.000Z",
  "version": 4
}
```

### `POST /v1/organizations/:organizationId/policies/:policyId/retire`  <a id="policies-retire"></a>

**Retire a policy for good** · operation `policies.retire`

It is no longer evaluated, kept for the record, and can never be activated again. Needs `policies.activate`. A delegated call: it speaks for the end user in the `Uniora-Actor-Subject` header, needs the `actor:assert` scope as well, and succeeds only if that user holds the policy permission (`policies.read`, `policies.manage`, `policies.activate`). Policy administration is never subject to policies.

- **Scope:** `policies:write` and `actor:assert`
- **Kind:** delegated (speaks for an end user)
- **Changes data:** yes (refused with `503 read_only` while the server is read-only)
- **`If-Match`:** send the version you last saw; a stale one is a `412` and nothing changes
- **`ETag`:** the answer carries the version of the resource

**Request**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `organizationId` | string (1–200 chars) | yes | (in the path) The organization. |
| `policyId` | string (1–200 chars) | yes | (in the path) The policy. |
| `reason` | string (1–500 chars) | no | Why. Kept in the audit log. |

Delegated calls also send `Uniora-Actor-Subject` (the end user, percent-encoded) and, when your server has no default label, `Uniora-Actor-Provider`.

**Response `200`**

| Field | Type | Description |
| --- | --- | --- |
| `id` | string (≤ 200 chars) |  |
| `organizationId` | string (≤ 200 chars) |  |
| `key` | string (≤ 200 chars) | Stable handle, unique in the organization for all time. |
| `name` | string (≤ 255 chars) |  |
| `description` | string (≤ 1000 chars), may be absent |  |
| `kind` | `access` \| `resource` \| `scope` \| `feature` \| `contextual` \| `sensitive` |  |
| `effect` | `deny` \| `require` | A policy only restricts: `deny` refuses when the condition holds, `require` refuses unless it holds. |
| `status` | `draft` \| `active` \| `disabled` \| `retired` |  |
| `revision` | integer (1–…) | The revision of the definition. Decisions record it. |
| `definition` | object (free keys) | The normalized definition. |
| `definitionHash` | string (≤ 128 chars) |  |
| `createdAt` | string (date-time) |  |
| `createdBy` | object |  |
| `createdBy.provider` | string (≤ 200 chars) |  |
| `createdBy.subject` | string (≤ 500 chars) |  |
| `updatedAt` | string (date-time) |  |
| `statusChange` | object, may be absent |  |
| `statusChange.at` | string (date-time) |  |
| `statusChange.by` | object |  |
| `statusChange.by.provider` | string (≤ 200 chars) |  |
| `statusChange.by.subject` | string (≤ 500 chars) |  |
| `statusChange.reason` | string (≤ 500 chars), may be absent |  |
| `activatedAt` | string (date-time), may be absent |  |
| `version` | integer (1–…) | Send it back as `If-Match` to refuse changes made from a stale copy. |

**Errors of this operation** (besides the ones every call can meet: see [Errors](#errors))

- `400` `actor_required`
- `400` `identity_provider_required`
- `400` `identity_provider_reserved`
- `400` `policy_definition_invalid`
- `400` `policy_retired`
- `400` `policy_separation_of_duties`
- `403` `forbidden`
- `404` `organization_not_found`
- `404` `policy_not_found`
- `409` `policy_transition_invalid`
- `412` `policy_version_conflict`
- `501` `actor_token_unsupported`

**Example: Retire it for good**

```bash
curl -X POST "https://uniora.example.com/v1/organizations/org_acme/policies/00000000-0000-4000-8000-000000000002/retire" \
  -H "Authorization: Bearer $UNIORA_API_KEY" \
  -H 'Uniora-Actor-Subject: mgr' \
  -H "Content-Type: application/json" \
  -d '{
    "reason": "audit over"
  }'
```

```ts
const result = await uniora.policies.retire(
  {
    organizationId: "org_acme",
    policyId: "00000000-0000-4000-8000-000000000002",
    reason: "audit over",
  },
  { actor: { subject: "mgr" } },
);
```

```http
HTTP/1.1 200 OK
ETag: "5"

{
  "id": "00000000-0000-4000-8000-000000000002",
  "organizationId": "org_acme",
  "key": "freeze-reports",
  "name": "Freeze reports during the audit",
  "description": "Nobody reads reports during the audit.",
  "kind": "access",
  "effect": "deny",
  "status": "retired",
  "revision": 1,
  "definition": {
    "actions": [
      "reports.read"
    ],
    "condition": {
      "eq": [
        {
          "ref": "subject.membershipStatus"
        },
        {
          "value": "active"
        }
      ]
    },
    "effect": "deny",
    "kind": "access"
  },
  "definitionHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1",
  "createdAt": "2026-03-02T11:03:00.000Z",
  "createdBy": {
    "provider": "main",
    "subject": "mgr"
  },
  "updatedAt": "2026-03-02T11:04:00.000Z",
  "statusChange": {
    "at": "2026-03-02T11:05:00.000Z",
    "by": {
      "provider": "main",
      "subject": "mgr"
    },
    "reason": "audit over"
  },
  "activatedAt": "2026-03-02T11:06:00.000Z",
  "version": 5
}
```

### `DELETE /v1/organizations/:organizationId/policies/:policyId`  <a id="policies-delete"></a>

**Delete a draft** · operation `policies.delete`

Only a policy that has never been active can be deleted; retire the others. A delegated call: it speaks for the end user in the `Uniora-Actor-Subject` header, needs the `actor:assert` scope as well, and succeeds only if that user holds the policy permission (`policies.read`, `policies.manage`, `policies.activate`). Policy administration is never subject to policies.

- **Scope:** `policies:write` and `actor:assert`
- **Kind:** delegated (speaks for an end user)
- **Changes data:** yes (refused with `503 read_only` while the server is read-only)

**Request**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `organizationId` | string (1–200 chars) | yes | (in the path) The organization. |
| `policyId` | string (1–200 chars) | yes | (in the path) The policy. |

Delegated calls also send `Uniora-Actor-Subject` (the end user, percent-encoded) and, when your server has no default label, `Uniora-Actor-Provider`.

**Response `200`**

| Field | Type | Description |
| --- | --- | --- |
| `deleted` | boolean |  |

**Errors of this operation** (besides the ones every call can meet: see [Errors](#errors))

- `400` `actor_required`
- `400` `identity_provider_required`
- `400` `identity_provider_reserved`
- `400` `policy_not_draft`
- `403` `forbidden`
- `404` `organization_not_found`
- `404` `policy_not_found`
- `412` `policy_version_conflict`
- `501` `actor_token_unsupported`

**Example: Delete a draft**

```bash
curl -X DELETE "https://uniora.example.com/v1/organizations/org_acme/policies/00000000-0000-4000-8000-000000000003" \
  -H "Authorization: Bearer $UNIORA_API_KEY" \
  -H 'Uniora-Actor-Subject: mgr'
```

```ts
const result = await uniora.policies.delete(
  {
    organizationId: "org_acme",
    policyId: "00000000-0000-4000-8000-000000000003",
  },
  { actor: { subject: "mgr" } },
);
```

```http
HTTP/1.1 200 OK

{
  "deleted": true
}
```

### `POST /v1/organizations/:organizationId/policy-validations`  <a id="policies-validate"></a>

**Check a definition without saving it** · operation `policies.validate`

Answers with the normalized definition, its hash and what it reads, or `policy_definition_invalid`. Writes nothing. Needs `policies.read`. A delegated call: it speaks for the end user in the `Uniora-Actor-Subject` header, needs the `actor:assert` scope as well, and succeeds only if that user holds the policy permission (`policies.read`, `policies.manage`, `policies.activate`). Policy administration is never subject to policies.

- **Scope:** `organizations:read` and `actor:assert`
- **Kind:** delegated (speaks for an end user)
- **Changes data:** no

**Request**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `organizationId` | string (1–200 chars) | yes | (in the path) The organization. |
| `definition` | object (free keys) | yes | The rule to check. |

Delegated calls also send `Uniora-Actor-Subject` (the end user, percent-encoded) and, when your server has no default label, `Uniora-Actor-Provider`.

**Response `200`**

| Field | Type | Description |
| --- | --- | --- |
| `definition` | object (free keys) | The normalized definition. |
| `hash` | string (≤ 128 chars) |  |
| `analysis` | any JSON |  |

**Errors of this operation** (besides the ones every call can meet: see [Errors](#errors))

- `400` `actor_required`
- `400` `identity_provider_required`
- `400` `identity_provider_reserved`
- `400` `policy_definition_invalid`
- `403` `forbidden`
- `404` `organization_not_found`
- `501` `actor_token_unsupported`

**Example: Check a definition without saving it**

```bash
curl -X POST "https://uniora.example.com/v1/organizations/org_acme/policy-validations" \
  -H "Authorization: Bearer $UNIORA_API_KEY" \
  -H 'Uniora-Actor-Subject: mgr' \
  -H "Content-Type: application/json" \
  -d '{
    "definition": {
      "actions": [
        "reports.read"
      ],
      "condition": {
        "eq": [
          {
            "ref": "subject.membershipStatus"
          },
          {
            "value": "active"
          }
        ]
      },
      "effect": "deny",
      "kind": "access"
    }
  }'
```

```ts
const result = await uniora.policies.validate(
  {
    organizationId: "org_acme",
    definition: {
      actions: ["reports.read"],
      condition: { eq: [{ ref: "subject.membershipStatus" }, { value: "active" }] },
      effect: "deny",
      kind: "access",
    },
  },
  { actor: { subject: "mgr" } },
);
```

```http
HTTP/1.1 200 OK

{
  "definition": {
    "actions": [
      "reports.read"
    ],
    "condition": {
      "eq": [
        {
          "ref": "subject.membershipStatus"
        },
        {
          "value": "active"
        }
      ]
    },
    "effect": "deny",
    "kind": "access"
  },
  "hash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1",
  "analysis": {
    "features": [],
    "permissions": [],
    "subjectRefs": [
      "subject.membershipStatus"
    ],
    "resourceRefs": [],
    "environmentRefs": [],
    "contextRefs": [],
    "sessionRefs": [],
    "nodes": 3,
    "depth": 1
  }
}
```

**Example: A definition the policy language refuses**

```bash
curl -X POST "https://uniora.example.com/v1/organizations/org_acme/policy-validations" \
  -H "Authorization: Bearer $UNIORA_API_KEY" \
  -H 'Uniora-Actor-Subject: mgr' \
  -H "Content-Type: application/json" \
  -d '{
    "definition": {
      "kind": "access"
    }
  }'
```

```ts
await uniora.policies.validate(
  { organizationId: "org_acme", definition: { kind: "access" } },
  { actor: { subject: "mgr" } },
);
```

```http
HTTP/1.1 400 Bad Request

{
  "type": "urn:uniora:error:policy_definition_invalid",
  "title": "Bad Request",
  "status": 400,
  "code": "policy_definition_invalid",
  "requestId": "req_xxxxxxxxxxxxxxx9"
}
```

### `POST /v1/organizations/:organizationId/policy-simulations`  <a id="policies-simulate"></a>

**What would be decided?** · operation `policies.simulate`

Answers `authorize` for any member and any resource, optionally with a candidate definition in place of a stored one. Writes nothing. Needs `policies.read`. `identity` is the person the question is about, not the actor. A delegated call: it speaks for the end user in the `Uniora-Actor-Subject` header, needs the `actor:assert` scope as well, and succeeds only if that user holds the policy permission (`policies.read`, `policies.manage`, `policies.activate`). Policy administration is never subject to policies.

- **Scope:** `organizations:read` and `actor:assert`
- **Kind:** delegated (speaks for an end user)
- **Changes data:** no

**Request**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `organizationId` | string (1–200 chars) | yes | (in the path) The organization. |
| `identity` | object | yes | Who the question is about. |
| `identity.provider` | string (1–64 chars) | no | An opaque label for the auth system the subject belongs to (not necessarily its vendor name). Omit it to use the server's default label. |
| `identity.subject` | string (1–500 chars) | yes | The user's stable id in your auth provider. Never an e-mail address. |
| `permission` | string (1–200 chars) | yes |  |
| `teamId` | string (1–200 chars) | no | Ask inside this team. |
| `resource` | object | no | The thing the question is about. |
| `resource.type` | string (1–64 chars) | yes | What kind of resource (`vehicle`, `ticket`): policies are matched on it. |
| `resource.id` | string (1–200 chars) | yes | The resource's id in your database. |
| `resource.organizationId` | string (1–200 chars) | yes | The organization the resource belongs to, as YOUR database says. A mismatch is `cross_tenant_resource`. |
| `resource.teamIds` | array (≤ 50) | no |  |
| `resource.attributes` | object (free keys) | no | The values of the attributes the policies declare (`status`, `ownerIdentity`...). |
| `context` | object (free keys) | no | Signals about the request that your server verified (`{ "ipCountry": "ES" }`). Only the ones a policy declares are used. |
| `session` | object | no | How the person authenticated, as your server's authentication states it. |
| `session.authenticatedAt` | string (date-time) | no | When the person last proved who they are (a sign-in or a step-up), NOT when the session began. |
| `session.startedAt` | string (date-time) | no | When the session began. |
| `session.mfa` | boolean | no | Whether a second factor was used. |
| `session.assuranceLevel` | integer (0–100) | no |  |
| `session.methods` | array (≤ 16) | no |  |
| `at` | string (date-time) | no | Pretend it is this moment (for `environment.*` conditions). |
| `requireApplicablePolicy` | boolean | no |  |
| `candidate` | object | no |  |
| `candidate.policyId` | string (1–200 chars) | no | Replace this policy's definition. |
| `candidate.definition` | object (free keys) | yes | The definition to try. |

Delegated calls also send `Uniora-Actor-Subject` (the end user, percent-encoded) and, when your server has no default label, `Uniora-Actor-Provider`.

**Response `200`**

| Field | Type | Description |
| --- | --- | --- |
| `allowed` | boolean | Check this, not `decision`. |
| `decision` | `allow` \| `deny` \| `indeterminate` |  |
| `reason` | string (≤ 64 chars) | Why. Stable codes; only ever added. |
| `organizationId` | string (≤ 200 chars) |  |
| `permission` | string (≤ 200 chars) |  |
| `via` | `membership` \| `support_grant`, may be absent |  |
| `policyRevision` | integer (0–…) or `null` |  |
| `stepUp` | object, may be absent |  |
| `stepUp.policyKeys` | array (≤ 100) |  |
| `policies` | array (≤ 500) | Every policy that applied, with the revision and what it said. |
| `evaluatedAt` | string (date-time) |  |

**Errors of this operation** (besides the ones every call can meet: see [Errors](#errors))

- `400` `actor_required`
- `400` `identity_provider_required`
- `400` `identity_provider_reserved`
- `400` `policy_definition_invalid`
- `403` `forbidden`
- `404` `organization_not_found`
- `501` `actor_token_unsupported`

**Example: What would be decided with this definition?**

```bash
curl -X POST "https://uniora.example.com/v1/organizations/org_acme/policy-simulations" \
  -H "Authorization: Bearer $UNIORA_API_KEY" \
  -H 'Uniora-Actor-Subject: mgr' \
  -H "Content-Type: application/json" \
  -d '{
    "identity": {
      "subject": "ana"
    },
    "permission": "reports.read",
    "candidate": {
      "definition": {
        "actions": [
          "reports.read"
        ],
        "condition": {
          "eq": [
            {
              "ref": "subject.membershipStatus"
            },
            {
              "value": "active"
            }
          ]
        },
        "effect": "deny",
        "kind": "access"
      }
    }
  }'
```

```ts
const result = await uniora.policies.simulate(
  {
    organizationId: "org_acme",
    identity: { subject: "ana" },
    permission: "reports.read",
    candidate: {
      definition: {
        actions: ["reports.read"],
        condition: { eq: [{ ref: "subject.membershipStatus" }, { value: "active" }] },
        effect: "deny",
        kind: "access",
      },
    },
  },
  { actor: { subject: "mgr" } },
);
```

```http
HTTP/1.1 200 OK

{
  "allowed": false,
  "decision": "deny",
  "reason": "policy_denied",
  "organizationId": "org_acme",
  "permission": "reports.read",
  "via": "membership",
  "policyRevision": 2,
  "policies": [
    {
      "policyId": "candidate",
      "key": "candidate",
      "kind": "access",
      "revision": 1,
      "definitionHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1",
      "effect": "deny",
      "result": "deny",
      "reason": "policy_denied"
    }
  ],
  "evaluatedAt": "2026-03-02T11:07:00.000Z"
}
```

## Invitations

Invite people, and the accept flow your server relays.

### `POST /v1/organizations/:organizationId/invitations`  <a id="invitations-create"></a>

**Invite someone by e-mail** · operation `invitations.create`

Creates the invitation and, if the server has a sender, e-mails the link. The Owner role can never be offered. Send an `Idempotency-Key` to make a retry safe: the same key with the same request creates and sends nothing and answers `replayed: true`; the same key with a different request is `invitation_idempotency_conflict`. A delegated call: it speaks for the end user in the `Uniora-Actor-Subject` header, needs the `actor:assert` scope as well, and succeeds only if that user may invite with those roles (`members.invite` and every permission of every role offered).

- **Scope:** `invitations:write` and `actor:assert`
- **Kind:** delegated (speaks for an end user)
- **Changes data:** yes (refused with `503 read_only` while the server is read-only)
- **`Idempotency-Key`:** accepted, so a retry cannot repeat the change

**Request**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `organizationId` | string (1–200 chars) | yes | (in the path) The organization. |
| `email` | string (3–320 chars) | yes |  |
| `roleIds` | array (≤ 20) | yes |  |
| `teamIds` | array (≤ 10) | no |  |
| `ttlMs` | integer (1–2592000000) | no | Lifetime of this link in milliseconds (30 days at most). |
| `locale` | string (2–35 chars) | no | Language hint for the e-mail. |
| `allowExistingMember` | boolean | no |  |

Delegated calls also send `Uniora-Actor-Subject` (the end user, percent-encoded) and, when your server has no default label, `Uniora-Actor-Provider`.

**Response `201`**

| Field | Type | Description |
| --- | --- | --- |
| `invitation` | object |  |
| `invitation.id` | string (≤ 200 chars) |  |
| `invitation.organizationId` | string (≤ 200 chars) |  |
| `invitation.email` | string (≤ 320 chars) | Normalized: trimmed and lower-cased. |
| `invitation.roleIds` | array (≤ 100) |  |
| `invitation.teamIds` | array (≤ 20) |  |
| `invitation.invitedBy` | object |  |
| `invitation.invitedBy.provider` | string (≤ 200 chars) |  |
| `invitation.invitedBy.subject` | string (≤ 500 chars) |  |
| `invitation.status` | `pending` \| `accepted` \| `revoked` \| `expired` | A `pending` invitation whose `expiresAt` has passed is already unusable. |
| `invitation.createdAt` | string (date-time) |  |
| `invitation.expiresAt` | string (date-time) |  |
| `invitation.acceptedAt` | string (date-time), may be absent |  |
| `invitation.acceptedBy` | object, may be absent |  |
| `invitation.acceptedBy.provider` | string (≤ 200 chars) |  |
| `invitation.acceptedBy.subject` | string (≤ 500 chars) |  |
| `invitation.revokedAt` | string (date-time), may be absent |  |
| `invitation.delivery` | object |  |
| `invitation.delivery.status` | `pending` \| `sent` \| `failed` |  |
| `invitation.delivery.attempts` | integer (0–100000) |  |
| `invitation.delivery.sends` | integer (0–100000) |  |
| `invitation.delivery.lastAttemptAt` | string (date-time), may be absent |  |
| `invitation.delivery.sentAt` | string (date-time), may be absent |  |
| `invitation.delivery.lastError` | string (≤ 1000 chars), may be absent | Sanitized. Safe to show an operator. |
| `acceptUrl` | string (≤ 2000 chars) or `null`, may be absent | The secret link. Present only when the server is configured to return it (`includeAcceptUrl`), and only once: it cannot be recovered. `null` on a replay. |
| `delivery` | object |  |
| `delivery.status` | `sent` \| `failed` \| `skipped` |  |
| `delivery.attempts` | integer (0–100000) |  |
| `delivery.error` | string (≤ 1000 chars), may be absent |  |
| `replayed` | boolean, may be absent | `true` when the `Idempotency-Key` was already used for this same request: nothing new was made or sent. |

**Errors of this operation** (besides the ones every call can meet: see [Errors](#errors))

- `400` `actor_required`
- `400` `identity_provider_required`
- `400` `identity_provider_reserved`
- `400` `invitation_bad_request`
- `403` `access_escalation`
- `403` `access_owner_protected`
- `403` `access_self_change`
- `403` `access_target_stronger`
- `403` `forbidden`
- `403` `invitation_teams_forbidden`
- `404` `organization_not_found`
- `409` `invitation_already_member`
- `409` `invitation_duplicate_pending`
- `409` `invitation_idempotency_conflict`
- `429` `invitation_rate_limited`
- `501` `actor_token_unsupported`
- `501` `invitations_not_configured`

**Example: Invite someone by e-mail**

```bash
curl -X POST "https://uniora.example.com/v1/organizations/org_acme/invitations" \
  -H "Authorization: Bearer $UNIORA_API_KEY" \
  -H 'Uniora-Actor-Subject: mgr' \
  -H 'Idempotency-Key: invite-new-person' \
  -H "Content-Type: application/json" \
  -d '{
    "email": "New.Person@example.com",
    "roleIds": [
      "role_viewer"
    ]
  }'
```

```ts
const result = await uniora.invitations.create(
  {
    organizationId: "org_acme",
    email: "New.Person@example.com",
    roleIds: ["role_viewer"],
  },
  { actor: { subject: "mgr" }, idempotencyKey: "invite-new-person" },
);
```

```http
HTTP/1.1 201 Created

{
  "invitation": {
    "id": "00000000-0000-4000-8000-000000000004",
    "organizationId": "org_acme",
    "email": "new.person@example.com",
    "roleIds": [
      "role_viewer"
    ],
    "teamIds": [],
    "invitedBy": {
      "provider": "main",
      "subject": "mgr"
    },
    "status": "pending",
    "createdAt": "2026-03-02T11:08:00.000Z",
    "expiresAt": "2026-03-02T11:09:00.000Z",
    "delivery": {
      "status": "pending",
      "attempts": 0,
      "sends": 0
    }
  },
  "acceptUrl": "https://app.test/invite/uinv_EXAMPLE_TOKEN_01___________________________",
  "delivery": {
    "status": "skipped",
    "attempts": 0
  }
}
```

**Example: Another invitation**

```bash
curl -X POST "https://uniora.example.com/v1/organizations/org_acme/invitations" \
  -H "Authorization: Bearer $UNIORA_API_KEY" \
  -H 'Uniora-Actor-Subject: mgr' \
  -H "Content-Type: application/json" \
  -d '{
    "email": "second@example.com",
    "roleIds": [
      "role_viewer"
    ]
  }'
```

```ts
const result = await uniora.invitations.create(
  {
    organizationId: "org_acme",
    email: "second@example.com",
    roleIds: ["role_viewer"],
  },
  { actor: { subject: "mgr" } },
);
```

```http
HTTP/1.1 201 Created

{
  "invitation": {
    "id": "00000000-0000-4000-8000-000000000005",
    "organizationId": "org_acme",
    "email": "second@example.com",
    "roleIds": [
      "role_viewer"
    ],
    "teamIds": [],
    "invitedBy": {
      "provider": "main",
      "subject": "mgr"
    },
    "status": "pending",
    "createdAt": "2026-03-02T11:10:00.000Z",
    "expiresAt": "2026-03-02T11:11:00.000Z",
    "delivery": {
      "status": "pending",
      "attempts": 0,
      "sends": 0
    }
  },
  "acceptUrl": "https://app.test/invite/uinv_EXAMPLE_TOKEN_02___________________________",
  "delivery": {
    "status": "skipped",
    "attempts": 0
  }
}
```

### `POST /v1/organizations/:organizationId/invitations/:invitationId/resend`  <a id="invitations-resend"></a>

**Send an invitation again** · operation `invitations.resend`

Issues a NEW link (the old one stops working), extends the expiry and sends again. A delegated call: it speaks for the end user in the `Uniora-Actor-Subject` header, needs the `actor:assert` scope as well, and succeeds only if that user may invite with those roles (`members.invite` and every permission of every role offered).

- **Scope:** `invitations:write` and `actor:assert`
- **Kind:** delegated (speaks for an end user)
- **Changes data:** yes (refused with `503 read_only` while the server is read-only)

**Request**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `organizationId` | string (1–200 chars) | yes | (in the path) The organization. |
| `invitationId` | string (1–200 chars) | yes | (in the path) The invitation. |
| `locale` | string (2–35 chars) | no |  |
| `ttlMs` | integer (1–2592000000) | no |  |

Delegated calls also send `Uniora-Actor-Subject` (the end user, percent-encoded) and, when your server has no default label, `Uniora-Actor-Provider`.

**Response `200`**

| Field | Type | Description |
| --- | --- | --- |
| `invitation` | object |  |
| `invitation.id` | string (≤ 200 chars) |  |
| `invitation.organizationId` | string (≤ 200 chars) |  |
| `invitation.email` | string (≤ 320 chars) | Normalized: trimmed and lower-cased. |
| `invitation.roleIds` | array (≤ 100) |  |
| `invitation.teamIds` | array (≤ 20) |  |
| `invitation.invitedBy` | object |  |
| `invitation.invitedBy.provider` | string (≤ 200 chars) |  |
| `invitation.invitedBy.subject` | string (≤ 500 chars) |  |
| `invitation.status` | `pending` \| `accepted` \| `revoked` \| `expired` | A `pending` invitation whose `expiresAt` has passed is already unusable. |
| `invitation.createdAt` | string (date-time) |  |
| `invitation.expiresAt` | string (date-time) |  |
| `invitation.acceptedAt` | string (date-time), may be absent |  |
| `invitation.acceptedBy` | object, may be absent |  |
| `invitation.acceptedBy.provider` | string (≤ 200 chars) |  |
| `invitation.acceptedBy.subject` | string (≤ 500 chars) |  |
| `invitation.revokedAt` | string (date-time), may be absent |  |
| `invitation.delivery` | object |  |
| `invitation.delivery.status` | `pending` \| `sent` \| `failed` |  |
| `invitation.delivery.attempts` | integer (0–100000) |  |
| `invitation.delivery.sends` | integer (0–100000) |  |
| `invitation.delivery.lastAttemptAt` | string (date-time), may be absent |  |
| `invitation.delivery.sentAt` | string (date-time), may be absent |  |
| `invitation.delivery.lastError` | string (≤ 1000 chars), may be absent | Sanitized. Safe to show an operator. |
| `acceptUrl` | string (≤ 2000 chars) or `null`, may be absent | The secret link. Present only when the server is configured to return it (`includeAcceptUrl`), and only once: it cannot be recovered. `null` on a replay. |
| `delivery` | object |  |
| `delivery.status` | `sent` \| `failed` \| `skipped` |  |
| `delivery.attempts` | integer (0–100000) |  |
| `delivery.error` | string (≤ 1000 chars), may be absent |  |
| `replayed` | boolean, may be absent | `true` when the `Idempotency-Key` was already used for this same request: nothing new was made or sent. |

**Errors of this operation** (besides the ones every call can meet: see [Errors](#errors))

- `400` `actor_required`
- `400` `identity_provider_required`
- `400` `identity_provider_reserved`
- `403` `access_escalation`
- `403` `access_owner_protected`
- `403` `access_self_change`
- `403` `access_target_stronger`
- `403` `forbidden`
- `404` `invitation_not_found`
- `404` `organization_not_found`
- `429` `invitation_cooldown`
- `429` `invitation_rate_limited`
- `501` `actor_token_unsupported`
- `501` `invitations_not_configured`

**Example: Send it again with a new link**

```bash
curl -X POST "https://uniora.example.com/v1/organizations/org_acme/invitations/00000000-0000-4000-8000-000000000005/resend" \
  -H "Authorization: Bearer $UNIORA_API_KEY" \
  -H 'Uniora-Actor-Subject: mgr' \
  -H "Content-Type: application/json" \
  -d '{}'
```

```ts
const result = await uniora.invitations.resend(
  {
    organizationId: "org_acme",
    invitationId: "00000000-0000-4000-8000-000000000005",
  },
  { actor: { subject: "mgr" } },
);
```

```http
HTTP/1.1 200 OK

{
  "invitation": {
    "id": "00000000-0000-4000-8000-000000000005",
    "organizationId": "org_acme",
    "email": "second@example.com",
    "roleIds": [
      "role_viewer"
    ],
    "teamIds": [],
    "invitedBy": {
      "provider": "main",
      "subject": "mgr"
    },
    "status": "pending",
    "createdAt": "2026-03-02T11:12:00.000Z",
    "expiresAt": "2026-03-02T11:13:00.000Z",
    "delivery": {
      "status": "pending",
      "attempts": 0,
      "sends": 0
    }
  },
  "acceptUrl": "https://app.test/invite/uinv_EXAMPLE_TOKEN_03___________________________",
  "delivery": {
    "status": "skipped",
    "attempts": 0
  }
}
```

### `DELETE /v1/organizations/:organizationId/invitations/:invitationId`  <a id="invitations-revoke"></a>

**Revoke an invitation** · operation `invitations.revoke`

The link stops working. An invitation of another organization answers exactly like one that does not exist. A delegated call: it speaks for the end user in the `Uniora-Actor-Subject` header, needs the `actor:assert` scope as well, and succeeds only if that user may invite with those roles (`members.invite` and every permission of every role offered).

- **Scope:** `invitations:write` and `actor:assert`
- **Kind:** delegated (speaks for an end user)
- **Changes data:** yes (refused with `503 read_only` while the server is read-only)

**Request**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `organizationId` | string (1–200 chars) | yes | (in the path) The organization. |
| `invitationId` | string (1–200 chars) | yes | (in the path) The invitation. |

Delegated calls also send `Uniora-Actor-Subject` (the end user, percent-encoded) and, when your server has no default label, `Uniora-Actor-Provider`.

**Response `200`**

| Field | Type | Description |
| --- | --- | --- |
| `id` | string (≤ 200 chars) |  |
| `organizationId` | string (≤ 200 chars) |  |
| `email` | string (≤ 320 chars) | Normalized: trimmed and lower-cased. |
| `roleIds` | array (≤ 100) |  |
| `teamIds` | array (≤ 20) |  |
| `invitedBy` | object |  |
| `invitedBy.provider` | string (≤ 200 chars) |  |
| `invitedBy.subject` | string (≤ 500 chars) |  |
| `status` | `pending` \| `accepted` \| `revoked` \| `expired` | A `pending` invitation whose `expiresAt` has passed is already unusable. |
| `createdAt` | string (date-time) |  |
| `expiresAt` | string (date-time) |  |
| `acceptedAt` | string (date-time), may be absent |  |
| `acceptedBy` | object, may be absent |  |
| `acceptedBy.provider` | string (≤ 200 chars) |  |
| `acceptedBy.subject` | string (≤ 500 chars) |  |
| `revokedAt` | string (date-time), may be absent |  |
| `delivery` | object |  |
| `delivery.status` | `pending` \| `sent` \| `failed` |  |
| `delivery.attempts` | integer (0–100000) |  |
| `delivery.sends` | integer (0–100000) |  |
| `delivery.lastAttemptAt` | string (date-time), may be absent |  |
| `delivery.sentAt` | string (date-time), may be absent |  |
| `delivery.lastError` | string (≤ 1000 chars), may be absent | Sanitized. Safe to show an operator. |

**Errors of this operation** (besides the ones every call can meet: see [Errors](#errors))

- `400` `actor_required`
- `400` `identity_provider_required`
- `400` `identity_provider_reserved`
- `403` `access_escalation`
- `403` `access_owner_protected`
- `403` `access_self_change`
- `403` `access_target_stronger`
- `403` `forbidden`
- `404` `invitation_not_found`
- `404` `organization_not_found`
- `501` `actor_token_unsupported`
- `501` `invitations_not_configured`

**Example: Revoke it**

```bash
curl -X DELETE "https://uniora.example.com/v1/organizations/org_acme/invitations/00000000-0000-4000-8000-000000000005" \
  -H "Authorization: Bearer $UNIORA_API_KEY" \
  -H 'Uniora-Actor-Subject: mgr'
```

```ts
const result = await uniora.invitations.revoke(
  {
    organizationId: "org_acme",
    invitationId: "00000000-0000-4000-8000-000000000005",
  },
  { actor: { subject: "mgr" } },
);
```

```http
HTTP/1.1 200 OK

{
  "id": "00000000-0000-4000-8000-000000000005",
  "organizationId": "org_acme",
  "email": "second@example.com",
  "roleIds": [
    "role_viewer"
  ],
  "teamIds": [],
  "invitedBy": {
    "provider": "main",
    "subject": "mgr"
  },
  "status": "revoked",
  "createdAt": "2026-03-02T11:14:00.000Z",
  "expiresAt": "2026-03-02T11:15:00.000Z",
  "revokedAt": "2026-03-02T11:16:00.000Z",
  "delivery": {
    "status": "pending",
    "attempts": 0,
    "sends": 0
  }
}
```

### `POST /v1/invitations/preview`  <a id="invitations-preview"></a>

**What an accept page may show before sign-in** · operation `invitations.preview`

Looks up an invitation by the secret token from its link. Every unusable token (unknown, expired, revoked, already used) answers the same `404 invalid_invitation`, so it cannot be used to probe which links exist. An application call: your server relays the token. It needs a client that may reach every organization, because the token, not the caller, names the organization.

- **Scope:** `invitations:write`
- **Kind:** application (your backend asks as itself)
- **Changes data:** no
- **Client:** one that may reach every organization (`*`)

**Request**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `token` | string (16–512 chars) | yes | The secret from the accept link. |

**Response `200`**

| Field | Type | Description |
| --- | --- | --- |
| `organizationName` | string (≤ 255 chars) |  |
| `email` | string (≤ 320 chars) |  |
| `roleNames` | array (≤ 100) |  |
| `teamNames` | array (≤ 20) |  |
| `expiresAt` | string (date-time) |  |

**Errors of this operation** (besides the ones every call can meet: see [Errors](#errors))

- `404` `invalid_invitation`
- `501` `invitations_not_configured`

**Example: What the accept page may show before sign-in**

```bash
curl -X POST "https://uniora.example.com/v1/invitations/preview" \
  -H "Authorization: Bearer $UNIORA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "token": "uinv_EXAMPLE_TOKEN_01___________________________"
  }'
```

```ts
const result = await uniora.invitations.preview(
  { token: "uinv_EXAMPLE_TOKEN_01___________________________" },
);
```

```http
HTTP/1.1 200 OK

{
  "organizationName": "Acme",
  "email": "new.person@example.com",
  "roleNames": [
    "Viewer"
  ],
  "teamNames": [],
  "expiresAt": "2026-03-02T11:17:00.000Z"
}
```

### `POST /v1/invitations/accept`  <a id="invitations-accept"></a>

**Accept an invitation as the person who just signed in** · operation `invitations.accept`

Needs the secret token AND an e-mail your auth provider has VERIFIED for `identity`, equal to the one invited: that is what stops a leaked link from being used by someone else's account. Pass only a provider-verified address, never one the user typed. UNIORA cannot verify it, so this is the one place your server vouches for the person. It re-checks, now, what the inviter may still give (`rolesSkipped`, `teamsSkipped`). Every way an accept can fail answers the same `400 invalid_invitation`. It needs a client that may reach every organization, because the token names the organization.

- **Scope:** `invitations:write`
- **Kind:** application (your backend asks as itself)
- **Changes data:** yes (refused with `503 read_only` while the server is read-only)
- **Client:** one that may reach every organization (`*`)

**Request**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `token` | string (16–512 chars) | yes | The secret from the accept link. |
| `identity` | object | yes | Who the question is about. |
| `identity.provider` | string (1–64 chars) | no | An opaque label for the auth system the subject belongs to (not necessarily its vendor name). Omit it to use the server's default label. |
| `identity.subject` | string (1–500 chars) | yes | The user's stable id in your auth provider. Never an e-mail address. |
| `verifiedEmail` | string (3–320 chars) | yes | The address the auth provider verified for `identity`. |

**Response `200`**

| Field | Type | Description |
| --- | --- | --- |
| `invitation` | object |  |
| `invitation.id` | string (≤ 200 chars) |  |
| `invitation.organizationId` | string (≤ 200 chars) |  |
| `invitation.email` | string (≤ 320 chars) | Normalized: trimmed and lower-cased. |
| `invitation.roleIds` | array (≤ 100) |  |
| `invitation.teamIds` | array (≤ 20) |  |
| `invitation.invitedBy` | object |  |
| `invitation.invitedBy.provider` | string (≤ 200 chars) |  |
| `invitation.invitedBy.subject` | string (≤ 500 chars) |  |
| `invitation.status` | `pending` \| `accepted` \| `revoked` \| `expired` | A `pending` invitation whose `expiresAt` has passed is already unusable. |
| `invitation.createdAt` | string (date-time) |  |
| `invitation.expiresAt` | string (date-time) |  |
| `invitation.acceptedAt` | string (date-time), may be absent |  |
| `invitation.acceptedBy` | object, may be absent |  |
| `invitation.acceptedBy.provider` | string (≤ 200 chars) |  |
| `invitation.acceptedBy.subject` | string (≤ 500 chars) |  |
| `invitation.revokedAt` | string (date-time), may be absent |  |
| `invitation.delivery` | object |  |
| `invitation.delivery.status` | `pending` \| `sent` \| `failed` |  |
| `invitation.delivery.attempts` | integer (0–100000) |  |
| `invitation.delivery.sends` | integer (0–100000) |  |
| `invitation.delivery.lastAttemptAt` | string (date-time), may be absent |  |
| `invitation.delivery.sentAt` | string (date-time), may be absent |  |
| `invitation.delivery.lastError` | string (≤ 1000 chars), may be absent | Sanitized. Safe to show an operator. |
| `membershipId` | string (≤ 200 chars) |  |
| `roleIds` | array (≤ 1000) |  |
| `rolesSkipped` | array (≤ 100) |  |
| `alreadyMember` | boolean |  |
| `teamIds` | array (≤ 20) |  |
| `teamsSkipped` | array (≤ 20) |  |

**Errors of this operation** (besides the ones every call can meet: see [Errors](#errors))

- `400` `identity_provider_required`
- `400` `identity_provider_reserved`
- `400` `invalid_invitation`
- `429` `invitation_rate_limited`
- `501` `invitations_not_configured`

**Example: The person signs up and accepts**

```bash
curl -X POST "https://uniora.example.com/v1/invitations/accept" \
  -H "Authorization: Bearer $UNIORA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "token": "uinv_EXAMPLE_TOKEN_01___________________________",
    "identity": {
      "subject": "newbie-1"
    },
    "verifiedEmail": "new.person@example.com"
  }'
```

```ts
const result = await uniora.invitations.accept(
  {
    token: "uinv_EXAMPLE_TOKEN_01___________________________",
    identity: { subject: "newbie-1" },
    verifiedEmail: "new.person@example.com",
  },
);
```

```http
HTTP/1.1 200 OK

{
  "invitation": {
    "id": "00000000-0000-4000-8000-000000000004",
    "organizationId": "org_acme",
    "email": "new.person@example.com",
    "roleIds": [
      "role_viewer"
    ],
    "teamIds": [],
    "invitedBy": {
      "provider": "main",
      "subject": "mgr"
    },
    "status": "accepted",
    "createdAt": "2026-03-02T11:18:00.000Z",
    "expiresAt": "2026-03-02T11:19:00.000Z",
    "acceptedAt": "2026-03-02T11:20:00.000Z",
    "acceptedBy": {
      "provider": "main",
      "subject": "newbie-1"
    },
    "delivery": {
      "status": "pending",
      "attempts": 0,
      "sends": 0
    }
  },
  "membershipId": "00000000-0000-4000-8000-000000000001",
  "roleIds": [
    "role_viewer"
  ],
  "rolesSkipped": [],
  "alreadyMember": false,
  "teamIds": [],
  "teamsSkipped": []
}
```

## Audit log

The tamper-evident history of an organization.

### `GET /v1/organizations/:organizationId/audit-log`  <a id="audit-list"></a>

**An organization's audit log** · operation `audit.list`

Newest first. Paged with a keyset cursor, so new entries never make a page skip or repeat rows.

- **Scope:** `audit:read`
- **Kind:** application (your backend asks as itself)
- **Changes data:** no

**Request**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `organizationId` | string (1–200 chars) | yes | (in the path) The organization. |
| `limit` | integer (1–1000) | no | (query) Items per page. At most the server's maximum (100 unless configured). |
| `cursor` | string (1–600 chars) | no | (query) The `nextCursor` of the previous page. |

**Response `200`**

| Field | Type | Description |
| --- | --- | --- |
| `items` | array (≤ 1000) |  |
| `items[].id` | string (≤ 200 chars) |  |
| `items[].organizationId` | string (≤ 200 chars), may be absent |  |
| `items[].actor` | object |  |
| `items[].actor.provider` | string (≤ 200 chars) |  |
| `items[].actor.subject` | string (≤ 500 chars) |  |
| `items[].action` | string (≤ 200 chars) |  |
| `items[].target` | object, may be absent |  |
| `items[].target.type` | string (≤ 200 chars) |  |
| `items[].target.id` | string (≤ 200 chars) |  |
| `items[].metadata` | any JSON, may be absent |  |
| `items[].createdAt` | string (date-time) |  |
| `nextCursor` | string (≤ 600 chars) or `null` | Pass it back as `cursor` for the next page; `null` on the last one. |

**Errors of this operation** (besides the ones every call can meet: see [Errors](#errors))

- `400` `invalid_cursor`
- `400` `invalid_request`
- `404` `organization_not_found`

**Example: The newest entries of the audit log**

```bash
curl -X GET "https://uniora.example.com/v1/organizations/org_acme/audit-log?limit=4" \
  -H "Authorization: Bearer $UNIORA_API_KEY"
```

```ts
const result = await uniora.audit.list({ organizationId: "org_acme", limit: 4 });
```

```http
HTTP/1.1 200 OK

{
  "items": [
    {
      "id": "audit:EXAMPLE0001",
      "organizationId": "org_acme",
      "actor": {
        "provider": "main",
        "subject": "mgr"
      },
      "action": "membership.deleted",
      "target": {
        "type": "membership",
        "id": "00000000-0000-4000-8000-000000000001"
      },
      "metadata": {
        "via": {
          "apiClientId": "apc_EXAMPLE00001",
          "keyId": "EXAMPLEKEYID0001",
          "requestId": "req_xxxxxxxxxxxxxx1x"
        }
      },
      "createdAt": "2026-03-02T11:21:00.000Z"
    },
    {
      "id": "00000000-0000-4000-8000-000000000007",
      "organizationId": "org_acme",
      "actor": {
        "provider": "main",
        "subject": "mgr"
      },
      "action": "invitation.revoked",
      "target": {
        "type": "invitation",
        "id": "00000000-0000-4000-8000-000000000005"
      },
      "metadata": {
        "emailFingerprint": "e9138a31d3cd584893b7c3b17bf0f376",
        "via": {
          "apiClientId": "apc_EXAMPLE00001",
          "keyId": "EXAMPLEKEYID0001",
          "requestId": "req_xxxxxxxxxxxxxx11"
        }
      },
      "createdAt": "2026-03-02T11:22:00.000Z"
    },
    {
      "id": "00000000-0000-4000-8000-000000000008",
      "organizationId": "org_acme",
      "actor": {
        "provider": "main",
        "subject": "mgr"
      },
      "action": "invitation.resent",
      "target": {
        "type": "invitation",
        "id": "00000000-0000-4000-8000-000000000005"
      },
      "metadata": {
        "emailFingerprint": "e9138a31d3cd584893b7c3b17bf0f376",
        "via": {
          "apiClientId": "apc_EXAMPLE00001",
          "keyId": "EXAMPLEKEYID0001",
          "requestId": "req_xxxxxxxxxxxxxx12"
        }
      },
      "createdAt": "2026-03-02T11:23:00.000Z"
    },
    {
      "id": "00000000-0000-4000-8000-000000000009",
      "organizationId": "org_acme",
      "actor": {
        "provider": "main",
        "subject": "mgr"
      },
      "action": "invitation.created",
      "target": {
        "type": "invitation",
        "id": "00000000-0000-4000-8000-000000000005"
      },
      "metadata": {
        "emailFingerprint": "e9138a31d3cd584893b7c3b17bf0f376",
        "roles": [
          "Viewer"
        ],
        "via": {
          "apiClientId": "apc_EXAMPLE00001",
          "keyId": "EXAMPLEKEYID0001",
          "requestId": "req_xxxxxxxxxxxxxx13"
        }
      },
      "createdAt": "2026-03-02T11:24:00.000Z"
    }
  ],
  "nextCursor": "EXAMPLE_OPAQUE_CURSOR"
}
```
