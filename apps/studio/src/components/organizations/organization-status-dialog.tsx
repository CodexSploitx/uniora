"use client";

import { IconShieldHalf } from "@tabler/icons-react";
import { useState } from "react";
import { setOrganizationStatus } from "@/actions/organizations";
import { useAction } from "@/components/shared/use-action";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useI18n } from "@/i18n/client";

const STATUSES = ["active", "suspended", "archived"] as const;

export function OrganizationStatusDialog({ organizationId, status }: { organizationId: string; status: (typeof STATUSES)[number] }) {
  const { t } = useI18n();
  const { pending, run } = useAction();
  const [open, setOpen] = useState(false);
  const [next, setNext] = useState<(typeof STATUSES)[number]>(status);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="outline" size="sm" />}>
        <IconShieldHalf /> {t("orgStatus.change")}
      </DialogTrigger>
      <DialogContent>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            run(() => setOrganizationStatus({ organizationId, status: next, reason: String(form.get("reason") ?? "") }), {
              success: t("orgStatus.saved"),
              onSuccess: () => setOpen(false),
            });
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("orgStatus.title")}</DialogTitle>
            <DialogDescription>{t("orgStatus.description")}</DialogDescription>
          </DialogHeader>
          <div role="radiogroup" aria-label={t("orgStatus.title")} className="flex gap-1.5">
            {STATUSES.map((value) => (
              <Button key={value} type="button" role="radio" aria-checked={next === value} variant={next === value ? "default" : "outline"} size="sm" onClick={() => setNext(value)}>
                {t(`status.${value}`)}
              </Button>
            ))}
          </div>
          <Field>
            <FieldLabel htmlFor="org-status-reason">{t("status.reasonLabel")}</FieldLabel>
            <Input id="org-status-reason" name="reason" maxLength={500} />
            <FieldDescription>{t("orgStatus.reasonHint")}</FieldDescription>
          </Field>
          <DialogFooter>
            <Button type="submit" disabled={pending || next === status}>
              {t("orgStatus.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
