import { IconArrowRight, IconBuildingSkyscraper } from "@tabler/icons-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { MembersTable } from "@/components/organizations/members-table";
import { OrgFeaturesList } from "@/components/organizations/org-features-list";
import { OrgTabs, parseOrgTab } from "@/components/organizations/org-tabs";
import { RolesTab } from "@/components/organizations/roles-tab";
import { ActivityFeed } from "@/components/shared/activity-feed";
import { CopyButton } from "@/components/shared/copy-button";
import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/reui/badge";
import { IconTile } from "@/components/reui/icon-tile";
import { Button } from "@/components/ui/button";
import { formatDate } from "@/lib/format";
import { getT } from "@/i18n/server";
import {
  getOrgActivityPage,
  getOrgFeaturesPage,
  getOrgHeader,
  getOrgMembersPage,
  getOrgRolesPage,
  getRolePermissionsPage,
} from "@/lib/queries";
import { getDefaultAuthProvider, isReadOnly } from "@/lib/session";

/** Reads one query-string value (the first, if repeated) as a plain string. */
const param = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value);

/** Builds `/organizations/<id>?tab=…&…` dropping empty values. */
function tabHref(orgPath: string, tab: string, params: Record<string, string | null | undefined>): string {
  const search = new URLSearchParams({ tab });
  for (const [key, value] of Object.entries(params)) if (value) search.set(key, value);
  return `${orgPath}?${search.toString()}`;
}

export default async function OrganizationPage(props: PageProps<"/organizations/[id]">) {
  const { id } = await props.params;
  const searchParams = await props.searchParams;
  const header = await getOrgHeader(id);
  const { t, locale } = await getT();
  if (!header) notFound();

  const readOnly = isReadOnly();
  const { organization } = header;
  const orgPath = `/organizations/${organization.id}`;
  const tab = parseOrgTab(param(searchParams.tab));
  const q = param(searchParams.q) ?? "";
  const after = param(searchParams.after);

  return (
    <>
      <PageHeader
        title={organization.name}
        crumbs={[{ label: t("nav.organizations"), href: "/organizations" }, { label: organization.name }]}
        leading={
          <IconTile variant="soft" size="lg">
            <IconBuildingSkyscraper />
          </IconTile>
        }
        description={t("orgs.created", { date: formatDate(organization.createdAt, locale) })}
        actions={
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Badge variant="outline">{organization.slug}</Badge>
            <span className="hidden font-mono sm:inline">{organization.id}</span>
            <CopyButton value={organization.id} label={t("orgs.copyId")} />
          </div>
        }
      />

      <OrgTabs organizationId={organization.id} active={tab} header={header} />

      {tab === "members" && (
        <MembersTab organizationId={organization.id} orgPath={orgPath} q={q} after={after} readOnly={readOnly} />
      )}
      {tab === "roles" && (
        <RolesSection
          organizationId={organization.id}
          orgPath={orgPath}
          readOnly={readOnly}
          q={q}
          after={after}
          roleId={param(searchParams.role)}
          permissionQuery={param(searchParams.pq) ?? ""}
          permissionAfter={param(searchParams.pafter)}
          grantedOnly={param(searchParams.pshow) === "granted"}
        />
      )}
      {tab === "features" && (
        <FeaturesSection
          organizationId={organization.id}
          orgPath={orgPath}
          readOnly={readOnly}
          q={q}
          after={after}
          enabledOnly={param(searchParams.show) === "enabled"}
        />
      )}
      {tab === "activity" && (
        <ActivitySection organizationId={organization.id} organizationName={organization.name} orgPath={orgPath} after={after} />
      )}
    </>
  );
}

async function MembersTab({ organizationId, orgPath, q, after, readOnly }: { organizationId: string; orgPath: string; q: string; after?: string; readOnly: boolean }) {
  const page = await getOrgMembersPage(organizationId, { query: q, cursor: after });
  return (
    <MembersTable
      organizationId={organizationId}
      members={page.items}
      total={page.total}
      query={q}
      basePath={tabHref(orgPath, "members", {})}
      nextHref={page.nextCursor ? tabHref(orgPath, "members", { q, after: page.nextCursor }) : null}
      ownerRoleId={page.ownerRoleId}
      ownerCount={page.ownerCount}
      readOnly={readOnly}
      defaultProvider={getDefaultAuthProvider()}
    />
  );
}

async function RolesSection(props: {
  organizationId: string;
  orgPath: string;
  readOnly: boolean;
  q: string;
  after?: string;
  roleId?: string;
  permissionQuery: string;
  permissionAfter?: string;
  grantedOnly: boolean;
}) {
  const roles = await getOrgRolesPage(props.organizationId, { query: props.q, cursor: props.after });
  // No role chosen yet -> show the first one, so the panel is never empty when roles exist.
  const selectedRoleId = props.roleId ?? roles.items[0]?.id ?? null;
  const detail = selectedRoleId
    ? await getRolePermissionsPage(props.organizationId, selectedRoleId, {
        query: props.permissionQuery,
        cursor: props.permissionAfter,
        grantedOnly: props.grantedOnly,
      })
    : null;

  return (
    <RolesTab
      organizationId={props.organizationId}
      orgPath={props.orgPath}
      readOnly={props.readOnly}
      roles={roles.items}
      rolesTotal={roles.total}
      rolesQuery={props.q}
      rolesNextCursor={roles.nextCursor}
      selectedRoleId={detail ? selectedRoleId : null}
      selected={
        detail
          ? {
              role: detail.role,
              permissions: detail.items,
              total: detail.total,
              query: props.permissionQuery,
              grantedOnly: props.grantedOnly,
              nextCursor: detail.nextCursor,
            }
          : null
      }
    />
  );
}

async function FeaturesSection(props: { organizationId: string; orgPath: string; readOnly: boolean; q: string; after?: string; enabledOnly: boolean }) {
  const page = await getOrgFeaturesPage(props.organizationId, { query: props.q, cursor: props.after, enabledOnly: props.enabledOnly });
  return (
    <OrgFeaturesList
      organizationId={props.organizationId}
      orgPath={props.orgPath}
      features={page.items}
      total={page.total}
      query={props.q}
      enabledOnly={props.enabledOnly}
      nextCursor={page.nextCursor}
      readOnly={props.readOnly}
    />
  );
}

async function ActivitySection({ organizationId, organizationName, orgPath, after }: { organizationId: string; organizationName: string; orgPath: string; after?: string }) {
  const { t } = await getT();
  const page = await getOrgActivityPage(organizationId, organizationName, after);
  return (
    <>
      <div className="rounded-xl border bg-card p-5">
        <ActivityFeed items={page.items} />
      </div>
      {page.nextCursor && (
        <div className="flex justify-center">
          <Button variant="outline" render={<Link href={tabHref(orgPath, "activity", { after: page.nextCursor })} />}>
            {t("activity.loadOlder")} <IconArrowRight />
          </Button>
        </div>
      )}
    </>
  );
}
