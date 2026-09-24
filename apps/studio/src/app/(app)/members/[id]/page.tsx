import { IconArrowRight, IconBuildingSkyscraper, IconKey, IconShieldLock, IconToggleRight, IconUser } from "@tabler/icons-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ListSearch } from "@/components/shared/list-search";
import { RoleChip } from "@/components/shared/member-roles";
import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/reui/badge";
import { IconTile } from "@/components/reui/icon-tile";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { getT } from "@/i18n/server";
import {
  getMemberFeaturesPage,
  getMemberHeader,
  getMemberPermissionsPage,
  getMemberRolesPage,
} from "@/lib/queries";
import type { MemberHeader } from "@/lib/types";

const TABS = ["roles", "permissions", "features"] as const;
type Tab = (typeof TABS)[number];

const param = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value);

function memberHref(id: string, tab: Tab, params: Record<string, string | null | undefined> = {}): string {
  const search = new URLSearchParams({ tab });
  for (const [key, value] of Object.entries(params)) if (value) search.set(key, value);
  return `/members/${id}?${search.toString()}`;
}

export default async function MemberPage(props: PageProps<"/members/[id]">) {
  const { id } = await props.params;
  const searchParams = await props.searchParams;
  const header = await getMemberHeader(id);
  const { t } = await getT();
  if (!header) notFound();

  const rawTab = param(searchParams.tab);
  const tab: Tab = (TABS as readonly string[]).includes(rawTab ?? "") ? (rawTab as Tab) : "roles";
  const q = param(searchParams.q) ?? "";
  const after = param(searchParams.after);

  return (
    <>
      <PageHeader
        title={header.identity.subject}
        crumbs={[{ label: t("nav.members"), href: "/members" }, { label: header.identity.subject }]}
        leading={
          <IconTile variant="soft" size="lg">
            <IconUser />
          </IconTile>
        }
        description={t("members.via", { provider: header.identity.provider })}
        actions={
          <Button
            variant="outline"
            size="sm"
            render={<Link href={`/organizations/${header.organization.id}?tab=members&q=${encodeURIComponent(header.identity.subject)}`} />}
          >
            {t("memberDetail.manage")} <IconArrowRight />
          </Button>
        }
      />

      <Summary header={header} />

      <nav aria-label={t("memberDetail.tabsAria")} className="inline-flex w-fit max-w-full items-center gap-1 overflow-x-auto rounded-lg bg-muted p-1">
        {TABS.map((item) => (
          <Link
            key={item}
            href={memberHref(id, item)}
            aria-current={item === tab ? "page" : undefined}
            className={
              "rounded-md px-3 py-1 text-sm font-medium whitespace-nowrap transition-colors " +
              (item === tab ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")
            }
          >
            {item === "roles" && t("memberDetail.tabRoles", { count: header.roleCount })}
            {item === "permissions" &&
              (header.isOwner ? t("memberDetail.tabPermissionsAll") : t("memberDetail.tabPermissions", { count: header.permissionCount }))}
            {item === "features" && t("memberDetail.tabFeatures", { count: header.featureCount })}
          </Link>
        ))}
      </nav>

      {tab === "roles" && <RolesSection header={header} q={q} after={after} />}
      {tab === "permissions" && <PermissionsSection header={header} q={q} after={after} />}
      {tab === "features" && <FeaturesSection header={header} q={q} after={after} />}
    </>
  );
}

async function Summary({ header }: { header: MemberHeader }) {
  const { t } = await getT();
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <div className="flex flex-col gap-2 rounded-xl border bg-card p-4 lg:col-span-2">
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <IconBuildingSkyscraper className="size-3.5" /> {t("memberDetail.organization")}
        </span>
        <Link href={`/organizations/${header.organization.id}`} className="font-heading text-lg font-semibold hover:text-primary">
          {header.organization.name}
        </Link>
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          {header.isOwner && (
            <Badge variant="primary-light" size="sm">
              <IconShieldLock /> {t("common.owner")}
            </Badge>
          )}
          {header.otherOrganizationsTotal > 0 && (
            <>
              <span>{t("memberDetail.alsoIn")}</span>
              {header.otherOrganizations.map((other) => (
                <Link key={other.membershipId} href={`/members/${other.membershipId}`} className="underline-offset-4 hover:text-primary hover:underline">
                  {other.organization.name}
                </Link>
              ))}
              {header.otherOrganizationsTotal > header.otherOrganizations.length && (
                <span>{t("feats.moreOrgs", { count: header.otherOrganizationsTotal - header.otherOrganizations.length })}</span>
              )}
            </>
          )}
        </div>
      </div>
      <Stat icon={<IconShieldLock className="size-3.5" />} label={t("memberDetail.statRoles")} value={String(header.roleCount)} />
      <Stat
        icon={<IconKey className="size-3.5" />}
        label={t("memberDetail.statPermissions")}
        value={header.isOwner ? t("memberDetail.fullAccess") : String(header.permissionCount)}
      />
    </div>
  );
}

function Stat({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex flex-col gap-2 rounded-xl border bg-card p-4">
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {icon} {label}
      </span>
      <span className="font-heading text-2xl font-semibold tabular-nums">{value}</span>
    </div>
  );
}

function LoadMore({ href, label }: { href: string; label: string }) {
  return (
    <div className="flex justify-center">
      <Button variant="outline" render={<Link href={href} />}>
        {label} <IconArrowRight />
      </Button>
    </div>
  );
}

interface SectionProps {
  header: MemberHeader;
  q: string;
  after?: string;
}

