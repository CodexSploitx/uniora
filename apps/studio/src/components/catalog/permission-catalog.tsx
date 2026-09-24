"use client";

import { IconArrowRight, IconKey, IconPlus, IconTrash } from "@tabler/icons-react";
import Link from "next/link";
import { useState } from "react";
import { registerPermission, unregisterPermission } from "@/actions/permissions";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { ListSearch } from "@/components/shared/list-search";
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
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useI18n } from "@/i18n/client";
import { rich } from "@/i18n/rich";
import type { PermissionView } from "@/lib/types";

interface PermissionCatalogProps {
  permissions: PermissionView[];
  total: number;
  query: string;
  nextHref: string | null;
  readOnly: boolean;
}

export function PermissionCatalog({ permissions, total, query, nextHref, readOnly }: PermissionCatalogProps) {
  const { pending, run } = useAction();
  const { t } = useI18n();

  if (total === 0 && !query) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <IconKey />
          </EmptyMedia>
          <EmptyTitle>{t("perms.emptyTitle")}</EmptyTitle>
          <EmptyDescription>
            {rich(t("perms.emptyDescription"), { format: <code>resource.action</code>, example: <code>vehicles.delete</code> })}
          </EmptyDescription>
        </EmptyHeader>
        {!readOnly && (
          <EmptyContent>
            <RegisterPermissionDialog />
          </EmptyContent>
        )}
      </Empty>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ListSearch
          basePath="/permissions"
          initialQuery={query}
          placeholderKey="perms.searchPlaceholder"
          labelKey="perms.searchLabel"
          clearKey="perms.clearSearch"
        />
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground">{t("perms.resultsCount", { count: total })}</span>
          {!readOnly && <RegisterPermissionDialog />}
        </div>
      </div>
      {permissions.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <IconKey />
            </EmptyMedia>
            <EmptyTitle>{t("perms.noMatchesTitle", { query })}</EmptyTitle>
            <EmptyDescription>{t("perms.noMatchesDescription")}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
      <div className="overflow-hidden rounded-xl border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("perms.permission")}</TableHead>
              <TableHead>{t("perms.descriptionColumn")}</TableHead>
              <TableHead>{t("perms.grantedTo")}</TableHead>
              {!readOnly && <TableHead className="w-16 text-right">&nbsp;</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {permissions.map((permission) => (
              <TableRow key={permission.key}>
                <TableCell>
                  <div className="flex flex-col">
                    <code className="text-xs font-medium">{permission.key}</code>
                    {permission.name && <span className="text-xs text-muted-foreground">{permission.name}</span>}
                  </div>
                </TableCell>
                <TableCell className="max-w-72 whitespace-normal text-muted-foreground">{permission.description ?? "—"}</TableCell>
                <TableCell>
                  <Badge variant={permission.grantedRoleCount > 0 ? "info-light" : "outline"}>
                    {t("count.roles", { count: permission.grantedRoleCount })}
                  </Badge>
                </TableCell>
                {!readOnly && (
                  <TableCell className="text-right">
                    <ConfirmDialog
                      trigger={
                        <Button variant="ghost" size="icon-sm" aria-label={t("perms.unregisterAria", { key: permission.key })} disabled={pending}>
                          <IconTrash />
                        </Button>
                      }
                      title={t("perms.unregisterTitle", { key: permission.key })}
                      description={
                        permission.grantedRoleCount > 0
                          ? t("perms.unregisterInUse", { count: permission.grantedRoleCount })
                          : t("perms.unregisterFree")
                      }
                      confirmLabel={t("perms.unregisterConfirm")}
                      pending={pending}
                      onConfirm={() => run(() => unregisterPermission({ key: permission.key }), { success: t("perms.unregistered") })}
                    />
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
            {t("perms.loadMore")} <IconArrowRight />
          </Button>
        </div>
      )}
    </div>
  );
}

function RegisterPermissionDialog() {
  const { pending, run } = useAction();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button />}>
        <IconPlus /> {t("perms.register")}
      </DialogTrigger>
      <DialogContent>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            run(
              () =>
                registerPermission({
                  key: String(form.get("key") ?? ""),
                  name: String(form.get("name") ?? ""),
                  description: String(form.get("description") ?? ""),
                }),
              { success: t("perms.registered"), onSuccess: () => setOpen(false) },
            );
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("perms.register")}</DialogTitle>
            <DialogDescription>{t("perms.registerDescription")}</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="perm-key">{t("perms.key")}</FieldLabel>
              <Input id="perm-key" name="key" placeholder="vehicles.delete" required maxLength={128} autoFocus />
<FieldDescription>{rich(t("perms.keyHint"), { format: <code>resource.action</code> })}</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="perm-name">{t("perms.nameOptional")}</FieldLabel>
              <Input id="perm-name" name="name" placeholder="Delete vehicles" maxLength={100} />
            </Field>
            <Field>
              <FieldLabel htmlFor="perm-desc">{t("perms.descriptionOptional")}</FieldLabel>
              <Input id="perm-desc" name="description" maxLength={500} />
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? t("perms.saving") : t("perms.registerConfirm")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
