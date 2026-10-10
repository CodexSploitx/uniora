"use client";

import { IconEdit, IconPlus } from "@tabler/icons-react";
import { useState, type ReactElement } from "react";
import { createApiClient, updateApiClient } from "@/actions/api-clients";
import { useAction } from "@/components/shared/use-action";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useI18n } from "@/i18n/client";
import type { ApiScopeName } from "@/lib/api-scopes";
import type { ApiClientRow } from "@/lib/types";
import { ScopePicker } from "./scope-picker";

const ids = (text: string): string[] => [...new Set(text.split(/[\s,]+/).filter(Boolean))];

/** Creates a client, or edits one when `client` is given. Editing sends the version it was loaded at, so a stale form is refused. */
export function ClientFormDialog({ client, trigger }: { client?: ApiClientRow; trigger?: ReactElement }) {
  const { t } = useI18n();
  const { pending, run } = useAction();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(client?.name ?? "");
  const [scopes, setScopes] = useState<ApiScopeName[]>((client?.scopes as ApiScopeName[] | undefined) ?? ["check"]);
  const [all, setAll] = useState(client ? client.organizations === "*" : false);
  const [organizations, setOrganizations] = useState(client && client.organizations !== "*" ? client.organizations.join("\n") : "");
  const editing = client !== undefined;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          trigger ?? (
            <Button variant={editing ? "outline" : "default"} size={editing ? "sm" : "default"}>
              {editing ? <IconEdit /> : <IconPlus />} {editing ? t("apiClients.edit") : t("apiClients.new")}
            </Button>
          )
        }
      />
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            const common = { name, scopes, allOrganizations: all, organizations: ids(organizations) };
            run(
              () => (editing ? updateApiClient({ clientId: client.id, expectedVersion: client.version, ...common }) : createApiClient(common)),
              { success: editing ? t("apiClients.updatedToast") : t("apiClients.createdToast"), onSuccess: () => setOpen(false) },
            );
          }}
        >
          <DialogHeader>
            <DialogTitle>{editing ? t("apiClients.editTitle", { name: client.name }) : t("apiClients.new")}</DialogTitle>
            <DialogDescription>{t("apiClients.formDescription")}</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="client-name">{t("apiClients.name")}</FieldLabel>
              <Input id="client-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="signup-worker" required maxLength={100} autoFocus />
              <FieldDescription>{t("apiClients.nameHint")}</FieldDescription>
            </Field>
            <Field>
              <FieldLabel>{t("apiClients.scopes")}</FieldLabel>
              <ScopePicker value={scopes} onChange={setScopes} idPrefix={editing ? `edit-${client.id}` : "new"} />
            </Field>
            <Field>
              <FieldLabel>{t("apiClients.organizations")}</FieldLabel>
              <Field orientation="horizontal">
                <Checkbox id={`all-orgs-${client?.id ?? "new"}`} checked={all} onCheckedChange={(next) => setAll(next === true)} />
                <FieldLabel htmlFor={`all-orgs-${client?.id ?? "new"}`}>{t("apiClients.allOrganizations")}</FieldLabel>
              </Field>
              {!all && (
                <Textarea
                  value={organizations}
                  onChange={(event) => setOrganizations(event.target.value)}
                  placeholder={"org_acme\norg_globex"}
                  rows={3}
                  aria-label={t("apiClients.organizations")}
                />
              )}
              <FieldDescription>{all ? t("apiClients.allOrganizationsHint") : t("apiClients.organizationsHint")}</FieldDescription>
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button type="submit" disabled={pending || scopes.length === 0 || (!all && ids(organizations).length === 0)}>
              {editing ? t("common.save") : t("apiClients.create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
