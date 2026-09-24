import {
  IconBuildingSkyscraper,
  IconHistory,
  IconKey,
  IconShieldLock,
  IconToggleRight,
  IconUsers,
} from "@tabler/icons-react";
import Link from "next/link";
import { ActivityFeed } from "@/components/shared/activity-feed";
import { CreateOrganizationDialog } from "@/components/organizations/create-organization-dialog";
import { PageHeader } from "@/components/shell/page-header";
import { Frame, FrameDescription, FrameHeader, FramePanel, FrameTitle } from "@/components/reui/frame";
import { IconTile } from "@/components/reui/icon-tile";
import { Button } from "@/components/ui/button";
import { getT } from "@/i18n/server";
import { getOverview } from "@/lib/queries";
import { getDefaultAuthProvider, isReadOnly } from "@/lib/session";

// More rows than the activity feed's `limit: 8` (queries.ts) on purpose —
// each org row is shorter than an activity entry, so this keeps the two
// side-by-side cards close in height instead of leaving the org list
// looking half-empty under a taller activity feed.
const OVERVIEW_ORG_LIMIT = 10;

export default async function OverviewPage() {
  const overview = await getOverview(OVERVIEW_ORG_LIMIT);
  const { t } = await getT();
  const readOnly = isReadOnly();
  const defaultProvider = getDefaultAuthProvider();

  const stats = [
    { label: t("stat.organizations"), value: overview.organizationCount, icon: IconBuildingSkyscraper, href: "/organizations" },
    { label: t("stat.members"), value: overview.memberCount, icon: IconUsers, href: "/organizations" },
    { label: t("stat.roles"), value: overview.roleCount, icon: IconShieldLock, href: "/organizations" },
    { label: t("stat.permissions"), value: overview.permissionCount, icon: IconKey, href: "/permissions" },
    { label: t("stat.features"), value: overview.featureCount, icon: IconToggleRight, href: "/features" },
  ];

  return (
    <>
      <PageHeader
        title={t("overview.title")}
        description={t("overview.description")}
        actions={readOnly ? undefined : <CreateOrganizationDialog defaultProvider={defaultProvider} />}
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
        {stats.map((stat) => (
          <Link
            key={stat.label}
            href={stat.href}
            className="group flex flex-col gap-3 rounded-xl border bg-card p-4 transition-colors hover:border-primary/40"
          >
            <IconTile variant="soft" size="sm">
              <stat.icon />
            </IconTile>
            <div>
              <div className="font-heading text-3xl font-semibold tabular-nums">{stat.value}</div>
              <div className="text-xs text-muted-foreground">{stat.label}</div>
            </div>
          </Link>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-5">
        <Frame className="lg:col-span-3">
          <FrameHeader>
            <FrameTitle>{t("overview.orgsTitle")}</FrameTitle>
            <FrameDescription>{t("overview.orgsDescription")}</FrameDescription>
          </FrameHeader>
          <FramePanel>
            {overview.organizations.length === 0 ? (
              <div className="flex flex-col items-start gap-3 py-2">
                <p className="text-sm text-muted-foreground">{t("overview.noOrgs")}</p>
                {!readOnly && <CreateOrganizationDialog defaultProvider={defaultProvider} />}
              </div>
            ) : (
              <ul className="flex flex-col divide-y">
                {overview.organizations.map((organization) => (
                  <li key={organization.id}>
                    <Link
                      href={`/organizations/${organization.id}`}
                      className="flex items-center justify-between gap-4 py-3 transition-colors hover:text-primary"
                    >
                      <div className="flex min-w-0 flex-col">
                        <span className="truncate text-sm font-medium">{organization.name}</span>
                        <span className="truncate text-xs text-muted-foreground">{organization.slug}</span>
                      </div>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {t("count.members", { count: organization.memberCount })} · {t("count.roles", { count: organization.roleCount })}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            {overview.organizationCount > overview.organizations.length && (
              <Button variant="ghost" size="sm" className="mt-2" render={<Link href="/organizations" />}>
                {t("overview.viewAll", { count: overview.organizationCount })}
              </Button>
            )}
          </FramePanel>
        </Frame>

        <Frame className="lg:col-span-2">
          <FrameHeader>
            <FrameTitle className="flex items-center gap-2">
              <IconHistory className="size-4" /> {t("overview.recentTitle")}
            </FrameTitle>
            <FrameDescription>{t("overview.recentDescription")}</FrameDescription>
          </FrameHeader>
          <FramePanel>
            <ActivityFeed items={overview.recentActivity} showOrganization />
          </FramePanel>
        </Frame>
      </div>
    </>
  );
}
