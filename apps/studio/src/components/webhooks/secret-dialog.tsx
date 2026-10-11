"use client";

import { CopyButton } from "@/components/shared/copy-button";
import { Alert, AlertDescription, AlertTitle } from "@/components/reui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useI18n } from "@/i18n/client";

/**
 * Shows a signing secret once. It lives only in the state of whoever opened this dialog: closing drops it, and it is never put in the URL,
 * the page data or storage. Nothing can show it again, by design (no read returns a secret).
 */
export function SecretDialog({ secret, onClose }: { secret: string | null; onClose: () => void }) {
  const { t } = useI18n();
  return (
    <Dialog open={secret !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("webhooks.secretCreatedTitle")}</DialogTitle>
          <DialogDescription>{t("webhooks.secretShownOnce")}</DialogDescription>
        </DialogHeader>
        {secret !== null && (
          <div className="grid gap-3">
            <div className="flex items-center gap-2 rounded-lg border bg-muted/40 p-2">
              <code data-testid="new-webhook-secret" className="min-w-0 flex-1 break-all text-xs">
                {secret}
              </code>
              <CopyButton value={secret} label={t("common.copy")} />
            </div>
            <Alert variant="warning">
              <AlertTitle>{t("webhooks.secretWarningTitle")}</AlertTitle>
              <AlertDescription>{t("webhooks.secretWarning")}</AlertDescription>
            </Alert>
            <DialogFooter>
              <Button onClick={onClose}>{t("webhooks.secretSaved")}</Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
