# Errors

Every error UNIORA throws on purpose extends `UnioraError` and carries a stable, machine-readable `code`. Branch on the code, never on the English
`message` (which may be reworded). **Codes are only ever added, never renamed or repurposed.**

```ts
import { UnioraError } from "@uniora/core";

try {
  await storage.memberships.block(membershipId, { actor });
} catch (error) {
  if (error instanceof UnioraError && error.code === "last_owner") {
    return reply(409, "An organization must keep at least one active Owner.");
  }
  throw error; // anything else is a real bug or an outage
}
```

Each area has its own class, all subclasses of `UnioraError`: `OrganizationError`, `MembershipError`, `RoleError`, `PermissionError`, `FeatureError`,
`IdentityLinkError`, `InvitationError`, `AuditLogError`, `OutboxError`, `EntitlementError`, `SupportGrantError`, `TeamError`. Across a framework boundary (Next.js can load a module twice)
compare `error.name` or `error.code` instead of `instanceof`.

Errors that are not `UnioraError`: `AuthorizationDeniedError` (`@uniora/next`, thrown by `assertCan`/`assertAccess`), `SmtpConfigError` (`@uniora/mailer-smtp`), `MigrationError`
and `SqliteUrlError` (storage packages), and `TypeError`/`RangeError` for programmer mistakes such as a missing option.

## Codes

### Organization

| Code | When |
| --- | --- |
| `organization_not_found` | The organization does not exist. |
| `organization_exists` | The id is already taken. |
| `organization_slug_taken` | Another organization has this slug. |
| `organization_name_invalid` / `organization_slug_invalid` | Empty, too long, wrong shape. |
| `organization_status_invalid` | Not `active`, `suspended` or `archived`. |
| `organization_update_empty` | `update` was called with neither a name nor a slug. |
| `feature_version_conflict` | `enable` / `disable` was given an `expectedVersion` (0 = no override yet) and the feature override has changed since it was read. Nothing was changed: read it again and retry. |
| `membership_version_conflict` | `assignRole`, `unassignRole`, `block` or `unblock` was given an `expectedVersion` and the membership has changed since it was read. Nothing was changed: read it again and retry. |
| `organization_version_conflict` | `update` was given an `expectedVersion` and the organization has changed since it was read. Nothing was changed: read it again and retry. |
| `organization_invalid` | Any other invalid input. |

### Membership

| Code | When |
| --- | --- |
| `membership_not_found` | No such membership. |
| `membership_exists` | The identity already has a membership in this organization, or the id is taken. |
| `membership_blocked` | The operation is not allowed on a blocked member. |
| `role_not_found` / `role_wrong_organization` | The role does not exist, or belongs to another organization. |
| `owner_role_protected` | Tried to assign or unassign the Owner role with the regular methods. |
| `not_owner_role` | `assignOwnerRole` / `unassignOwnerRole` with a role that is not the Owner role. |
| `last_owner` | The change would leave the organization without an active Owner. |
| `identity_aliased` | The identity is linked as an alias of another one. |
| `identity_link_busy` | Too much concurrent identity linking; retry. |
| `membership_block_until_invalid` | The end date of a suspension is not a valid date, or is not in the future. |
| `membership_invalid` | Any other invalid input. |

### Role

| Code | When |
| --- | --- |
| `role_not_found` | No such role. |
| `role_exists` / `role_key_exists` | Name or key already used in the organization. |
| `role_name_invalid` / `role_key_invalid` / `role_description_invalid` | Empty, too long, wrong shape. |
| `role_key_reserved` | `owner` is reserved. |
| `role_permission_invalid` | A permission key is empty or not registered. Nothing was changed. |
| `owner_role_protected` / `owner_role_exists` | The Owner role can't be changed this way / the organization already has one. |
| `role_system_protected` | A system role can't be renamed or deleted. |
| `role_in_use` | `delete` with `members: "reject"` while someone holds the role. |
| `role_reassign_invalid` | `reassignTo` names a role that doesn't exist or belongs to another organization. |
| `role_update_empty` | `update` with nothing to change. |
| `role_version_conflict` | `update` or `setPermissions` was given an `expectedVersion` and the role has changed since it was read. Nothing was changed: read it again and retry. |
| `role_invalid` | Any other invalid input. |

