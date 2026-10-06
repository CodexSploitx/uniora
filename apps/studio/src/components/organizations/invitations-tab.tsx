"use client";

import { IconArrowRight, IconMailPlus, IconRefresh, IconX } from "@tabler/icons-react";
import Link from "next/link";
import { useState } from "react";
import { inviteMember, resendInvitation, revokeInvitation, type InviteOutcome } from "@/actions/invitations";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { CopyButton } from "@/components/shared/copy-button";
import { RoleChip } from "@/components/shared/member-roles";
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
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useI18n } from "@/i18n/client";
import { formatDate } from "@/lib/format";
import type { InvitationRow, InvitationViewStatus, RoleRef } from "@/lib/types";

export type InvitationMailKey = "invitations.mailSending" | "invitations.mailNoSmtp" | "invitations.mailPackageMissing" | "invitations.mailInvalid";

interface InvitationsTabProps {
  organizationId: string;
  invitations: InvitationRow[];
  nextHref: string | null;
  readOnly: boolean;
  /** `false` when `UNIORA_INVITE_URL` is missing: Studio can list invitations but not create them. */
  inviteConfigured: boolean;
  mailKey: InvitationMailKey;
}

const STATUS_VARIANT: Record<InvitationViewStatus, "success" | "outline" | "secondary" | "destructive"> = {
  pending: "success",
  accepted: "secondary",
  revoked: "destructive",
  expired: "outline",
};

