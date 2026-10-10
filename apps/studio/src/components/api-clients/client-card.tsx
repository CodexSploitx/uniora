"use client";

import { IconPlayerPause, IconPlayerPlay, IconTrash } from "@tabler/icons-react";
import { useRouter } from "next/navigation";
import { revokeApiKey, setApiClientEnabled } from "@/actions/api-clients";
import { Badge } from "@/components/reui/badge";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { useAction } from "@/components/shared/use-action";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useI18n } from "@/i18n/client";
import { API_SCOPE_META, type ApiScopeName } from "@/lib/api-scopes";
import { formatDate } from "@/lib/format";
import type { ApiClientRow } from "@/lib/types";
import { ClientFormDialog } from "./client-form-dialog";
import { NewKeyDialog } from "./new-key-dialog";

const KEY_VARIANT = { active: "success-light", revoked: "destructive-light", expired: "warning-light" } as const;

export function ClientCard({ client, readOnly }: { client: ApiClientRow; readOnly: boolean }) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const { pending, run } = useAction();
  const disabled = client.status === "disabled";
  const activeKeys = client.keys.filter((key) => key.status === "active").length;

  return (
    <article className="flex min-w-0 flex-col gap-4 rounded-xl border bg-card p-4" aria-label={client.name}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-heading text-base font-semibold">{client.name}</h3>
            <Badge variant={disabled ? "warning-light" : "success-light"}>{t(disabled ? "apiClients.disabled" : "apiClients.active")}</Badge>
          </div>
          <code className="text-xs text-muted-foreground">{client.id}</code>
        </div>
        {!readOnly && (
          <div className="flex flex-wrap items-center gap-2">
            <NewKeyDialog clientId={client.id} clientName={client.name} disabled={disabled || activeKeys >= 2} />
            <ClientFormDialog client={client} />
            {disabled ? (
              <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => setApiClientEnabled({ clientId: client.id, enabled: true }), { success: t("apiClients.enabledToast"), onSuccess: () => router.refresh() })}>
                <IconPlayerPlay /> {t("apiClients.enable")}
              </Button>
            ) : (
              <ConfirmDialog
                trigger={
                  <Button size="sm" variant="outline">
                    <IconPlayerPause /> {t("apiClients.disable")}
                  </Button>
                }
                title={t("apiClients.disableTitle", { name: client.name })}
                description={t("apiClients.disableDescription")}
                confirmLabel={t("apiClients.disable")}
                pending={pending}
                onConfirm={() => run(() => setApiClientEnabled({ clientId: client.id, enabled: false }), { success: t("apiClients.disabledToast"), onSuccess: () => router.refresh() })}
              />
            )}
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-1.5" aria-label={t("apiClients.scopes")}>
        {client.scopes.map((scope) => (
          <Badge key={scope} variant={API_SCOPE_META[scope as ApiScopeName]?.sensitive ? "warning-light" : "outline"}>
            {scope}
          </Badge>
        ))}
      </div>
      <p className="text-sm text-muted-foreground">
        {client.organizations === "*" ? t("apiClients.everyOrganization") : t("apiClients.organizationsCount", { count: client.organizations.length })}
      </p>

      {client.keys.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("apiClients.noKeys")}</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("apiClients.key")}</TableHead>
                <TableHead>{t("members.status")}</TableHead>
                <TableHead>{t("apiClients.created")}</TableHead>
                <TableHead>{t("apiClients.lastUsed")}</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {client.keys.map((key) => (
                <TableRow key={key.id}>
                  <TableCell>
                    <code className="text-xs">{key.hint}</code>
                  </TableCell>
                  <TableCell>
                    <Badge variant={KEY_VARIANT[key.status]}>{t(`apiClients.key_${key.status}`)}</Badge>
                    {key.expiresAt && key.status === "active" && <span className="ml-2 text-xs text-muted-foreground">{t("apiClients.expires", { date: formatDate(key.expiresAt, locale) })}</span>}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">{formatDate(key.createdAt, locale)}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{key.lastUsedAt ? formatDate(key.lastUsedAt, locale) : t("apiClients.neverUsed")}</TableCell>
                  <TableCell>
                    {!readOnly && key.status === "active" && (
                      <ConfirmDialog
                        trigger={
                          <Button size="icon-xs" variant="ghost" aria-label={t("apiClients.revoke")}>
                            <IconTrash />
                          </Button>
                        }
                        title={t("apiClients.revokeTitle")}
                        description={t("apiClients.revokeDescription")}
                        confirmLabel={t("apiClients.revoke")}
                        pending={pending}
                        onConfirm={() => run(() => revokeApiKey({ keyId: key.id }), { success: t("apiClients.revokedToast"), onSuccess: () => router.refresh() })}
                      />
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {activeKeys >= 2 && !readOnly && !disabled && <p className="text-xs text-muted-foreground">{t("apiClients.rotationHint")}</p>}
    </article>
  );
}
