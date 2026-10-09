import type { Locale } from "@/i18n/config";
import type { Translator } from "@/i18n/translate";
import type { ActivityItem } from "@/lib/types";

export function timeAgo(iso: string, locale: Locale, t: Translator, now: number = Date.now()): string {
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const steps: [Intl.RelativeTimeFormatUnit, number][] = [
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ];
  for (const [unit, size] of steps) {
    if (Math.abs(seconds) >= size) return formatter.format(Math.round(seconds / size), unit);
  }
  return t("time.justNow");
}

export function formatDate(iso: string, locale: Locale): string {
  return new Date(iso).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
}

const meta = (item: ActivityItem, key: string): string | undefined => {
  const value = item.metadata?.[key];
  return typeof value === "string" ? value : undefined;
};

/** Human-readable phrasing (in the viewer's language) for the audit actions Studio itself records. */
export function describeActivity(
  item: ActivityItem,
  t: Translator,
): { title: string; detail?: string; tone: "success" | "info" | "warning" | "destructive" } {
  const role = meta(item, "role") ?? meta(item, "name");
  const permission = meta(item, "permission");
  const identity = item.metadata?.identity as { provider?: string; subject?: string } | undefined;
  const who = identity?.subject;

  switch (item.action) {
    case "organization.created":
      return { title: t("activity.organizationCreated"), detail: meta(item, "name"), tone: "success" };
    case "role.created":
      return { title: t("activity.roleCreated"), detail: role, tone: "success" };
    case "role.renamed":
      return { title: t("activity.roleRenamed"), detail: `${meta(item, "from")} → ${meta(item, "to")}`, tone: "info" };
    case "role.deleted":
      return { title: t("activity.roleDeleted"), detail: role, tone: "destructive" };
    case "role.permission_granted":
      return { title: t("activity.permissionGranted"), detail: `${permission} → ${role}`, tone: "success" };
    case "role.permission_revoked":
      return { title: t("activity.permissionRevoked"), detail: `${permission} ✕ ${role}`, tone: "warning" };
    case "membership.created":
      return { title: t("activity.memberAdded"), detail: who, tone: "success" };
    case "membership.deleted":
      return { title: t("activity.memberRemoved"), detail: who, tone: "destructive" };
    case "membership.role_assigned":
      return { title: t("activity.roleAssigned"), detail: `${role} → ${who}`, tone: "info" };
    case "membership.role_unassigned":
      return { title: t("activity.roleUnassigned"), detail: `${role} ✕ ${who}`, tone: "warning" };
    case "feature.enabled":
      return { title: t("activity.featureEnabled"), detail: item.target?.id, tone: "success" };
    case "feature.disabled":
      return { title: t("activity.featureDisabled"), detail: item.target?.id, tone: "warning" };
    case "invitation.created":
      return { title: t("activity.invitationCreated"), tone: "success" };
    case "invitation.resent":
      return { title: t("activity.invitationResent"), tone: "info" };
    case "invitation.revoked":
      return { title: t("activity.invitationRevoked"), tone: "warning" };
    case "invitation.accepted":
      return { title: t("activity.invitationAccepted"), tone: "success" };
    case "invitation.delivery_failed":
      return { title: t("activity.invitationDeliveryFailed"), detail: meta(item, "error"), tone: "warning" };
    case "organization.ownership_transferred":
      return { title: t("activity.ownershipTransferred"), tone: "warning" };
    case "membership.left":
      return { title: t("activity.memberLeft"), detail: who, tone: "warning" };
    case "team.created":
      return { title: t("activity.teamCreated"), detail: meta(item, "name"), tone: "success" };
    case "team.updated":
      return { title: t("activity.teamUpdated"), detail: item.target?.id, tone: "info" };
    case "team.archived":
      return { title: t("activity.teamArchived"), detail: item.target?.id, tone: "warning" };
    case "team.restored":
      return { title: t("activity.teamRestored"), detail: item.target?.id, tone: "success" };
    case "team.deleted":
      return { title: t("activity.teamDeleted"), detail: meta(item, "name"), tone: "destructive" };
    case "team_member.added":
    case "team_member.invited":
    case "team_member.accepted":
    case "team_member.reactivated":
      return { title: t("activity.teamMemberAdded"), detail: who ?? item.target?.id, tone: "success" };
    case "team_member.suspended":
      return { title: t("activity.teamMemberSuspended"), detail: item.target?.id, tone: "warning" };
    case "team_member.removed":
      return { title: t("activity.teamMemberRemoved"), detail: item.target?.id, tone: "destructive" };
    case "team.owner_changed":
    case "team.manager_changed":
      return { title: t("activity.teamResponsibilityChanged"), detail: `${meta(item, "from") ?? ""} → ${meta(item, "to") ?? ""}`, tone: "info" };
    case "membership.blocked":
      return { title: t("activity.memberBlocked"), detail: who, tone: "destructive" };
    case "membership.unblocked":
      return { title: t("activity.memberUnblocked"), detail: who, tone: "success" };
    case "membership.suspended":
      return { title: t("activity.memberSuspended"), detail: who, tone: "warning" };
    case "organization.status_changed":
      return { title: t("activity.organizationStatusChanged"), detail: meta(item, "status") ?? meta(item, "to"), tone: "warning" };
    case "organization.renamed":
    case "organization.updated":
      return { title: t("activity.organizationUpdated"), detail: meta(item, "name") ?? meta(item, "to"), tone: "info" };
    case "membership.owner_role_assigned":
      return { title: t("activity.ownerRoleAssigned"), detail: who, tone: "info" };
    case "membership.owner_role_unassigned":
      return { title: t("activity.ownerRoleUnassigned"), detail: who, tone: "warning" };
    case "role.cloned":
    case "role.owner_created":
      return { title: t("activity.roleCreated"), detail: role, tone: "success" };
    case "role.updated":
      return { title: t("activity.roleUpdated"), detail: role, tone: "info" };
    case "role.permissions_replaced":
      return { title: t("activity.rolePermissionsReplaced"), detail: role, tone: "info" };
    case "feature.bulk_changed":
      return { title: t("activity.featureBulkChanged"), tone: "info" };
    case "feature.disabled_everywhere":
      return { title: t("activity.featureDisabledEverywhere"), detail: item.target?.id, tone: "warning" };
    case "feature.registered":
      return { title: t("activity.featureRegistered"), detail: item.target?.id, tone: "success" };
    case "feature.unregistered":
      return { title: t("activity.featureUnregistered"), detail: item.target?.id, tone: "warning" };
    case "permission.registered":
      return { title: t("activity.permissionRegistered"), detail: item.target?.id, tone: "success" };
    case "permission.unregistered":
      return { title: t("activity.permissionUnregistered"), detail: item.target?.id, tone: "warning" };
    case "identity_link.removed":
      return { title: t("activity.identityLinkRemoved"), tone: "warning" };
    case "audit_log.pruned":
      return { title: t("activity.auditPruned"), tone: "info" };
    case "entitlement.defined":
    case "entitlement.removed":
    case "entitlement.limit_changed":
    case "entitlement.limit_cleared":
      return { title: t("activity.entitlementChanged"), detail: item.target?.id, tone: "info" };
    case "team_member.role_assigned":
    case "team_member.role_unassigned":
      return { title: t("activity.teamMemberRoleChanged"), detail: who ?? item.target?.id, tone: "info" };
    case "policy.created":
      return { title: t("activity.policyCreated"), detail: meta(item, "key") ?? item.target?.id, tone: "success" };
    case "policy.updated":
    case "policy.revised":
      return { title: t("activity.policyChanged"), detail: meta(item, "key") ?? item.target?.id, tone: "info" };
    case "policy.activated":
      return { title: t("activity.policyActivated"), detail: meta(item, "key") ?? item.target?.id, tone: "success" };
    case "policy.disabled":
      return { title: t("activity.policyDisabled"), detail: meta(item, "key") ?? item.target?.id, tone: "warning" };
    case "policy.retired":
    case "policy.deleted":
      return { title: t("activity.policyRetired"), detail: meta(item, "key") ?? item.target?.id, tone: "destructive" };
    case "policy.decision_denied":
    case "policy.decision_indeterminate":
    case "policy.decision_allowed":
      return { title: t(item.action === "policy.decision_allowed" ? "activity.policyDecisionAllowed" : "activity.policyDecisionRefused"), detail: meta(item, "permission") ?? item.target?.id, tone: item.action === "policy.decision_allowed" ? "info" : "warning" };
    case "support_grant.created":
    case "support_grant.revoked":
    case "platform.support_access_granted":
    case "platform.support_access_revoked":
      return { title: t("activity.supportAccess"), tone: "warning" };
    case "identity_link.created": {
      // Global entry (docs/security-pentest-2026-09-24.md Hallazgo 5) — no
      // `role`/`identity` string metadata like the others, just the two
      // linked identities.
      const from = item.metadata?.from as { provider?: string; subject?: string } | undefined;
      const to = item.metadata?.to as { provider?: string; subject?: string } | undefined;
      const detail = from && to ? `${from.provider}:${from.subject} → ${to.provider}:${to.subject}` : undefined;
      return { title: t("activity.identityLinkCreated"), detail, tone: "info" };
    }
    default:
      if (item.action.startsWith("platform.")) {
        return { title: t("activity.platformChange"), detail: item.action.slice("platform.".length).replaceAll("_", " "), tone: "info" };
      }
      return { title: item.action, detail: item.target ? `${item.target.type}:${item.target.id}` : undefined, tone: "info" };
  }
}
