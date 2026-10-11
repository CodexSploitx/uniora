"use client";

import { IconEdit, IconPlus } from "@tabler/icons-react";
import { useState } from "react";
import { createWebhook, updateWebhook } from "@/actions/webhooks";
import { useAction } from "@/components/shared/use-action";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useI18n } from "@/i18n/client";
import type { WebhookEndpointRow } from "@/lib/types";

const items = (text: string): string[] => [...new Set(text.split(/[\s,]+/).filter(Boolean))];

/**
 * Registers an endpoint, or edits one when `endpoint` is given. Creating hands the signing secret to `onSecret` (the page shows it once);
 * editing sends the version it was loaded at, so a stale form is refused.
 */
export function WebhookFormDialog({ endpoint, onSecret }: { endpoint?: WebhookEndpointRow; onSecret?: (secret: string) => void }) {
  const { t } = useI18n();
  const { pending, run } = useAction();
  const [open, setOpen] = useState(false);
  const editing = endpoint !== undefined;
  const initial = () => ({
    url: endpoint?.url ?? "",
    description: endpoint?.description ?? "",
    events: endpoint?.events.join("\n") ?? "membership.*",
    all: endpoint ? endpoint.organizations === "*" : true,
    organizations: endpoint && endpoint.organizations !== "*" ? endpoint.organizations.join("\n") : "",
  });
  const [form, setForm] = useState(initial);
  const set = (patch: Partial<ReturnType<typeof initial>>) => setForm((current) => ({ ...current, ...patch }));

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Always from what the server says NOW: a form that kept old values would send them together with a fresh version.
        if (next) setForm(initial());
        setOpen(next);
      }}
    >
      <DialogTrigger
        render={
          <Button variant={editing ? "outline" : "default"} size={editing ? "sm" : "default"}>
            {editing ? <IconEdit /> : <IconPlus />} {editing ? t("webhooks.edit") : t("webhooks.new")}
          </Button>
        }
      />
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            const common = { url: form.url.trim(), events: items(form.events), allOrganizations: form.all, organizations: items(form.organizations), description: form.description.trim() };
            if (editing) {
              run(() => updateWebhook({ endpointId: endpoint.id, expectedVersion: endpoint.version, ...common }), { success: t("webhooks.updatedToast"), onSuccess: () => setOpen(false) });
            } else {
              run(() => createWebhook(common), {
                success: t("webhooks.createdToast"),
                onSuccess: (result) => {
                  setOpen(false);
                  onSecret?.((result as { data: { secret: string } }).data.secret);
                },
              });
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>{editing ? t("webhooks.editTitle") : t("webhooks.new")}</DialogTitle>
            <DialogDescription>{t("webhooks.formDescription")}</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor={`webhook-url-${endpoint?.id ?? "new"}`}>{t("webhooks.url")}</FieldLabel>
              <Input id={`webhook-url-${endpoint?.id ?? "new"}`} type="url" value={form.url} onChange={(event) => set({ url: event.target.value })} placeholder="https://hooks.example.com/uniora" required maxLength={2000} autoFocus autoComplete="off" />
              <FieldDescription>{t("webhooks.urlHint")}</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor={`webhook-description-${endpoint?.id ?? "new"}`}>{t("webhooks.descriptionLabel")}</FieldLabel>
              <Input id={`webhook-description-${endpoint?.id ?? "new"}`} value={form.description} onChange={(event) => set({ description: event.target.value })} maxLength={200} />
              <FieldDescription>{t("webhooks.descriptionHint")}</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor={`webhook-events-${endpoint?.id ?? "new"}`}>{t("webhooks.events")}</FieldLabel>
              <Textarea id={`webhook-events-${endpoint?.id ?? "new"}`} value={form.events} onChange={(event) => set({ events: event.target.value })} placeholder={"membership.*\nrole.updated"} rows={3} required />
              <FieldDescription>{t("webhooks.eventsHint")}</FieldDescription>
            </Field>
            <Field>
              <FieldLabel>{t("webhooks.organizations")}</FieldLabel>
              <Field orientation="horizontal">
                <Checkbox id={`webhook-all-${endpoint?.id ?? "new"}`} checked={form.all} onCheckedChange={(next) => set({ all: next === true })} />
                <FieldLabel htmlFor={`webhook-all-${endpoint?.id ?? "new"}`}>{t("webhooks.allOrganizations")}</FieldLabel>
              </Field>
              {!form.all && <Textarea value={form.organizations} onChange={(event) => set({ organizations: event.target.value })} placeholder={"org_acme\norg_globex"} rows={3} aria-label={t("webhooks.organizations")} />}
              <FieldDescription>{form.all ? t("webhooks.allOrganizationsHint") : t("webhooks.organizationsHint")}</FieldDescription>
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button type="submit" disabled={pending || items(form.events).length === 0 || (!form.all && items(form.organizations).length === 0)}>
              {editing ? t("common.save") : t("webhooks.create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
