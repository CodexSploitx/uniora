"use client";

import { capParams } from "@/lib/limits";
import { IconArrowRight, IconTrash, IconUserPlus, IconX } from "@tabler/icons-react";
import Link from "next/link";
import { useState } from "react";
import { addMember, assignMemberRole, removeMember, unassignMemberRole } from "@/actions/memberships";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { ListSearch } from "@/components/shared/list-search";
import { MemberRolesPopover, RoleChip } from "@/components/shared/member-roles";
import { RolePicker } from "@/components/shared/role-picker";
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
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { ProviderField } from "@/components/shared/provider-field";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { MemberStatusMenu } from "@/components/organizations/member-status-menu";
import { StatusBadge, StatusFilter } from "@/components/shared/status";
import { useI18n } from "@/i18n/client";
import { timeAgo } from "@/lib/format";
import type { MemberRow, RoleRef } from "@/lib/types";

/** The members tab link with the search kept and the status dropped (the chips add it back). */
const statusPath = (basePath: string, query: string) => (query ? `${basePath}&q=${encodeURIComponent(query)}` : basePath);

interface MembersTableProps {
  defaultProvider?: string;
  organizationId: string;
  members: MemberRow[];
  total: number;
  query: string;
  status?: string;
  /** Path (with `?tab=members`) the search box writes `q` to. */
  basePath: string;
  nextHref: string | null;
  ownerRoleId?: string;
  ownerCount: number;
  readOnly: boolean;
}

