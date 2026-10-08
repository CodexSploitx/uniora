"use client";

import { IconArrowRight, IconDots, IconPlus, IconTrash, IconUsersGroup } from "@tabler/icons-react";
import Link from "next/link";
import { useState } from "react";
import {
  addTeamMember,
  archiveTeam,
  changeTeamMember,
  createTeam,
  deleteTeam,
  restoreTeam,
  setTeamResponsibility,
} from "@/actions/teams";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { ListSearch } from "@/components/shared/list-search";
import { RoleChip } from "@/components/shared/member-roles";
import { ProviderField } from "@/components/shared/provider-field";
import { useAction } from "@/components/shared/use-action";
import { Badge } from "@/components/reui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useI18n } from "@/i18n/client";
import type { TeamDetailPage } from "@/lib/queries";
import type { TeamMemberRow, TeamRow } from "@/lib/types";

export interface TeamsTabProps {
  organizationId: string;
  /** `/organizations/<id>`: every link below is built from it. */
  orgPath: string;
  readOnly: boolean;
  teams: TeamRow[];
  total: number;
  query: string;
  nextCursor: string | null;
  selectedTeamId: string | null;
  detail: TeamDetailPage | null;
  defaultProvider?: string;
}

function teamsHref(orgPath: string, params: Record<string, string | null | undefined>): string {
  const search = new URLSearchParams({ tab: "teams" });
  for (const [key, value] of Object.entries(params)) if (value) search.set(key, value);
  return `${orgPath}?${search.toString()}`;
}

const MEMBER_VARIANT: Record<TeamMemberRow["status"], "success" | "outline" | "secondary" | "destructive"> = {
  active: "success",
  pending: "outline",
  suspended: "secondary",
  removed: "destructive",
};

/**
 * Teams of one organization, master/detail like Roles: the left list pages through teams, the right panel shows ONE team
 * with its place in the tree and a bounded page of its members. A team is context, not authority: nothing here (or in a
 * parent team) grants permissions. Studio is an operator tool, so these changes use the trusted team storage, audited.
 */
