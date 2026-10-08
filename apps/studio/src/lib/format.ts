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
      return { title: item.action, detail: item.target ? `${item.target.type}:${item.target.id}` : undefined, tone: "info" };
  }
}
