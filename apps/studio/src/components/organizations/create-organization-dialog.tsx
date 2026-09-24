"use client";

import { IconPlus } from "@tabler/icons-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { createOrganization } from "@/actions/organizations";
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
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ProviderField } from "@/components/shared/provider-field";
import { useI18n } from "@/i18n/client";

export function CreateOrganizationDialog({ defaultProvider }: { defaultProvider?: string }) {
  const router = useRouter();
  const { pending, run } = useAction();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button />}>
        <IconPlus /> {t("orgs.new")}
      </DialogTrigger>
      <DialogContent>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            run(
              () =>
                createOrganization({
                  name: String(form.get("name") ?? ""),
                  slug: String(form.get("slug") ?? ""),
                  ownerProvider: String(form.get("provider") ?? ""),
                  ownerSubject: String(form.get("subject") ?? ""),
                }),
              {
                success: t("orgs.createdToast"),
                onSuccess: (result) => {
                  setOpen(false);
                  router.push(`/organizations/${(result as { data: { id: string } }).data.id}`);
                },
              },
            );
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("orgs.new")}</DialogTitle>
            <DialogDescription>{t("orgs.dialogDescription")}</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="org-name">{t("orgs.name")}</FieldLabel>
              <Input id="org-name" name="name" placeholder="Acme Motors" required maxLength={255} autoFocus />
            </Field>
            <Field>
              <FieldLabel htmlFor="org-slug">{t("orgs.slug")}</FieldLabel>
              <Input id="org-slug" name="slug" placeholder="acme-motors" maxLength={63} />
              <FieldDescription>{t("orgs.slugHint")}</FieldDescription>
            </Field>
            <ProviderField id="org-provider" name="provider" label={t("orgs.ownerProvider")} defaultValue={defaultProvider} />
            <Field>
              <FieldLabel htmlFor="org-subject">{t("orgs.ownerUserId")}</FieldLabel>
              <Input id="org-subject" name="subject" placeholder="user id" required maxLength={255} />
            </Field>
            <FieldDescription>{t("orgs.ownerHint")}</FieldDescription>
          </FieldGroup>
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? t("orgs.creating") : t("orgs.create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
