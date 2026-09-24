"use client";

import { IconPlugConnectedX } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/client";
import { rich } from "@/i18n/rich";

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const { t } = useI18n();
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-4 px-6 text-center">
      <IconPlugConnectedX className="size-10 text-muted-foreground" />
      <h1 className="font-heading text-xl font-semibold">{t("error.title")}</h1>
      <p className="text-sm text-muted-foreground">
        {rich(t("error.description"), { command: <code>npx uniora check</code> })}
      </p>
      <Button onClick={reset}>{t("error.tryAgain")}</Button>
    </main>
  );
}