export function TeamsTab(props: TeamsTabProps) {
  const { organizationId, orgPath, readOnly, teams, total, query, nextCursor, selectedTeamId, detail, defaultProvider } = props;
  const { t } = useI18n();

  if (total === 0 && !query) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <IconUsersGroup />
          </EmptyMedia>
          <EmptyTitle>{t("teams.emptyTitle")}</EmptyTitle>
          <EmptyDescription>{t("teams.emptyDescription")}</EmptyDescription>
        </EmptyHeader>
        {!readOnly && <CreateTeamDialog organizationId={organizationId} teams={[]} />}
      </Empty>
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-5">
      <section className="flex flex-col gap-3 lg:col-span-2" aria-label={t("teams.listAria")}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <ListSearch
            basePath={teamsHref(orgPath, { team: selectedTeamId })}
            initialQuery={query}
            placeholderKey="teams.searchPlaceholder"
            labelKey="teams.searchLabel"
            clearKey="teams.clearSearch"
          />
          {!readOnly && <CreateTeamDialog organizationId={organizationId} teams={teams.filter((team) => team.status === "active")} />}
        </div>
        <span className="text-xs text-muted-foreground">{t("teams.resultsCount", { count: total })}</span>

        {teams.length === 0 ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyTitle>{t("teams.noMatchesTitle", { query })}</EmptyTitle>
              <EmptyDescription>{t("teams.noMatchesDescription")}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ul className="flex max-h-[28rem] flex-col divide-y overflow-y-auto rounded-xl border bg-card lg:max-h-[calc(100vh-18rem)]">
            {teams.map((team) => (
              <li key={team.id}>
                <Link
                  href={teamsHref(orgPath, { team: team.id, q: query })}
                  aria-current={team.id === selectedTeamId ? "true" : undefined}
                  className={"flex flex-col gap-1 px-4 py-3 transition-colors " + (team.id === selectedTeamId ? "bg-primary/5" : "hover:bg-muted/50")}
                >
                  <span className="flex items-center gap-1.5 text-sm font-medium">
                    <span className="truncate" title={team.name}>{team.name}</span>
                    {team.status === "archived" && <Badge variant="outline" size="sm">{t("teams.status.archived")}</Badge>}
                  </span>
                  <span className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
                    <code>{team.slug}</code>
                    <span aria-hidden>·</span>
                    <span>{t("teams.members", { count: team.memberCount })}</span>
                    {team.childCount > 0 && (
                      <>
                        <span aria-hidden>·</span>
                        <span>{t("teams.subTeams", { count: team.childCount })}</span>
                      </>
                    )}
                    {team.parent && (
                      <>
                        <span aria-hidden>·</span>
                        <span>{t("teams.under", { team: team.parent.name })}</span>
                      </>
                    )}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}

        {nextCursor && (
          <Button variant="outline" render={<Link href={teamsHref(orgPath, { team: selectedTeamId, q: query, after: nextCursor })} />}>
            {t("teams.loadMore")} <IconArrowRight />
          </Button>
        )}
      </section>

      <section className="lg:sticky lg:top-20 lg:col-span-3 lg:self-start" aria-label={t("teams.detailAria")}>
        {detail ? (
          <TeamDetail organizationId={organizationId} orgPath={orgPath} readOnly={readOnly} detail={detail} defaultProvider={defaultProvider} />
        ) : (
          <Empty className="border">
            <EmptyHeader>
              <EmptyTitle>{t("teams.selectTitle")}</EmptyTitle>
              <EmptyDescription>{t("teams.selectDescription")}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </section>
    </div>
  );
}

function TeamDetail({
  organizationId,
  orgPath,
  readOnly,
  detail,
  defaultProvider,
}: {
  organizationId: string;
  orgPath: string;
  readOnly: boolean;
  detail: TeamDetailPage;
  defaultProvider?: string;
}) {
  const { t } = useI18n();
  const { pending, run } = useAction();
  const { team, ancestors, members, membersTotal, membersNextCursor } = detail;
  const archived = team.status === "archived";

  return (
    <div className="flex flex-col gap-3 rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          {ancestors.length > 0 && (
            <nav aria-label={t("teams.pathAria")} className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
              {ancestors.map((ancestor) => (
                <span key={ancestor.id} className="flex items-center gap-1">
                  <Link href={teamsHref(orgPath, { team: ancestor.id })} className="hover:text-foreground">
                    {ancestor.name}
                  </Link>
                  <span aria-hidden>/</span>
                </span>
              ))}
            </nav>
          )}
          <h3 className="flex items-center gap-1.5 font-heading text-base font-semibold">
            <span className="truncate">{team.name}</span>
            <Badge variant={archived ? "outline" : "success"} size="sm">
              {t(archived ? "teams.status.archived" : "teams.status.active")}
            </Badge>
          </h3>
          <div className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
            <code>{team.slug}</code>
            {team.externalId && (
              <>
                <span aria-hidden>·</span>
                <span>{t("teams.externalId", { id: team.externalId })}</span>
              </>
            )}
            <span aria-hidden>·</span>
            <span>{t("teams.members", { count: team.memberCount })}</span>
            {team.childCount > 0 && (
              <>
                <span aria-hidden>·</span>
                <span>{t("teams.subTeams", { count: team.childCount })}</span>
              </>
            )}
          </div>
        </div>
        {!readOnly && (
          <div className="flex items-center gap-2">
            {!archived && <AddMemberDialog organizationId={organizationId} teamId={team.id} defaultProvider={defaultProvider} />}
            {archived ? (
              <>
                <Button variant="outline" size="sm" disabled={pending} onClick={() => run(() => restoreTeam({ organizationId, teamId: team.id }), { success: t("teams.restored") })}>
                  {t("teams.restore")}
                </Button>
                <ConfirmDialog
                  trigger={
                    <Button variant="ghost" size="icon-sm" aria-label={t("teams.deleteAria", { team: team.name })} disabled={pending}>
                      <IconTrash />
                    </Button>
                  }
                  title={t("teams.deleteTitle", { team: team.name })}
                  description={t("teams.deleteDescription")}
                  confirmLabel={t("teams.deleteConfirm")}
                  pending={pending}
                  onConfirm={() => run(() => deleteTeam({ organizationId, teamId: team.id }), { success: t("teams.deleted") })}
                />
              </>
            ) : (
              <Button variant="outline" size="sm" disabled={pending} onClick={() => run(() => archiveTeam({ organizationId, teamId: team.id }), { success: t("teams.archived") })}>
                {t("teams.archive")}
              </Button>
            )}
          </div>
        )}
      </div>

      <p className="text-xs text-muted-foreground">{t("teams.hierarchyNote")}</p>

      {members.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">{t("teams.noMembers")}</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("teams.colMember")}</TableHead>
              <TableHead>{t("teams.colStatus")}</TableHead>
              <TableHead>{t("teams.colResponsibility")}</TableHead>
              <TableHead>{t("teams.colRoles")}</TableHead>
              {!readOnly && <TableHead className="w-10"><span className="sr-only">{t("teams.colActions")}</span></TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.map((member) => (
              <TableRow key={member.id}>
                <TableCell className="max-w-48 truncate" title={`${member.identity.provider}:${member.identity.subject}`}>
                  <span className="text-xs text-muted-foreground">{member.identity.provider}</span> {member.identity.subject}
                </TableCell>
                <TableCell>
                  <Badge variant={MEMBER_VARIANT[member.status]} size="sm">{t(`teams.memberStatus.${member.status}`)}</Badge>
                </TableCell>
                <TableCell>{t(`teams.responsibility.${member.responsibility}`)}</TableCell>
                <TableCell>
                  <span className="flex flex-wrap gap-1">{member.roles.map((role) => <RoleChip key={role.id} role={role} />)}</span>
                </TableCell>
                {!readOnly && (
                  <TableCell>
                    {member.status !== "removed" && !archived && <MemberActions organizationId={organizationId} member={member} />}
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <span className="text-xs text-muted-foreground">{t("teams.membersShown", { shown: members.length, total: membersTotal })}</span>
      {membersNextCursor && (
        <Button variant="outline" render={<Link href={teamsHref(orgPath, { team: team.id, mafter: membersNextCursor })} />}>
          {t("teams.loadMoreMembers")} <IconArrowRight />
        </Button>
      )}
    </div>
  );
}

function MemberActions({ organizationId, member }: { organizationId: string; member: TeamMemberRow }) {
  const { t } = useI18n();
  const { pending, run } = useAction();
  const label = `${member.identity.provider}:${member.identity.subject}`;
  const change = (change: "remove" | "suspend" | "reactivate", success: string) =>
    run(() => changeTeamMember({ organizationId, teamMembershipId: member.id, change }), { success });
  const setResponsibility = (responsibility: TeamMemberRow["responsibility"]) =>
    run(() => setTeamResponsibility({ organizationId, teamMembershipId: member.id, responsibility }), { success: t("teams.responsibilityChanged") });

  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={t("teams.memberActionsFor", { member: label })} />}>
        <IconDots />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {member.status === "active" && (
          <DropdownMenuItem disabled={pending} onClick={() => change("suspend", t("teams.memberSuspended"))}>{t("teams.suspend")}</DropdownMenuItem>
        )}
        {member.status === "suspended" && (
          <DropdownMenuItem disabled={pending} onClick={() => change("reactivate", t("teams.memberReactivated"))}>{t("teams.reactivate")}</DropdownMenuItem>
        )}
        {member.status !== "pending" && (["owner", "manager", "member"] as const)
          .filter((responsibility) => responsibility !== member.responsibility)
          .map((responsibility) => (
            <DropdownMenuItem key={responsibility} disabled={pending} onClick={() => setResponsibility(responsibility)}>
              {t(`teams.makeResponsibility.${responsibility}`)}
            </DropdownMenuItem>
          ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" disabled={pending} onClick={() => change("remove", t("teams.memberRemoved"))}>
          {t("teams.removeMember")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function AddMemberDialog({ organizationId, teamId, defaultProvider }: { organizationId: string; teamId: string; defaultProvider?: string }) {
  const { pending, run } = useAction();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="outline" size="sm" />}>
        <IconPlus /> {t("teams.addMember")}
      </DialogTrigger>
      <DialogContent>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            run(
              () =>
                addTeamMember({
                  organizationId,
                  teamId,
                  provider: String(form.get("provider") ?? ""),
                  subject: String(form.get("subject") ?? ""),
                }),
              { success: t("teams.memberAdded"), onSuccess: () => setOpen(false) },
            );
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("teams.addMember")}</DialogTitle>
            <DialogDescription>{t("teams.addMemberDescription")}</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <ProviderField id="team-member-provider" name="provider" label={t("members.provider")} defaultValue={defaultProvider} autoFocus={!defaultProvider} />
            <Field>
              <FieldLabel htmlFor="team-member-subject">{t("members.userId")}</FieldLabel>
              <Input id="team-member-subject" name="subject" required maxLength={255} autoFocus={Boolean(defaultProvider)} />
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button type="submit" disabled={pending}>{t("teams.addMember")}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CreateTeamDialog({ organizationId, teams }: { organizationId: string; teams: TeamRow[] }) {
  const { pending, run } = useAction();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button />}>
        <IconPlus /> {t("teams.new")}
      </DialogTrigger>
      <DialogContent>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            run(
              () =>
                createTeam({
                  organizationId,
                  name: String(form.get("name") ?? ""),
                  parentId: String(form.get("parentId") ?? "") || undefined,
                }),
              { success: t("teams.created"), onSuccess: () => setOpen(false) },
            );
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("teams.new")}</DialogTitle>
            <DialogDescription>{t("teams.newDescription")}</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="team-name">{t("teams.name")}</FieldLabel>
              <Input id="team-name" name="name" placeholder="Barcelona" required maxLength={255} autoFocus />
            </Field>
            {teams.length > 0 && (
              <Field>
                <FieldLabel htmlFor="team-parent">{t("teams.parent")}</FieldLabel>
                <select
                  id="team-parent"
                  name="parentId"
                  defaultValue=""
                  className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  <option value="">{t("teams.noParent")}</option>
                  {teams.map((team) => (
                    <option key={team.id} value={team.id}>{team.name}</option>
                  ))}
                </select>
                <FieldDescription>{t("teams.parentHint")}</FieldDescription>
              </Field>
            )}
          </FieldGroup>
          <DialogFooter>
            <Button type="submit" disabled={pending}>{pending ? t("teams.creating") : t("teams.create")}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