### Permission

`permission_not_found`, `permission_in_use` (still granted to a role), `permission_has_dependents` (another permission implies it), `permission_name_invalid`,
`permission_key_invalid`, `permission_group_invalid`, `permission_implication_invalid` (unregistered target, self-reference, cycle, or too deep or too many), `permission_invalid`.

### Feature

`feature_unknown` (never registered), `feature_in_use` (still enabled somewhere), `feature_has_children`, `feature_name_invalid`, `feature_key_invalid`, `feature_parent_invalid`, `feature_invalid`.

### Identity link

`identity_link_self`, `identity_link_conflict` (ambiguous or hijack-like request), `identity_link_busy`, `identity_link_invalid`.

### Invitation

The code is `invitation_` plus the reason (`InvitationError.reason`):

| Code | HTTP via `invitationErrorToHttp` | Meaning |
| --- | --- | --- |
| `invitation_invalid` | 400 `invalid_invitation` | Unknown token, or one replaced by a resend. |
| `invitation_expired`, `invitation_revoked`, `invitation_already_accepted`, `invitation_email_mismatch`, `invitation_roles_unavailable` | 400 `invalid_invitation` | Deliberately indistinguishable to the caller. Log the real code on the server. |
| `invitation_duplicate_pending` | 409 `duplicate_pending` | That address already has a pending invitation here. |
| `invitation_idempotency_conflict` | 409 `idempotency_conflict` | `invite` was given an `idempotencyKey` that an earlier invitation of this organization already used for a different request. |
| `invitation_already_member` | 409 `already_member` | `invite()` found that the address already belongs to a member (only when the service has `findIdentitiesByEmail`). |
| `invitation_rate_limited`, `invitation_cooldown` | 429 `rate_limited` | Too many invitations, or a resend too soon. |
| `invitation_teams_forbidden` | 403 `teams_forbidden` | `invite({ teamIds })` offered a team the inviter may not add people to (`teams.members.add`). |
| `invitation_bad_request` | 400 `bad_request` | Invalid e-mail, no roles, the Owner role, a role of another organization, a team that is missing, archived or of another organization. |

### Audit log

`audit_actor_required`, `audit_action_invalid`, `audit_prune_invalid` (cut-off in the future, invalid date, or less than 30 days of retention).

### Outbox

`outbox_event_invalid`, `outbox_payload_invalid` (over 16 KiB or not JSON), `outbox_event_exists`, `outbox_claim_invalid`.

### Entitlement

`entitlement_unknown`, `entitlement_key_invalid`, `entitlement_name_invalid`, `entitlement_limit_invalid`, `entitlement_amount_invalid`, `entitlement_organization_unknown`,
`entitlement_invalid`. `consume` does **not** throw when a limit is reached: it returns `{ allowed: false, … }` (`entitlement_limit_exceeded` is reserved and not thrown today).

### Support grant

`support_grant_invalid`, `support_grant_exists`, `support_grant_reason_invalid`, `support_grant_permission_invalid`, `support_grant_expiry_invalid`, `support_grant_organization_unknown`.

### Team

`team_not_found` (also for a team of another organization), `team_exists`, `team_slug_taken`, `team_external_id_taken`, `team_name_invalid`, `team_slug_invalid`, `team_external_id_invalid`, `team_data_invalid`, `team_organization_unknown`, `team_update_empty`, `team_archived`, `team_not_archived`, `team_version_conflict`, `team_invalid`.
Team memberships: `team_membership_not_found`, `team_membership_exists`, `team_membership_invalid`, `team_membership_transition_invalid`, `team_membership_version_conflict`, `team_member_unknown` (the organization membership does not exist in that organization), `team_role_invalid`, `team_role_owner_protected`, `team_accept_forbidden`, `team_forbidden` (the team service refused the actor), `team_authorization_required` (a team write reached the storage without a valid `TeamAuthorization`).

## Denials are not errors

`engine.can` and `engine.access.check` **return `false`**; they don't throw. A malformed key, unknown organization, missing membership or a database
hiccup in your own code can't be confused with "allowed". The framework helpers turn `false` into `403` (Express, `authorizeRoute`) or `AuthorizationDeniedError` (`assertCan`).