export function MembersTable({
  organizationId,
  members,
  total,
  query,
  status,
  basePath,
  nextHref,
  ownerRoleId,
  ownerCount,
  readOnly,
  defaultProvider,
}: MembersTableProps) {
  const { pending, run } = useAction();
  const { t, locale } = useI18n();

  if (total === 0 && !query && !status) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <IconUserPlus />
          </EmptyMedia>
          <EmptyTitle>{t("members.emptyTitle")}</EmptyTitle>
          <EmptyDescription>{t("members.emptyDescription")}</EmptyDescription>
        </EmptyHeader>
        {!readOnly && <AddMemberDialog organizationId={organizationId} defaultProvider={defaultProvider} />}
      </Empty>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <StatusFilter basePath={statusPath(basePath, query)} current={status} values={["active", "suspended", "blocked"]} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ListSearch
          basePath={status ? `${basePath}&status=${status}` : basePath}
          initialQuery={query}
          placeholderKey="members.searchPlaceholder"
          labelKey="members.searchLabel"
          clearKey="members.clearSearch"
        />
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground">{t("members.resultsCount", capParams(total))}</span>
          {!readOnly && <AddMemberDialog organizationId={organizationId} defaultProvider={defaultProvider} />}
        </div>
      </div>

      {members.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <IconUserPlus />
            </EmptyMedia>
            <EmptyTitle>{query ? t("members.noMatchesTitle", { query }) : t("members.noneWithStatus")}</EmptyTitle>
            <EmptyDescription>{query ? t("members.noMatchesDescription") : t("members.noneWithStatusHint")}</EmptyDescription>
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
                {!readOnly && <TableHead className="w-28 text-right">{t("members.actions")}</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {members.map((member) => {
                const isLastOwner =
                  Boolean(ownerRoleId) && member.roles.some((role) => role.id === ownerRoleId) && ownerCount === 1;
                return (
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
                      <div className="flex flex-wrap items-center gap-1.5">
                        {member.roleCount === 0 && <span className="text-xs text-muted-foreground">{t("members.noRole")}</span>}
                        {member.roles.map((role) => (
                          <RoleChip
                            key={role.id}
                            role={role}
                            removeLabel={t("members.removeRoleAria", { role: role.name, member: member.identity.subject })}
                            onRemove={
                              readOnly || pending || (role.isOwnerRole && isLastOwner)
                                ? undefined
                                : () =>
                                    run(
                                      () => unassignMemberRole({ organizationId, membershipId: member.id, roleId: role.id }),
                                      { success: t("members.removedRole", { role: role.name }) },
                                    )
                            }
                          />
                        ))}
                        {member.roleCount > member.roles.length && (
                          <MemberRolesPopover
                            organizationId={organizationId}
                            membershipId={member.id}
                            memberLabel={member.identity.subject}
                            hiddenCount={member.roleCount - member.roles.length}
                            readOnly={readOnly}
                            protectOwnerRole={isLastOwner}
                          />
                        )}
                        {!readOnly && (
                          <RolePicker
                            organizationId={organizationId}
                            notHeldBy={member.id}
                            disabled={pending}
                            onPick={(role: RoleRef) =>
                              run(() => assignMemberRole({ organizationId, membershipId: member.id, roleId: role.id }), {
                                success: t("members.assignedRole", { role: role.name }),
                              })
                            }
                          />
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col items-start gap-0.5">
                        <StatusBadge status={member.status} />
                        <span className="text-xs text-muted-foreground">
                          {member.lastActiveAt ? t("status.lastActive", { when: timeAgo(member.lastActiveAt, locale, t) }) : t("status.neverActive")}
                        </span>
                      </div>
                    </TableCell>
                    {!readOnly && (
                      <TableCell className="text-right">
                        {isLastOwner ? (
                          <span className="text-xs text-muted-foreground" title={t("members.lastOwnerHint")}>
                            {t("members.lastOwner")}
                          </span>
                        ) : (
                          <div className="flex items-center justify-end gap-0.5">
                          <MemberStatusMenu organizationId={organizationId} member={member} disabled={pending} />
                          <ConfirmDialog
                            trigger={
                              <Button variant="ghost" size="icon-sm" aria-label={t("members.removeAria", { member: member.identity.subject })} disabled={pending}>
                                <IconTrash />
                              </Button>
                            }
                            title={t("members.removeTitle")}
                            description={t("members.removeDescription", { member: member.identity.subject })}
                            confirmLabel={t("members.removeConfirm")}
                            pending={pending}
                            onConfirm={() =>
                              run(() => removeMember({ organizationId, membershipId: member.id }), { success: t("members.removed") })
                            }
                          />
                          </div>
                        )}
                      </TableCell>
                    )}
                  </TableRow>
                );
              })}
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
  );
}

function AddMemberDialog({ organizationId, defaultProvider }: { organizationId: string; defaultProvider?: string }) {
  const { pending, run } = useAction();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [role, setRole] = useState<RoleRef | null>(null);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button />}>
        <IconUserPlus /> {t("members.add")}
      </DialogTrigger>
      <DialogContent>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            run(
              () =>
                addMember({
                  organizationId,
                  provider: String(form.get("provider") ?? ""),
                  subject: String(form.get("subject") ?? ""),
                  roleId: role?.id,
                }),
              {
                success: t("members.added"),
                onSuccess: () => {
                  setOpen(false);
                  setRole(null);
                },
              },
            );
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("members.add")}</DialogTitle>
            <DialogDescription>{t("members.addDescription")}</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <ProviderField
              id="member-provider"
              name="provider"
              label={t("members.provider")}
              defaultValue={defaultProvider}
              autoFocus={!defaultProvider}
            />
            <Field>
              <FieldLabel htmlFor="member-subject">{t("members.userId")}</FieldLabel>
              <Input
                id="member-subject"
                name="subject"
                placeholder="user id"
                required
                maxLength={255}
                autoFocus={Boolean(defaultProvider)}
              />
            </Field>
            <Field>
              <FieldLabel>{t("members.initialRole")}</FieldLabel>
              <div className="flex items-center gap-2">
                <RolePicker
                  organizationId={organizationId}
                  variant="outline"
                  label={role ? t("members.changeRole") : t("members.pickRole")}
                  onPick={setRole}
                />
                {role ? (
                  <Badge variant="outline" size="lg">
                    {role.name}
                    <button type="button" aria-label={t("members.clearRole")} className="-mr-0.5 opacity-60 hover:opacity-100" onClick={() => setRole(null)}>
                      <IconX />
                    </button>
                  </Badge>
                ) : (
                  <span className="text-xs text-muted-foreground">{t("members.noRoleYet")}</span>
                )}
              </div>
              <FieldDescription>{t("members.noRoleHint")}</FieldDescription>
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? t("members.adding") : t("members.add")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
