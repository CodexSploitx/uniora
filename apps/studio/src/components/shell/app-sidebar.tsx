"use client";

import {
  IconBuildingSkyscraper,
  IconChevronRight,
  IconHistory,
  IconKey,
  IconLayoutDashboard,
  IconToggleRight,
  IconUsers,
} from "@tabler/icons-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";
import { IconTile } from "@/components/reui/icon-tile";
import { Badge } from "@/components/reui/badge";
import { useI18n } from "@/i18n/client";
import type { MessageKey } from "@/i18n/translate";

interface AppSidebarProps {
  /** Already capped to a handful of rows for the "jump to" shortcut list — never the full table. */
  organizations: { id: string; name: string }[];
  /** Total organization count, independent of how many `organizations` are shown, for the nav badge. */
  organizationsTotal: number;
  readOnly: boolean;
}

const NAV: { href: string; label: MessageKey; icon: typeof IconKey }[] = [
  { href: "/", label: "nav.overview", icon: IconLayoutDashboard },
  { href: "/organizations", label: "nav.organizations", icon: IconBuildingSkyscraper },
  { href: "/members", label: "nav.members", icon: IconUsers },
  { href: "/permissions", label: "nav.permissions", icon: IconKey },
  { href: "/features", label: "nav.features", icon: IconToggleRight },
  { href: "/activity", label: "nav.activity", icon: IconHistory },
];

export function AppSidebar({ organizations, organizationsTotal, readOnly }: AppSidebarProps) {
  const pathname = usePathname();
  const { t } = useI18n();

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" render={<Link href="/" />}>
              <IconTile variant="solid" size="sm">
                <span className="font-heading text-sm font-semibold">U</span>
              </IconTile>
              <div className="grid flex-1 text-left leading-tight">
                <span className="font-heading text-sm font-semibold">UNIORA</span>
                <span className="text-xs text-muted-foreground">Studio</span>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>{t("nav.manage")}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {NAV.map((item) => {
                const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
                return (
                  <SidebarMenuItem key={item.href}>
                    <SidebarMenuButton isActive={active} tooltip={t(item.label)} render={<Link href={item.href} />}>
                      <item.icon />
                      <span>{t(item.label)}</span>
                    </SidebarMenuButton>
                    {item.href === "/organizations" && organizationsTotal > 0 && (
                      <SidebarMenuBadge>{organizationsTotal}</SidebarMenuBadge>
                    )}
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {organizations.length > 0 && (
          <SidebarGroup className="group-data-[collapsible=icon]:hidden">
            <SidebarGroupLabel>{t("nav.jumpTo")}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {organizations.slice(0, 12).map((organization) => {
                  const href = `/organizations/${organization.id}`;
                  return (
                    <SidebarMenuItem key={organization.id}>
                      <SidebarMenuButton size="sm" isActive={pathname === href} render={<Link href={href} />}>
                        <IconChevronRight />
                        <span className="truncate">{organization.name}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}
      </SidebarContent>

      <SidebarFooter className="group-data-[collapsible=icon]:hidden">
        <div className="flex flex-col gap-2 rounded-lg border bg-sidebar-accent/40 p-3 text-xs text-muted-foreground">
          <div className="flex items-center gap-2">
            <span className="size-2 rounded-full bg-success" />
            <span className="font-medium text-foreground">{t("nav.localDatabase")}</span>
          </div>
          <p>{t("nav.dataStaysLocal")}</p>
          {readOnly && <Badge variant="warning-light">{t("nav.readOnlyMode")}</Badge>}
        </div>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
