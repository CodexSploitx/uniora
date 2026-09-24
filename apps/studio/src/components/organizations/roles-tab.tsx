"use client";

import { IconArrowRight, IconDots, IconLock, IconPencil, IconPlus, IconShieldLock, IconTrash } from "@tabler/icons-react";
import Link from "next/link";
import { useOptimistic, useState } from "react";
import { createRole, deleteRole, renameRole, setRolePermission } from "@/actions/roles";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ListSearch } from "@/components/shared/list-search";
import { useAction } from "@/components/shared/use-action";
import { Badge } from "@/components/reui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { useI18n } from "@/i18n/client";
import { rich } from "@/i18n/rich";
import type { RolePermissionRow, RoleRow } from "@/lib/types";

export interface RolesTabProps {
  organizationId: string;
  /** `/organizations/<id>` — every link/search below is built from it. */
  orgPath: string;
  readOnly: boolean;
  roles: RoleRow[];
  rolesTotal: number;
  rolesQuery: string;
  rolesNextCursor: string | null;
  selectedRoleId: string | null;
  selected: {
    role: RoleRow;
    permissions: RolePermissionRow[];
    total: number;
    query: string;
    grantedOnly: boolean;
    nextCursor: string | null;
  } | null;
}

/** Builds `/organizations/<id>?tab=roles&…`, dropping empty values. */
function rolesHref(orgPath: string, params: Record<string, string | null | undefined>): string {
  const search = new URLSearchParams({ tab: "roles" });
  for (const [key, value] of Object.entries(params)) if (value) search.set(key, value);
  return `${orgPath}?${search.toString()}`;
}

/**
 * Roles of one organization, master/detail. The old roles × permissions grid
 * cannot exist when an organization has thousands of roles and permissions
 * (that is a million cells), so: the left list pages through roles, and the
 * right panel shows ONE role's permissions — a paged, searchable slice of the
 * permission catalog with this role's grant state on each row.
 */
