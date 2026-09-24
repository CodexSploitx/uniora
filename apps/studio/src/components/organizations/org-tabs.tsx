import Link from "next/link";
import { getT } from "@/i18n/server";
import type { OrgHeader } from "@/lib/types";

export const ORG_TABS = ["members", "roles", "features", "activity"] as const;
export type OrgTab = (typeof ORG_TABS)[number];

export function parseOrgTab(value: string | undefined): OrgTab {
  return (ORG_TABS as readonly string[]).includes(value ?? "") ? (value as OrgTab) : "members";
}

/**
 * URL-driven tabs (`?tab=`): each tab is its own server render that loads only
 * its own bounded page, instead of one client-side tab strip that needed every
 * tab's data up front.
 */
export async function OrgTabs({ organizationId, active, header }: { organizationId: string; active: OrgTab; header: OrgHeader }) {
  const { t } = await getT();
  const labels: Record<OrgTab, string> = {
    members: t("tabs.members", { count: header.memberCount }),
    roles: t("tabs.roles", { count: header.roleCount }),
    features: t("tabs.features", { enabled: header.featuresEnabled, total: header.featuresTotal }),
    activity: t("tabs.activity"),
  };

  return (
    <nav aria-label={t("tabs.aria")} className="inline-flex w-fit max-w-full items-center gap-1 overflow-x-auto rounded-lg bg-muted p-1">
      {ORG_TABS.map((tab) => (
        <Link
          key={tab}
          href={`/organizations/${organizationId}?tab=${tab}`}
          aria-current={tab === active ? "page" : undefined}
          className={
            "rounded-md px-3 py-1 text-sm font-medium whitespace-nowrap transition-colors " +
            (tab === active ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")
          }
        >
          {labels[tab]}
        </Link>
      ))}
    </nav>
  );
}
