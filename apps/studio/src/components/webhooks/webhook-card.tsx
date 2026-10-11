"use client";

import { IconPlayerPause, IconPlayerPlay, IconRefresh, IconRepeat, IconTrash } from "@tabler/icons-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { deleteWebhook, requeueWebhookDelivery, rotateWebhookSecret, setWebhookEnabled } from "@/actions/webhooks";
import { Badge } from "@/components/reui/badge";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { useAction } from "@/components/shared/use-action";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useI18n } from "@/i18n/client";
import { formatDate } from "@/lib/format";
import type { WebhookEndpointRow } from "@/lib/types";
import { WebhookFormDialog } from "./webhook-form-dialog";

const DELIVERY_VARIANT = { pending: "warning-light", delivered: "success-light", dead: "destructive-light" } as const;

/** The secret of a rotation is handed up to the page, which shows it once. */
function RotateDialog({ endpointId, onSecret }: { endpointId: string; onSecret: (secret: string) => void }) {
  const { t } = useI18n();
  const { pending, run } = useAction();
  const [open, setOpen] = useState(false);
  const [hours, setHours] = useState("24");
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm" variant="outline" />}>
        <IconRefresh /> {t("webhooks.rotate")}
      </DialogTrigger>
      <DialogContent>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            run(() => rotateWebhookSecret({ endpointId, graceHours: Number(hours) }), {
              success: t("webhooks.secretRotatedToast"),
              onSuccess: (result) => {
                setOpen(false);
                onSecret((result as { data: { secret: string } }).data.secret);
              },
            });
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("webhooks.rotateTitle")}</DialogTitle>
            <DialogDescription>{t("webhooks.rotateDescription")}</DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor={`grace-${endpointId}`}>{t("webhooks.graceHours")}</FieldLabel>
            <Input id={`grace-${endpointId}`} type="number" min={0} max={168} step={1} value={hours} onChange={(event) => setHours(event.target.value)} required />
            <FieldDescription>{t("webhooks.graceHint")}</FieldDescription>
          </Field>
          <DialogFooter>
            <Button type="submit" disabled={pending || hours === ""}>
              {t("webhooks.rotateConfirm")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function WebhookCard({ endpoint, readOnly, onSecret }: { endpoint: WebhookEndpointRow; readOnly: boolean; onSecret: (secret: string) => void }) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const { pending, run } = useAction();
  const disabled = endpoint.status === "disabled";
  const refresh = () => router.refresh();

  return (
    <article className="flex min-w-0 flex-col gap-4 rounded-xl border bg-card p-4" aria-label={endpoint.description ?? endpoint.id}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-heading text-base font-semibold">{endpoint.description ?? new URL(endpoint.url).host}</h3>
            <Badge variant={disabled ? "warning-light" : "success-light"}>{t(disabled ? "webhooks.disabled" : "webhooks.enabled")}</Badge>
            {endpoint.pending > 0 && <Badge variant="outline">{t("webhooks.pending", { count: endpoint.pending })}</Badge>}
            {endpoint.dead > 0 && <Badge variant="destructive-light">{t("webhooks.dead", { count: endpoint.dead })}</Badge>}
          </div>
          <code className="break-all text-xs text-muted-foreground">{endpoint.url}</code>
          <code className="text-xs text-muted-foreground">{endpoint.id}</code>
        </div>
        {!readOnly && (
          <div className="flex flex-wrap items-center gap-2">
            <RotateDialog endpointId={endpoint.id} onSecret={onSecret} />
            <WebhookFormDialog endpoint={endpoint} />
            {disabled ? (
              <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => setWebhookEnabled({ endpointId: endpoint.id, enabled: true }), { success: t("webhooks.enabledToast"), onSuccess: refresh })}>
                <IconPlayerPlay /> {t("webhooks.enable")}
              </Button>
            ) : (
              <ConfirmDialog
                trigger={
                  <Button size="sm" variant="outline">
                    <IconPlayerPause /> {t("webhooks.disable")}
                  </Button>
                }
                title={t("webhooks.disableTitle")}
                description={t("webhooks.disableDescription")}
                confirmLabel={t("webhooks.disable")}
                pending={pending}
                onConfirm={() => run(() => setWebhookEnabled({ endpointId: endpoint.id, enabled: false }), { success: t("webhooks.disabledToast"), onSuccess: refresh })}
              />
            )}
            <ConfirmDialog
              trigger={
                <Button size="icon-sm" variant="ghost" aria-label={t("webhooks.delete")}>
                  <IconTrash />
                </Button>
              }
              title={t("webhooks.deleteTitle")}
              description={t("webhooks.deleteDescription")}
              confirmLabel={t("webhooks.delete")}
              pending={pending}
              onConfirm={() => run(() => deleteWebhook({ endpointId: endpoint.id }), { success: t("webhooks.deletedToast"), onSuccess: refresh })}
            />
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-1.5" aria-label={t("webhooks.events")}>
        {endpoint.events.map((event) => (
          <Badge key={event} variant="outline">
            {event}
          </Badge>
        ))}
      </div>
      <p className="text-sm text-muted-foreground">
        {endpoint.organizations === "*" ? t("webhooks.everyOrganization") : t("webhooks.organizationsCount", { count: endpoint.organizations.length })}
        {" · "}
        {endpoint.lastSuccessAt ? t("webhooks.lastSuccess", { date: formatDate(endpoint.lastSuccessAt, locale) }) : t("webhooks.neverDelivered")}
        {endpoint.consecutiveFailures > 0 && ` · ${t("webhooks.failures", { count: endpoint.consecutiveFailures })}`}
      </p>
      {disabled && endpoint.disabledReason === "too_many_failures" && <p className="text-sm text-warning">{t("webhooks.disabledBy_too_many_failures")}</p>}

      <div className="flex flex-col gap-2">
        <h4 className="text-sm font-medium">{t("webhooks.deliveries")}</h4>
        {endpoint.recent.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("webhooks.noDeliveries")}</p>
        ) : (
          <ul className="grid gap-1.5">
            {endpoint.recent.map((delivery) => (
              <li key={delivery.id} className="flex flex-wrap items-center gap-2 text-sm">
                <Badge variant={DELIVERY_VARIANT[delivery.status]}>{t(`webhooks.delivery_${delivery.status}`)}</Badge>
                <code className="text-xs">{delivery.eventType}</code>
                <span className="text-xs text-muted-foreground">
                  {formatDate(delivery.createdAt, locale)} · {t("webhooks.attempt", { count: delivery.attempts })}
                  {delivery.lastHttpStatus !== undefined && ` · HTTP ${delivery.lastHttpStatus}`}
                  {delivery.lastError && ` · ${delivery.lastError}`}
                </span>
                {!readOnly && delivery.status === "dead" && (
                  <Button size="xs" variant="outline" disabled={pending} onClick={() => run(() => requeueWebhookDelivery({ deliveryId: delivery.id }), { success: t("webhooks.requeuedToast"), onSuccess: refresh })}>
                    <IconRepeat /> {t("webhooks.requeue")}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </article>
  );
}