export function RolesTab(props: RolesTabProps) {
  const { organizationId, orgPath, readOnly, roles, rolesTotal, rolesQuery, rolesNextCursor, selectedRoleId, selected } = props;
  const { t } = useI18n();
  const [renaming, setRenaming] = useState<RoleRow | null>(null);
  const [deleting, setDeleting] = useState<RoleRow | null>(null);

  if (rolesTotal === 0 && !rolesQuery) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <IconLock />
          </EmptyMedia>
          <EmptyTitle>{t("roles.emptyTitle")}</EmptyTitle>
          <EmptyDescription>{t("roles.emptyDescription")}</EmptyDescription>
        </EmptyHeader>
        {!readOnly && <CreateRoleDialog organizationId={organizationId} />}
      </Empty>
    );
  }

  const listBase = rolesHref(orgPath, { role: selectedRoleId });

  return (
    <div className="grid gap-4 lg:grid-cols-5">
      <section className="flex flex-col gap-3 lg:col-span-2" aria-label={t("roles.listAria")}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <ListSearch
            basePath={listBase}
            initialQuery={rolesQuery}
            placeholderKey="roles.searchPlaceholder"
            labelKey="roles.searchLabel"
            clearKey="roles.clearSearch"
          />
          {!readOnly && <CreateRoleDialog organizationId={organizationId} />}
        </div>
        <span className="text-xs text-muted-foreground">{t("roles.resultsCount", { count: rolesTotal })}</span>

        {roles.length === 0 ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyTitle>{t("roles.noMatchesTitle", { query: rolesQuery })}</EmptyTitle>
              <EmptyDescription>{t("roles.noMatchesDescription")}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ul className="flex max-h-[28rem] flex-col divide-y overflow-y-auto rounded-xl border bg-card lg:max-h-[calc(100vh-18rem)]">
            {roles.map((role) => {
              const active = role.id === selectedRoleId;
              return (
                <li key={role.id}>
                  <Link
                    href={rolesHref(orgPath, { role: role.id, q: rolesQuery })}
                    aria-current={active ? "true" : undefined}
                    className={"flex flex-col gap-1 px-4 py-3 transition-colors " + (active ? "bg-primary/5" : "hover:bg-muted/50")}
                  >
                    <span className="flex items-center gap-1.5 text-sm font-medium">
                      {role.isOwnerRole && <IconShieldLock className="size-3.5 text-primary" />}
                      <span className="truncate" title={role.name}>{role.name}</span>
                    </span>
                    <span className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
                      <code>{role.key}</code>
                      <span aria-hidden>·</span>
                      <span>{t("roles.members", { count: role.memberCount })}</span>
                      <span aria-hidden>·</span>
                      <span>{role.isOwnerRole ? t("roles.fullAccess") : t("roles.permissionsCount", { count: role.permissionCount })}</span>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}

        {rolesNextCursor && (
          <Button variant="outline" render={<Link href={rolesHref(orgPath, { role: selectedRoleId, q: rolesQuery, after: rolesNextCursor })} />}>
            {t("roles.loadMore")} <IconArrowRight />
          </Button>
        )}
      </section>

      <section className="lg:sticky lg:top-20 lg:col-span-3 lg:self-start" aria-label={t("roles.detailAria")}>
        {selected ? (
          <RoleDetail
            organizationId={organizationId}
            orgPath={orgPath}
            readOnly={readOnly}
            {...selected}
            rolesQuery={rolesQuery}
            onRename={() => setRenaming(selected.role)}
            onDelete={() => setDeleting(selected.role)}
          />
        ) : (
          <Empty className="border">
            <EmptyHeader>
              <EmptyTitle>{t("roles.selectTitle")}</EmptyTitle>
              <EmptyDescription>{t("roles.selectDescription")}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </section>

      <RenameRoleDialog organizationId={organizationId} role={renaming} onClose={() => setRenaming(null)} />
      <DeleteRoleDialog organizationId={organizationId} role={deleting} onClose={() => setDeleting(null)} />
    </div>
  );
}

interface RoleDetailProps {
  organizationId: string;
  orgPath: string;
  readOnly: boolean;
  role: RoleRow;
  permissions: RolePermissionRow[];
  total: number;
  query: string;
  grantedOnly: boolean;
  nextCursor: string | null;
  rolesQuery: string;
  onRename: () => void;
  onDelete: () => void;
}

function RoleDetail({ organizationId, orgPath, readOnly, role, permissions, total, query, grantedOnly, nextCursor, rolesQuery, onRename, onDelete }: RoleDetailProps) {
  const { pending, run } = useAction();
  const { t } = useI18n();
  const [optimistic, applyToggle] = useOptimistic(permissions, (current, change: { key: string; granted: boolean }) =>
    current.map((permission) => (permission.key === change.key ? { ...permission, granted: change.granted } : permission)),
  );

  const base = { role: role.id, q: rolesQuery };
  const detailBase = rolesHref(orgPath, { ...base, pq: query, pshow: grantedOnly ? "granted" : null });

  return (
    <div className="flex flex-col gap-3 rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h3 className="flex items-center gap-1.5 font-heading text-base font-semibold">
            {role.isOwnerRole && <IconShieldLock className="size-4 text-primary" />}
            <span className="truncate">{role.name}</span>
          </h3>
          <div className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
            <code>{role.key}</code>
            <span aria-hidden>·</span>
            <span>{t("roles.members", { count: role.memberCount })}</span>
            {!role.isOwnerRole && (
              <>
                <span aria-hidden>·</span>
                <span>{t("roles.permissionsCount", { count: role.permissionCount })}</span>
              </>
            )}
          </div>
        </div>
        {!readOnly && !role.isOwnerRole && (
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={t("roles.actionsFor", { role: role.name })} />}>
              <IconDots />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={onRename}>
                <IconPencil /> {t("roles.rename")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={onDelete}>
                <IconTrash /> {t("roles.delete")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {role.isOwnerRole ? (
        <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Badge variant="primary-light" size="sm">
            <IconShieldLock /> {t("common.owner")}
          </Badge>
          {t("roles.ownerNote")}
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <ListSearch
              basePath={detailBase}
              queryParam="pq"
              cursorParam="pafter"
              initialQuery={query}
              placeholderKey="roles.permSearchPlaceholder"
              labelKey="roles.permSearchLabel"
              clearKey="roles.clearSearch"
            />
            <div className="flex items-center gap-2 text-xs">
              <Link
                href={rolesHref(orgPath, { ...base, pq: query })}
                className={"rounded-md px-2 py-1 " + (!grantedOnly ? "bg-muted font-medium" : "text-muted-foreground hover:text-foreground")}
              >
                {t("roles.filterAll")}
              </Link>
              <Link
                href={rolesHref(orgPath, { ...base, pq: query, pshow: "granted" })}
                className={"rounded-md px-2 py-1 " + (grantedOnly ? "bg-muted font-medium" : "text-muted-foreground hover:text-foreground")}
              >
                {t("roles.filterGranted")}
              </Link>
              <span className="text-muted-foreground">{t("perms.resultsCount", { count: total })}</span>
            </div>
          </div>

          {optimistic.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {query || grantedOnly ? t("roles.permNoMatches") : t("roles.permCatalogEmpty")}
            </p>
          ) : (
            <ul className="flex flex-col divide-y rounded-lg border">
              {optimistic.map((permission) => (
                <li key={permission.key}>
                  <label className="flex cursor-pointer items-center gap-3 px-3 py-2">
                    <Checkbox
                      checked={permission.granted}
                      disabled={readOnly || pending}
                      aria-label={t("roles.cellAria", { permission: permission.key, role: role.name })}
                      onCheckedChange={(checked) => {
                        const granted = checked === true;
                        run(
                          () => setRolePermission({ organizationId, roleId: role.id, permissionKey: permission.key, granted }),
                          {
                            success: granted ? t("roles.granted", { permission: permission.key }) : t("roles.revoked", { permission: permission.key }),
                            before: () => applyToggle({ key: permission.key, granted }),
                          },
                        );
                      }}
                    />
                    <span className="flex min-w-0 flex-col">
                      <code className="truncate text-xs font-medium">{permission.key}</code>
                      {(permission.name || permission.description) && (
                        <span className="truncate text-xs text-muted-foreground">{permission.name ?? permission.description}</span>
                      )}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}

          {nextCursor && (
            <Button variant="outline" render={<Link href={rolesHref(orgPath, { ...base, pq: query, pshow: grantedOnly ? "granted" : null, pafter: nextCursor })} />}>
              {t("roles.loadMore")} <IconArrowRight />
            </Button>
          )}
        </>
      )}
    </div>
  );
}

function DeleteRoleDialog({
  organizationId,
  role,
  onClose,
}: {
  organizationId: string;
  role: RoleRow | null;
  onClose: () => void;
}) {
  const { pending, run } = useAction();
  const { t } = useI18n();
  return (
    <AlertDialog open={role !== null} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        {role && (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>{t("roles.deleteTitle", { role: role.name })}</AlertDialogTitle>
<AlertDialogDescription>{t("roles.deleteDescription", { count: role.memberCount })}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
              <Button
                variant="destructive"
                disabled={pending}
                onClick={() => {
                  run(() => deleteRole({ organizationId, roleId: role.id }), { success: t("roles.deleted") });
                  onClose();
                }}
              >
                {t("roles.deleteConfirm")}
              </Button>
            </AlertDialogFooter>
          </>
        )}
      </AlertDialogContent>
    </AlertDialog>
  );
}

function RenameRoleDialog({
  organizationId,
  role,
  onClose,
}: {
  organizationId: string;
  role: RoleRow | null;
  onClose: () => void;
}) {
  const { pending, run } = useAction();
  const { t } = useI18n();
  return (
    <Dialog open={role !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        {role && (
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              const name = String(new FormData(event.currentTarget).get("name") ?? "");
              run(() => renameRole({ organizationId, roleId: role.id, name }), {
                success: t("roles.renamed"),
                onSuccess: onClose,
              });
            }}
          >
            <DialogHeader>
              <DialogTitle>{t("roles.renameTitle")}</DialogTitle>
<DialogDescription>{rich(t("roles.renameDescription"), { key: <code>{role.key}</code> })}</DialogDescription>
            </DialogHeader>
            <Field>
              <FieldLabel htmlFor="rename-role">{t("roles.name")}</FieldLabel>
              <Input id="rename-role" name="name" defaultValue={role.name} required maxLength={100} autoFocus />
            </Field>
            <DialogFooter>
              <Button type="submit" disabled={pending}>
                {t("roles.save")}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function CreateRoleDialog({ organizationId }: { organizationId: string }) {
  const { pending, run } = useAction();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button />}>
        <IconPlus /> {t("roles.new")}
      </DialogTrigger>
      <DialogContent>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            run(
              () =>
                createRole({
                  organizationId,
                  name: String(form.get("name") ?? ""),
                  key: String(form.get("key") ?? ""),
                }),
              { success: t("roles.created"), onSuccess: () => setOpen(false) },
            );
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("roles.new")}</DialogTitle>
            <DialogDescription>{t("roles.newDescription")}</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <div className="grid grid-cols-2 gap-3">
              <Field>
                <FieldLabel htmlFor="role-name">{t("roles.name")}</FieldLabel>
                <Input id="role-name" name="name" placeholder="Sales manager" required maxLength={100} autoFocus />
              </Field>
              <Field>
                <FieldLabel htmlFor="role-key">{t("roles.key")}</FieldLabel>
                <Input id="role-key" name="key" placeholder="sales-manager" maxLength={63} />
              </Field>
            </div>
            <FieldDescription>{t("roles.keyHint")}</FieldDescription>
            <FieldDescription>{t("roles.grantAfterCreate")}</FieldDescription>
          </FieldGroup>
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? t("roles.creating") : t("roles.create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
