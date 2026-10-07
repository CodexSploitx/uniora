/**
 * The standard audit action names UNIORA itself records, as `<object>.<past-tense verb>`. A host can record its own
 * actions through `auditLogs.record` (use its own namespace, e.g. `billing.invoice_paid`); these are the ones the
 * library emits, so a dashboard or an alert can rely on the spelling.
 */
export const AUDIT_ACTIONS = [
  "organization.created",
  "organization.renamed",
  "organization.updated",
  "organization.status_changed",
  "organization.ownership_transferred",
  "membership.created",
  "membership.deleted",
  "membership.left",
  "membership.blocked",
  "membership.suspended",
  "membership.unblocked",
  "membership.role_assigned",
  "membership.role_unassigned",
  "membership.owner_role_assigned",
  "membership.owner_role_unassigned",
  "role.created",
  "role.owner_created",
  "role.renamed",
  "role.updated",
  "role.cloned",
  "role.permissions_replaced",
  "role.deleted",
  "role.permission_granted",
  "role.permission_revoked",
  "permission.registered",
  "permission.unregistered",
  "feature.registered",
  "feature.unregistered",
  "feature.enabled",
  "feature.disabled",
  "feature.bulk_changed",
  "feature.disabled_everywhere",
  "entitlement.defined",
  "entitlement.removed",
  "entitlement.limit_changed",
  "entitlement.limit_cleared",
  "support_grant.created",
  "support_grant.revoked",
  "invitation.created",
  "invitation.resent",
  "invitation.revoked",
  "invitation.accepted",
  "invitation.delivery_failed",
  "identity_link.created",
  "identity_link.removed",
  "audit_log.pruned",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

const STANDARD = new Set<string>(AUDIT_ACTIONS);

/** Whether `action` is one of the names UNIORA itself records. */
export function isStandardAuditAction(action: string): action is AuditAction {
  return STANDARD.has(action);
}
