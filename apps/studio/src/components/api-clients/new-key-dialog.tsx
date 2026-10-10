"use client";

import { IconKey } from "@tabler/icons-react";
import { useState } from "react";
import { createApiKey } from "@/actions/api-clients";
import { CopyButton } from "@/components/shared/copy-button";
import { useAction } from "@/components/shared/use-action";
import { Alert, AlertDescription, AlertTitle } from "@/components/reui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useI18n } from "@/i18n/client";

/**
 * Creates a key and shows it once. The key lives only in this component's state while the dialog is open: closing the
 * dialog drops it, and it is never put in the URL, the page data or storage. Nothing can show it again, by design.
 */
export function NewKeyDialog({ clientId, clientName, disabled }: { clientId: string; clientName: string; disabled?: boolean }) {
  const { t } = useI18n();
  const { pending, run } = useAction();
  const [open, setOpen] = useState(false);
  const [days, setDays] = useState("");
  const [token, setToken] = useState<string | null>(null);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setToken(null);
          setDays("");
        }
      }}
    >
      <DialogTrigger render={<Button size="sm" variant="outline" disabled={disabled} />}>
        <IconKey /> {t("apiClients.newKey")}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("apiClients.newKeyTitle", { name: clientName })}</DialogTitle>
          <DialogDescription>{token ? t("apiClients.keyShownOnce") : t("apiClients.newKeyDescription")}</DialogDescription>
        </DialogHeader>
        {token ? (
          <div className="grid gap-3">
            <div className="flex items-center gap-2 rounded-lg border bg-muted/40 p-2">
              <code data-testid="new-api-key" className="min-w-0 flex-1 break-all text-xs">
                {token}
              </code>
              <CopyButton value={token} label={t("common.copy")} />
            </div>
            <Alert variant="warning">
              <AlertTitle>{t("apiClients.keyWarningTitle")}</AlertTitle>
              <AlertDescription>{t("apiClients.keyWarning")}</AlertDescription>
            </Alert>
            <DialogFooter>
              <Button onClick={() => setOpen(false)}>{t("apiClients.keySaved")}</Button>
            </DialogFooter>
          </div>
        ) : (
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              run(() => createApiKey({ clientId, ...(days !== "" ? { expiresInDays: Number(days) } : {}) }), {
                success: t("apiClients.keyCreatedToast"),
                onSuccess: (result) => setToken((result as { data: { token: string } }).data.token),
              });
            }}
          >
            <Field>
              <FieldLabel htmlFor={`days-${clientId}`}>{t("apiClients.expiresInDays")}</FieldLabel>
              <Input id={`days-${clientId}`} type="number" min={1} max={1825} step={1} value={days} onChange={(event) => setDays(event.target.value)} placeholder="90" />
              <FieldDescription>{t("apiClients.expiresHint")}</FieldDescription>
            </Field>
            <DialogFooter>
              <Button type="submit" disabled={pending}>
                {t("apiClients.createKey")}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