async function RolesSection({ header, q, after }: SectionProps) {
  const { t } = await getT();
  const page = await getMemberRolesPage(header.organization.id, header.id, { query: q, cursor: after });

  if (page.total === 0 && !q) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <IconShieldLock />
          </EmptyMedia>
          <EmptyTitle>{t("memberDetail.rolesEmptyTitle")}</EmptyTitle>
          <EmptyDescription>{t("memberDetail.rolesEmptyDescription")}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ListSearch
          basePath={memberHref(header.id, "roles")}
          initialQuery={q}
          placeholderKey="roles.searchPlaceholder"
          labelKey="roles.searchLabel"
          clearKey="roles.clearSearch"
        />
        <span className="text-sm text-muted-foreground">{t("roles.resultsCount", { count: page.total })}</span>
      </div>
      {page.items.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">{t("roles.noMatchesTitle", { query: q })}</p>
      ) : (
        <ul className="flex flex-col divide-y overflow-hidden rounded-xl border bg-card">
          {page.items.map((role) => (
            <li key={role.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
              <div className="flex min-w-0 flex-col gap-0.5">
                <RoleChip role={{ id: role.id, name: role.name, isOwnerRole: role.isOwnerRole }} />
                <code className="text-xs text-muted-foreground">{role.key}</code>
              </div>
              <span className="text-xs text-muted-foreground">
                {role.isOwnerRole ? t("roles.fullAccess") : t("roles.permissionsCount", { count: role.permissionCount })} ·{" "}
                {t("roles.members", { count: role.memberCount })}
              </span>
            </li>
          ))}
        </ul>
      )}
      {page.nextCursor && <LoadMore href={memberHref(header.id, "roles", { q, after: page.nextCursor })} label={t("roles.loadMore")} />}
    </div>
  );
}

async function PermissionsSection({ header, q, after }: SectionProps) {
  const { t } = await getT();

  if (header.isOwner) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <IconShieldLock />
          </EmptyMedia>
          <EmptyTitle>{t("memberDetail.ownerPermissionsTitle")}</EmptyTitle>
          <EmptyDescription>{t("memberDetail.ownerPermissionsDescription", { count: header.permissionCount })}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  const page = await getMemberPermissionsPage(header.id, { query: q, cursor: after });

  if (page.total === 0 && !q) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <IconKey />
          </EmptyMedia>
          <EmptyTitle>{t("memberDetail.permissionsEmptyTitle")}</EmptyTitle>
          <EmptyDescription>{t("memberDetail.permissionsEmptyDescription")}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ListSearch
          basePath={memberHref(header.id, "permissions")}
          initialQuery={q}
          placeholderKey="roles.permSearchPlaceholder"
          labelKey="roles.permSearchLabel"
          clearKey="roles.clearSearch"
        />
        <span className="text-sm text-muted-foreground">{t("perms.resultsCount", { count: page.total })}</span>
      </div>
      {page.items.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">{t("roles.permNoMatches")}</p>
      ) : (
        <ul className="flex flex-col divide-y overflow-hidden rounded-xl border bg-card">
          {page.items.map((permission) => (
            <li key={permission.key} className="flex flex-col gap-1.5 px-4 py-3">
              <div className="flex flex-col">
                <code className="text-xs font-medium">{permission.key}</code>
                {(permission.name || permission.description) && (
                  <span className="text-xs text-muted-foreground">{permission.name ?? permission.description}</span>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                <span>{t("memberDetail.grantedVia")}</span>
                {permission.via.roles.map((role) => (
                  <RoleChip key={role.id} role={role} />
                ))}
                {permission.via.total > permission.via.roles.length && (
                  <span>{t("feats.moreOrgs", { count: permission.via.total - permission.via.roles.length })}</span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {page.nextCursor && (
        <LoadMore href={memberHref(header.id, "permissions", { q, after: page.nextCursor })} label={t("roles.loadMore")} />
      )}
    </div>
  );
}

async function FeaturesSection({ header, q, after }: SectionProps) {
  const { t } = await getT();
  const page = await getMemberFeaturesPage(header.organization.id, { query: q, cursor: after });

  if (page.total === 0 && !q) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <IconToggleRight />
          </EmptyMedia>
          <EmptyTitle>{t("memberDetail.featuresEmptyTitle")}</EmptyTitle>
          <EmptyDescription>{t("memberDetail.featuresEmptyDescription", { org: header.organization.name })}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">{t("memberDetail.featuresNote", { org: header.organization.name })}</p>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ListSearch
          basePath={memberHref(header.id, "features")}
          initialQuery={q}
          placeholderKey="feats.searchPlaceholder"
          labelKey="feats.searchLabel"
          clearKey="feats.clearSearch"
        />
        <span className="text-sm text-muted-foreground">{t("feats.resultsCount", { count: page.total })}</span>
      </div>
      {page.items.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">{t("feats.noMatchesTitle", { query: q })}</p>
      ) : (
        <ul className="flex flex-col divide-y overflow-hidden rounded-xl border bg-card">
          {page.items.map((feature) => (
            <li key={feature.key} className="flex items-center justify-between gap-4 px-4 py-3">
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="text-sm font-medium">{feature.name}</span>
                <code className="text-xs text-muted-foreground">{feature.key}</code>
                {feature.description && <span className="text-xs text-muted-foreground">{feature.description}</span>}
              </div>
              <Badge variant="success-light">{t("memberDetail.featureOn")}</Badge>
            </li>
          ))}
        </ul>
      )}
      {page.nextCursor && (
        <LoadMore href={memberHref(header.id, "features", { q, after: page.nextCursor })} label={t("feats.loadMore")} />
      )}
    </div>
  );
}
