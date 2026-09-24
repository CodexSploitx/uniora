import { IconArrowRight, IconBuildingSkyscraper } from "@tabler/icons-react";
import Link from "next/link";
import { CreateOrganizationDialog } from "@/components/organizations/create-organization-dialog";
import { ListSearch } from "@/components/shared/list-search";
import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/reui/badge";
import { IconTile } from "@/components/reui/icon-tile";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { getT } from "@/i18n/server";
import { formatDate } from "@/lib/format";
import { getOrganizationsPage } from "@/lib/queries";
import { getDefaultAuthProvider, isReadOnly } from "@/lib/session";

export default async function OrganizationsPage(props: PageProps<"/organizations">) {
  const searchParams = await props.searchParams;
  const q = Array.isArray(searchParams.q) ? searchParams.q[0] : searchParams.q;
  const after = Array.isArray(searchParams.after) ? searchParams.after[0] : searchParams.after;

  const { items: organizations, nextCursor, total } = await getOrganizationsPage({ query: q, cursor: after });
  const { t, locale } = await getT();
  const readOnly = isReadOnly();
  const defaultProvider = getDefaultAuthProvider();
  const searching = Boolean(q);

  const nextHref = (cursor: string) => {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    params.set("after", cursor);
    return `/organizations?${params.toString()}`;
  };

  return (
    <>
      <PageHeader
        title={t("orgs.title")}
        description={t("orgs.description")}
        actions={readOnly ? undefined : <CreateOrganizationDialog defaultProvider={defaultProvider} />}
      />

      {total === 0 && !searching ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <IconBuildingSkyscraper />
            </EmptyMedia>
            <EmptyTitle>{t("orgs.emptyTitle")}</EmptyTitle>
            <EmptyDescription>{t("orgs.emptyDescription")}</EmptyDescription>
          </EmptyHeader>
          {!readOnly && (
            <EmptyContent>
              <CreateOrganizationDialog defaultProvider={defaultProvider} />
            </EmptyContent>
          )}
        </Empty>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <ListSearch
              basePath="/organizations"
              initialQuery={q ?? ""}
              placeholderKey="orgs.searchPlaceholder"
              labelKey="orgs.searchLabel"
              clearKey="orgs.clearSearch"
            />
            <span className="text-sm text-muted-foreground">{t("orgs.resultsCount", { count: total })}</span>
          </div>

          {organizations.length === 0 ? (
            <Empty className="border">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <IconBuildingSkyscraper />
                </EmptyMedia>
                <EmptyTitle>{t("orgs.noMatchesTitle", { query: q ?? "" })}</EmptyTitle>
                <EmptyDescription>{t("orgs.noMatchesDescription")}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <>
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {organizations.map((organization) => (
                  <Link
                    key={organization.id}
                    href={`/organizations/${organization.id}`}
                    className="group flex flex-col gap-4 rounded-xl border bg-card p-5 transition-colors hover:border-primary/40"
                  >
                    <div className="flex items-start gap-3">
                      <IconTile variant="soft">
                        <IconBuildingSkyscraper />
                      </IconTile>
                      <div className="flex min-w-0 flex-col">
                        <span className="truncate font-heading text-base font-semibold group-hover:text-primary">
                          {organization.name}
                        </span>
                        <span className="truncate text-xs text-muted-foreground">{organization.slug}</span>
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      <Badge variant="outline">{t("count.members", { count: organization.memberCount })}</Badge>
                      <Badge variant="outline">{t("count.roles", { count: organization.roleCount })}</Badge>
                      <Badge variant={organization.enabledFeatureCount > 0 ? "info-light" : "outline"}>
                        {t("count.featuresOn", { count: organization.enabledFeatureCount })}
                      </Badge>
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {t("orgs.created", { date: formatDate(organization.createdAt, locale) })}
                    </span>
                  </Link>
                ))}
              </div>

              {nextCursor && (
                <div className="flex justify-center">
                  <Button variant="outline" render={<Link href={nextHref(nextCursor)} />}>
                    {t("orgs.loadMore")} <IconArrowRight />
                  </Button>
                </div>
              )}
            </>
          )}
        </>
      )}
    </>
  );
}
