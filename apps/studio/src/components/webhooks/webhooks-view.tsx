"use client";

import { IconArrowRight, IconWebhook } from "@tabler/icons-react";
import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { PageHeader } from "@/components/shell/page-header";
import { useI18n } from "@/i18n/client";
import type { WebhooksPage } from "@/lib/types";
import { SecretDialog } from "./secret-dialog";
import { WebhookCard } from "./webhook-card";
import { WebhookFormDialog } from "./webhook-form-dialog";

/** The page's client half: it owns the one secret that may be on screen (after a creation or a rotation) and drops it on close. */
export function WebhooksView({ page, readOnly }: { page: WebhooksPage; readOnly: boolean }) {
  const { t } = useI18n();
  const [secret, setSecret] = useState<string | null>(null);

  return (
    <>
      <PageHeader title={t("webhooks.title")} description={t("webhooks.description")} actions={page.available && !readOnly ? <WebhookFormDialog onSecret={setSecret} /> : undefined} />
      <SecretDialog secret={secret} onClose={() => setSecret(null)} />

      {!page.available ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <IconWebhook />
            </EmptyMedia>
            <EmptyTitle>{t("webhooks.unavailableTitle")}</EmptyTitle>
            <EmptyDescription>{t("webhooks.unavailableDescription")}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : page.endpoints.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <IconWebhook />
            </EmptyMedia>
            <EmptyTitle>{t("webhooks.emptyTitle")}</EmptyTitle>
            <EmptyDescription>{t("webhooks.emptyDescription")}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="grid min-w-0 gap-4">
          {page.endpoints.map((endpoint) => (
            <WebhookCard key={endpoint.id} endpoint={endpoint} readOnly={readOnly} onSecret={setSecret} />
          ))}
          {page.nextCursor && (
            <div className="flex justify-center">
              <Button variant="outline" render={<Link href={`/webhooks?${new URLSearchParams({ after: page.nextCursor }).toString()}`} />}>
                {t("members.loadMore")} <IconArrowRight />
              </Button>
            </div>
          )}
        </div>
      )}
      <p className="text-xs text-muted-foreground">{t("webhooks.secretsNote")}</p>
    </>
  );
}