export function InvitationsTab({ organizationId, invitations, nextHref, readOnly, inviteConfigured, mailKey }: InvitationsTabProps) {
  const { t, locale } = useI18n();
  const { pending, run } = useAction();
  const [issued, setIssued] = useState<{ email: string; outcome: InviteOutcome } | null>(null);

  return (
    <div className="flex flex-col gap-3">
      {!inviteConfigured && (
        <div className="rounded-xl border border-dashed bg-card p-4 text-sm">
          <p className="font-medium">{t("invitations.noInviteUrlTitle")}</p>
          <p className="mt-1 text-muted-foreground">{t("invitations.noInviteUrlDescription")}</p>
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">{t(mailKey)}</p>
        {!readOnly && inviteConfigured && (
          <InviteDialog organizationId={organizationId} onIssued={(email, outcome) => setIssued({ email, outcome })} />
        )}
      </div>

      {invitations.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <IconMailPlus />
            </EmptyMedia>
            <EmptyTitle>{t("invitations.emptyTitle")}</EmptyTitle>
            <EmptyDescription>{t("invitations.emptyDescription")}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("invitations.colEmail")}</TableHead>
                <TableHead>{t("invitations.colRoles")}</TableHead>
                <TableHead>{t("invitations.colStatus")}</TableHead>
                <TableHead>{t("invitations.colExpires")}</TableHead>
                {!readOnly && <TableHead className="w-28 text-right">{t("invitations.colActions")}</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {invitations.map((invitation) => (
                <TableRow key={invitation.id}>
                  <TableCell>
                    <div className="flex flex-col">
                      <span className="font-medium">{invitation.email}</span>
                      <span className="text-xs text-muted-foreground">{invitation.invitedBy.subject}</span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1.5">
                      {invitation.roles.map((role) => (
                        <RoleChip key={role.id} role={role} />
                      ))}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col items-start gap-1">
                      <Badge variant={STATUS_VARIANT[invitation.status]}>{t(`invitations.status.${invitation.status}`)}</Badge>
                      {invitation.status === "pending" && (
                        <span
                          className={invitation.delivery.status === "failed" ? "text-xs text-destructive" : "text-xs text-muted-foreground"}
                          title={invitation.delivery.lastError}
                        >
                          {t(`invitations.mail.${invitation.delivery.status}`)}
                        </span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">{formatDate(invitation.expiresAt, locale)}</TableCell>
                  {!readOnly && (
                    <TableCell className="text-right">
                      {invitation.status === "pending" && (
                        <div className="flex justify-end gap-1">
                          {inviteConfigured && (
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              disabled={pending}
                              aria-label={t("invitations.resendAria", { email: invitation.email })}
                              title={t("invitations.resend")}
                              onClick={() =>
                                run(() => resendInvitation({ organizationId, invitationId: invitation.id }), {
                                  success: t("invitations.resent"),
                                  onSuccess: (result) =>
                                    "data" in result && setIssued({ email: invitation.email, outcome: result.data as InviteOutcome }),
                                })
                              }
                            >
                              <IconRefresh />
                            </Button>
                          )}
                          <ConfirmDialog
                            trigger={
                              <Button variant="ghost" size="icon-sm" disabled={pending} aria-label={t("invitations.revokeAria", { email: invitation.email })}>
                                <IconX />
                              </Button>
                            }
                            title={t("invitations.revokeTitle")}
                            description={t("invitations.revokeDescription", { email: invitation.email })}
                            confirmLabel={t("invitations.revokeConfirm")}
                            pending={pending}
                            onConfirm={() =>
                              run(() => revokeInvitation({ organizationId, invitationId: invitation.id }), { success: t("invitations.revoked") })
                            }
                          />
                        </div>
                      )}
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {nextHref && (
        <div className="flex justify-center">
          <Button variant="outline" render={<Link href={nextHref} />}>
            {t("invitations.loadMore")} <IconArrowRight />
          </Button>
        </div>
      )}

      <Dialog open={issued !== null} onOpenChange={(open) => !open && setIssued(null)}>
        <DialogContent>
          {issued && (
            <>
              <DialogHeader>
                <DialogTitle>{t("invitations.linkTitle")}</DialogTitle>
                <DialogDescription>{t("invitations.linkDescription", { email: issued.email })}</DialogDescription>
              </DialogHeader>
              <p className="text-sm text-muted-foreground">
                {issued.outcome.delivery === "sent"
                  ? t("invitations.linkDelivered")
                  : issued.outcome.delivery === "failed"
                    ? t("invitations.linkFailed", { error: issued.outcome.error ?? "—" })
                    : t("invitations.linkSkipped")}
              </p>
              <div className="flex items-center gap-2 rounded-lg border bg-muted p-2">
                <code className="min-w-0 flex-1 break-all text-xs">{issued.outcome.acceptUrl}</code>
                <CopyButton value={issued.outcome.acceptUrl} label={t("invitations.linkTitle")} />
              </div>
              <DialogFooter>
                <Button onClick={() => setIssued(null)}>{t("invitations.done")}</Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function InviteDialog({ organizationId, onIssued }: { organizationId: string; onIssued: (email: string, outcome: InviteOutcome) => void }) {
  const { pending, run } = useAction();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [role, setRole] = useState<RoleRef | null>(null);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button />}>
        <IconMailPlus /> {t("invitations.invite")}
      </DialogTrigger>
      <DialogContent>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            const email = String(new FormData(event.currentTarget).get("email") ?? "");
            run(() => inviteMember({ organizationId, email, roleId: role?.id ?? "" }), {
              success: t("invitations.created"),
              onSuccess: (result) => {
                setOpen(false);
                setRole(null);
                if ("data" in result) onIssued(email.trim().toLowerCase(), result.data as InviteOutcome);
              },
            });
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("invitations.inviteTitle")}</DialogTitle>
            <DialogDescription>{t("invitations.inviteDescription")}</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="invite-email">{t("invitations.email")}</FieldLabel>
              <Input id="invite-email" name="email" type="email" required maxLength={254} autoComplete="off" autoFocus />
            </Field>
            <Field>
              <FieldLabel>{t("invitations.role")}</FieldLabel>
              <div className="flex items-center gap-2">
                {role && <RoleChip role={role} />}
                <RolePicker organizationId={organizationId} variant="outline" label={role ? undefined : t("invitations.role")} onPick={setRole} />
              </div>
              <FieldDescription>{t("members.noRoleHint")}</FieldDescription>
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button type="submit" disabled={pending || !role}>
              {pending ? t("invitations.sending") : t("invitations.send")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
