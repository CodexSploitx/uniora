import { IconArrowRight, IconUsers } from "@tabler/icons-react";
import Link from "next/link";
import { ListSearch } from "@/components/shared/list-search";
import { MemberRolesPopover, RoleChip } from "@/components/shared/member-roles";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getT } from "@/i18n/server";
import { getMembersPage } from "@/lib/queries";

export default async function MembersPage(props: PageProps<"/members">) {
  const searchParams = await props.searchParams;
  const q = Array.isArray(searchParams.q) ? searchParams.q[0] : searchParams.q;
  const after = Array.isArray(searchParams.after) ? searchParams.after[0] : searchParams.after;

  const { items, nextCursor, total } = await getMembersPage({ query: q, cursor: after });
  const { t } = await getT();

  let nextHref: string | null = null;
  if (nextCursor) {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    params.set("after", nextCursor);
    nextHref = `/members?${params.toString()}`;
  }

  return (
    <>
      <PageHeader title={t("membersPage.title")} description={t("membersPage.description")} crumbs={[{ label: t("nav.members") }]} />

      {total === 0 && !q ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <IconUsers />
            </EmptyMedia>
            <EmptyTitle>{t("membersPage.emptyTitle")}</EmptyTitle>
            <EmptyDescription>{t("membersPage.emptyDescription")}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <ListSearch
              basePath="/members"
              initialQuery={q ?? ""}
              placeholderKey="members.searchPlaceholder"
              labelKey="members.searchLabel"
              clearKey="members.clearSearch"
            />
            <span className="text-sm text-muted-foreground">{t("members.resultsCount", { count: total })}</span>
          </div>

          {items.length === 0 ? (
            <Empty className="border">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <IconUsers />
                </EmptyMedia>
                <EmptyTitle>{t("members.noMatchesTitle", { query: q ?? "" })}</EmptyTitle>
                <EmptyDescription>{t("members.noMatchesDescription")}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="overflow-hidden rounded-xl border bg-card">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("members.identity")}</TableHead>
                    <TableHead>{t("membersPage.organization")}</TableHead>
                    <TableHead>{t("members.roles")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((member) => (
                    <TableRow key={member.id}>
                      <TableCell>
                        <div className="flex flex-col">
                          <Link href={`/members/${member.id}`} className="font-medium underline-offset-4 hover:text-primary hover:underline">
                            {member.identity.subject}
                          </Link>
                          <span className="text-xs text-muted-foreground">{t("members.via", { provider: member.identity.provider })}</span>
                        </div>
                      </TableCell>
                      <TableCell>
                        {member.organization ? (
                          <Link
                            href={`/organizations/${member.organization.id}?tab=members`}
                            className="text-sm underline-offset-4 hover:underline"
                          >
                            {member.organization.name}
                          </Link>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap items-center gap-1.5">
                          {member.roleCount === 0 && <span className="text-xs text-muted-foreground">{t("members.noRole")}</span>}
                          {member.roles.map((role) => (
                            <RoleChip key={role.id} role={role} />
                          ))}
                          {member.organization && member.roleCount > member.roles.length && (
                            <MemberRolesPopover
                              organizationId={member.organization.id}
                              membershipId={member.id}
                              memberLabel={member.identity.subject}
                              hiddenCount={member.roleCount - member.roles.length}
                              readOnly
                              protectOwnerRole={false}
                            />
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

          {nextHref && (
            <div className="flex justify-center">
              <Button variant="outline" render={<Link href={nextHref} />}>
                {t("members.loadMore")} <IconArrowRight />
              </Button>
            </div>
          )}
        </div>
      )}
    </>
  );
}
