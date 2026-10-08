import { IconArrowRight, IconShieldLock } from "@tabler/icons-react";
import Link from "next/link";
import { Badge } from "@/components/reui/badge";
import { StatusFilter } from "@/components/shared/status";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getT } from "@/i18n/server";
import { formatDate } from "@/lib/format";
import { capParams } from "@/lib/limits";
import { getPlatformPage } from "@/lib/queries";

export default async function PlatformPage(props: PageProps<"/platform">) {
  const searchParams = await props.searchParams;
  const after = Array.isArray(searchParams.after) ? searchParams.after[0] : searchParams.after;
  const rawStatus = Array.isArray(searchParams.status) ? searchParams.status[0] : searchParams.status;
  const status = rawStatus === "active" || rawStatus === "suspended" ? rawStatus : undefined;

  const page = await getPlatformPage({ cursor: after, status });
  const { t, locale } = await getT();

  return (
    <>
      <PageHeader title={t("platform.title")} description={t("platform.description")} />

      {!page.available ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <IconShieldLock />
            </EmptyMedia>
            <EmptyTitle>{t("platform.unavailableTitle")}</EmptyTitle>
            <EmptyDescription>{t("platform.unavailableDescription")}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="grid min-w-0 gap-6">
          <section className="flex min-w-0 flex-col gap-3" aria-labelledby="platform-members">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 id="platform-members" className="font-heading text-base font-semibold">
                {t("platform.members")}
              </h2>
              <span className="text-sm text-muted-foreground">{t("platform.membersCount", capParams(page.membersTotal))}</span>
            </div>
            <StatusFilter basePath="/platform" current={status} values={["active", "suspended"]} />
            {page.members.length === 0 ? (
              <Empty className="border">
                <EmptyHeader>
                  <EmptyTitle>{t("platform.noMembersTitle")}</EmptyTitle>
                  <EmptyDescription>{t("platform.noMembersDescription")}</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <div className="overflow-hidden rounded-xl border bg-card">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("members.identity")}</TableHead>
                      <TableHead>{t("members.roles")}</TableHead>
                      <TableHead>{t("members.status")}</TableHead>
                      <TableHead>{t("platform.since")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {page.members.map((member) => (
                      <TableRow key={member.id}>
                        <TableCell>
                          <div className="flex flex-col">
                            <span className="font-medium">{member.identity.subject}</span>
                            <span className="text-xs text-muted-foreground">{t("members.via", { provider: member.identity.provider })}</span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-1.5">
                            {member.roles.map((role) => (
                              <Badge key={role.id} variant={role.isSystem ? "info-light" : "outline"}>
                                {role.name}
                              </Badge>
                            ))}
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge variant={member.status === "active" ? "success-light" : "warning-light"} title={member.statusReason}>
                            {t(`status.${member.status}`)}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">{formatDate(member.createdAt, locale)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
            {page.membersNextCursor && (
              <div className="flex justify-center">
                <Button
                  variant="outline"
                  render={<Link href={`/platform?${new URLSearchParams({ ...(status ? { status } : {}), after: page.membersNextCursor }).toString()}`} />}
                >
                  {t("members.loadMore")} <IconArrowRight />
                </Button>
              </div>
            )}
          </section>

          <section className="flex min-w-0 flex-col gap-3" aria-labelledby="platform-roles">
            <h2 id="platform-roles" className="font-heading text-base font-semibold">
              {t("platform.roles")}
            </h2>
            <div className="grid gap-3 sm:grid-cols-2">
              {page.roles.map((role) => (
                <div key={role.id} className="flex flex-col gap-2 rounded-xl border bg-card p-4">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{role.name}</span>
                    {role.isSystem && <Badge variant="info-light">{t("platform.system")}</Badge>}
                  </div>
                  <code className="text-xs text-muted-foreground">{role.key}</code>
                  {role.description && <p className="text-sm text-muted-foreground">{role.description}</p>}
                  <p className="text-xs text-muted-foreground">{t("platform.permissionsCount", { count: role.permissions.length })}</p>
                </div>
              ))}
            </div>
            {page.rolesTruncated && <p className="text-xs text-muted-foreground">{t("platform.rolesTruncated")}</p>}
          </section>

          <p className="text-xs text-muted-foreground">{t("platform.readOnlyNote")}</p>
        </div>
      )}
    </>
  );
}
