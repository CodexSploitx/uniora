"use client";

import { IconPencil } from "@tabler/icons-react";
import { useState } from "react";
import { renameOrganization } from "@/actions/organizations";
import { useAction } from "@/components/shared/use-action";
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
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useI18n } from "@/i18n/client";

export function RenameOrganizationDialog({ organizationId, name }: { organizationId: string; name: string }) {
  const { pending, run } = useAction();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="outline" size="sm" />}>
        <IconPencil /> {t("orgs.rename")}
      </DialogTrigger>
      <DialogContent>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            run(() => renameOrganization({ organizationId, name: String(form.get("name") ?? "") }), {
              success: t("orgs.renamedToast"),
              onSuccess: () => setOpen(false),
            });
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("orgs.rename")}</DialogTitle>
            <DialogDescription>{t("orgs.renameDescription")}</DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor="org-rename">{t("orgs.name")}</FieldLabel>
            <Input id="org-rename" name="name" defaultValue={name} required maxLength={255} autoFocus />
          </Field>
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? t("orgs.renaming") : t("orgs.rename")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
