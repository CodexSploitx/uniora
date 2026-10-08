"use client";

import { IconDots } from "@tabler/icons-react";
import { useState } from "react";
import { setMemberStatus } from "@/actions/memberships";
import { useAction } from "@/components/shared/use-action";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useI18n } from "@/i18n/client";
import type { MemberRow } from "@/lib/types";

/** Block, suspend until a date, or restore access of one member. Each change asks for an optional reason and is audited by Core. */
export function MemberStatusMenu({
  organizationId,
  member,
  disabled,
}: {
  organizationId: string;
  member: Pick<MemberRow, "id" | "status" | "identity">;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const { pending, run } = useAction();
  const [dialog, setDialog] = useState<"block" | "suspend" | null>(null);
  const label = member.identity.subject;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="ghost" size="icon-sm" disabled={disabled || pending} aria-label={t("status.menuAria", { member: label })} />}
        >
          <IconDots />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {member.status !== "active" && (
            <DropdownMenuItem
              onClick={() =>
                run(() => setMemberStatus({ organizationId, membershipId: member.id, action: "unblock" }), {
                  success: t("status.unblocked.toast"),
                })
              }
            >
              {t("status.unblock")}
            </DropdownMenuItem>
          )}
          {member.status !== "suspended" && <DropdownMenuItem onClick={() => setDialog("suspend")}>{t("status.suspend")}</DropdownMenuItem>}
          {member.status !== "blocked" && <DropdownMenuItem onClick={() => setDialog("block")}>{t("status.block")}</DropdownMenuItem>}
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={dialog !== null} onOpenChange={(open) => !open && setDialog(null)}>
        <DialogContent>
          {dialog && (
            <form
              className="grid gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                const form = new FormData(event.currentTarget);
                const until = String(form.get("until") ?? "");
                run(
                  () =>
                    setMemberStatus({
                      organizationId,
                      membershipId: member.id,
                      action: dialog,
                      reason: String(form.get("reason") ?? ""),
                      until: until ? new Date(until).toISOString() : undefined,
                    }),
                  { success: t(dialog === "block" ? "status.blocked.toast" : "status.suspended.toast"), onSuccess: () => setDialog(null) },
                );
              }}
            >
              <DialogHeader>
                <DialogTitle>{t(dialog === "block" ? "status.blockTitle" : "status.suspendTitle")}</DialogTitle>
                <DialogDescription>
                  {t(dialog === "block" ? "status.blockDescription" : "status.suspendDescription", { member: label })}
                </DialogDescription>
              </DialogHeader>
              {dialog === "suspend" && (
                <Field>
                  <FieldLabel htmlFor="member-until">{t("field.until")}</FieldLabel>
                  <Input id="member-until" name="until" type="datetime-local" required />
                </Field>
              )}
              <Field>
                <FieldLabel htmlFor="member-reason">{t("status.reasonLabel")}</FieldLabel>
                <Input id="member-reason" name="reason" maxLength={500} />
              </Field>
              <DialogFooter>
                <Button type="submit" variant="destructive" disabled={pending}>
                  {t(dialog === "block" ? "status.block" : "status.suspend")}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
